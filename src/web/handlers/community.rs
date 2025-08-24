use crate::app_error::AppError;
use crate::models::actor::create_actor_for_community;
use crate::models::comment::find_latest_comments_in_community;
use crate::models::community::{
    create_community, find_community_by_id, get_own_communities, get_participating_communities,
    get_public_communities, update_community, CommunityDraft,
};
use crate::models::post::{find_published_posts_by_community_id, get_draft_post_count};
use crate::models::user::AuthSession;
use crate::web::handlers::{create_base_ftl_context, parse_id_with_legacy_support, ParsedId};
use crate::web::state::AppState;
use axum::extract::Path;
use axum::http::{HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Redirect};
use axum::{extract::State, http::StatusCode, response::Html, Form};
use axum_messages::Messages;
use minijinja::context;
use serde::Deserialize;
use std::collections::HashMap;
use uuid::Uuid;

use super::{get_bundle, ExtractAcceptLanguage};

pub async fn community(
    auth_session: AuthSession,
    headers: HeaderMap,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let uuid = match parse_id_with_legacy_support(&id, "/communities", &state)? {
        ParsedId::Uuid(uuid) => uuid,
        ParsedId::Redirect(redirect) => return Ok(redirect.into_response()),
        ParsedId::InvalidId(error_response) => return Ok(error_response),
    };
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let community = find_community_by_id(&mut tx, uuid).await?;

    if community.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let posts = find_published_posts_by_community_id(&mut tx, uuid).await?;
    let comments = find_latest_comments_in_community(&mut tx, uuid, 5).await?;
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let template: minijinja::Template<'_, '_> = state.env.get_template("community.jinja").unwrap();
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);

    if headers.get("HX-Request") == Some(&HeaderValue::from_static("true")) {
        let rendered = template
            .eval_to_state(context! {
                current_user => auth_session.user,
                community => {
                    community.as_ref()
                },
                community_id => id,
                ..create_base_ftl_context(&bundle)
            })?
            .render_block("community_edit_block")
            .unwrap();
        Ok(Html(rendered).into_response())
    } else {
        let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        community => community,
        community_id => uuid.to_string(),
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        comments => comments.iter().map(
            |comment| {
                HashMap::<String, String>::from_iter(vec![
                    ("id".to_string(), comment.id.to_string().to_string()),
                    ("user_login_name".to_string(), comment.user_login_name.clone().to_string()),
                    ("user_display_name".to_string(), comment.user_display_name.clone().to_string()),
                    ("post_title".to_string(), comment.post_title.clone().unwrap_or_default().to_string()),
                    ("post_id".to_string(), comment.post_id.to_string().to_string()),
                    ("created_at".to_string(), comment.created_at.to_string()),
                    ("content".to_string(), comment.content.clone().to_string()),
                ])
            }
        ).collect::<Vec<_>>(),
        posts => posts.iter().map(|post| {
            HashMap::<String, String>::from_iter(vec![
                ("id".to_string(), post.id.to_string()),
                ("title".to_string(), post.title.clone().unwrap_or_default().to_string()),
                ("author_id".to_string(), post.author_id.to_string()),
                ("image_filename".to_string(), post.image_filename.to_string()),
                ("image_width".to_string(), post.image_width.to_string()),
                ("image_height".to_string(), post.image_height.to_string()),
                ("replay_filename".to_string(), post.replay_filename.to_string()),
                ("created_at".to_string(), post.created_at.to_string()),
                ("updated_at".to_string(), post.updated_at.to_string()),
                ])
            }).collect::<Vec<_>>(),
            draft_post_count,
            ..create_base_ftl_context(&bundle),
    })?;
        Ok(Html(rendered).into_response())
    }
}

pub async fn community_iframe(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let uuid = match parse_id_with_legacy_support(&id, "/communities", &state)? {
        ParsedId::Uuid(uuid) => uuid,
        ParsedId::Redirect(redirect) => return Ok(redirect.into_response()),
        ParsedId::InvalidId(error_response) => return Ok(error_response),
    };
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let community = find_community_by_id(&mut tx, uuid).await?;

    if community.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let posts = find_published_posts_by_community_id(&mut tx, uuid).await?;

    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let template: minijinja::Template<'_, '_> = state.env.get_template("community_iframe.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        community => community,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        posts => posts.iter().map(|post| {
            HashMap::<String, String>::from_iter(vec![
                ("id".to_string(), post.id.to_string()),
                ("title".to_string(), post.title.clone().unwrap_or_default().to_string()),
                ("author_id".to_string(), post.author_id.to_string()),
                ("image_filename".to_string(), post.image_filename.to_string()),
                ("image_width".to_string(), post.image_width.to_string()),
                ("image_height".to_string(), post.image_height.to_string()),
                ("replay_filename".to_string(), post.replay_filename.to_string()),
                ("created_at".to_string(), post.created_at.to_string()),
                ("updated_at".to_string(), post.updated_at.to_string()),
            ])
        }).collect::<Vec<_>>(),
        ..create_base_ftl_context(&bundle),
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn communities(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    messages: Messages,
) -> Result<Html<String>, AppError> {
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;

    let own_communities = match auth_session.user.clone() {
        Some(user) => get_own_communities(&mut tx, user.id).await?,
        None => vec![],
    };

    let own_communities = own_communities
        .iter()
        .map(|community| {
            let name = community.name.clone();
            let description = community.description.clone();
            let is_private = community.is_private;
            let updated_at = community.updated_at.to_string();
            let created_at = community.created_at.to_string();
            let link = format!("/communities/{}", community.id);
            HashMap::<String, String>::from_iter(vec![
                ("name".to_string(), name),
                ("description".to_string(), description),
                ("is_private".to_string(), is_private.to_string()),
                ("updated_at".to_string(), updated_at),
                ("created_at".to_string(), created_at),
                ("link".to_string(), link),
            ])
        })
        .collect::<Vec<_>>();

    let public_communities = get_public_communities(&mut tx)
        .await?
        .iter()
        .map(|community| {
            let name = community.name.clone();
            let description = community.description.clone();
            let is_private = community.is_private;
            let updated_at = community.updated_at.to_string();
            let created_at = community.created_at.to_string();
            let link = format!("/communities/{}", community.id);
            HashMap::<String, String>::from_iter(vec![
                ("name".to_string(), name),
                (
                    "owner_login_name".to_string(),
                    community.owner_login_name.clone(),
                ),
                ("description".to_string(), description),
                ("is_private".to_string(), is_private.to_string()),
                ("updated_at".to_string(), updated_at),
                ("created_at".to_string(), created_at),
                ("link".to_string(), link),
            ])
        })
        .collect::<Vec<_>>();

    let official_communities = public_communities
        .iter()
        .filter(|c| c["owner_login_name"] == state.config.official_account_login_name)
        .cloned()
        .collect::<Vec<_>>();

    let participating_communities = match auth_session.user.clone() {
        Some(user) => get_participating_communities(&mut tx, user.id)
            .await?
            .iter()
            .map(|community| {
                let name = community.name.clone();
                let description = community.description.clone();
                let is_private = community.is_private;
                let updated_at = community.updated_at.to_string();
                let created_at = community.created_at.to_string();
                let link = format!("/communities/{}", community.id);
                HashMap::<String, String>::from_iter(vec![
                    ("name".to_string(), name),
                    ("description".to_string(), description),
                    ("is_private".to_string(), is_private.to_string()),
                    ("updated_at".to_string(), updated_at),
                    ("created_at".to_string(), created_at),
                    ("link".to_string(), link),
                ])
            })
            .collect::<Vec<_>>(),
        None => vec![],
    };

    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let template: minijinja::Template<'_, '_> = state.env.get_template("communities.jinja")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.clone().render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        messages => messages.into_iter().collect::<Vec<_>>(),
        draft_post_count,
        official_communities,
        public_communities,
        participating_communities,
        own_communities,
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered))
}

#[derive(Deserialize)]
pub struct CreateCommunityForm {
    name: String,
    slug: String,
    description: String,
    is_private: Option<String>,
}

pub async fn do_create_community(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    messages: Messages,
    Form(form): Form<CreateCommunityForm>,
) -> Result<impl IntoResponse, AppError> {
    if form.name.is_empty() {
        return Ok(StatusCode::BAD_REQUEST.into_response());
    }

    let db: sqlx::Pool<sqlx::Postgres> = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let community = create_community(
        &mut tx,
        auth_session.user.clone().unwrap().id,
        CommunityDraft {
            name: form.name,
            slug: form.slug,
            description: form.description,
            is_private: form.is_private == Some("on".to_string()),
        },
    )
    .await?;

    // Create actor for the community
    match create_actor_for_community(&mut tx, &community, &state.config).await {
        Ok(_) => {
            let _ = tx.commit().await;
            Ok(Redirect::to(&format!("/communities/{}", community.id)).into_response())
        }
        Err(e) => {
            let _ = tx.rollback().await;
            // Check if it's a unique constraint violation (handle conflict)
            if let Some(db_error) = e.downcast_ref::<sqlx::Error>() {
                if let sqlx::Error::Database(db_err) = db_error {
                    if db_err.constraint().is_some() {
                        let user_preferred_language = auth_session
                            .user
                            .clone()
                            .map(|u| u.preferred_language)
                            .unwrap_or_else(|| None);
                        let bundle = get_bundle(&accept_language, user_preferred_language);
                        let error_message = bundle.format_pattern(
                            bundle
                                .get_message("community-slug-conflict-error")
                                .unwrap()
                                .value()
                                .unwrap(),
                            None,
                            &mut vec![],
                        );
                        messages.error(&error_message.to_string());
                        return Ok(Redirect::to("/communities/new").into_response());
                    }
                }
            }
            // For other errors, re-throw
            Err(e.into())
        }
    }
}

pub async fn create_community_form(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    messages: Messages,
) -> Result<Html<String>, AppError> {
    let db: sqlx::Pool<sqlx::Postgres> = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let template: minijinja::Template<'_, '_> = state.env.get_template("create_community.jinja")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        messages => messages.into_iter().collect::<Vec<_>>(),
        draft_post_count,
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered))
}

pub async fn hx_edit_community(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let community_uuid = Uuid::parse_str(&id)?;

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let community = find_community_by_id(&mut tx, community_uuid).await?;

    if community.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    if community.clone().unwrap().owner_id != auth_session.user.clone().unwrap().id {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let template: minijinja::Template<'_, '_> = state.env.get_template("community_edit.jinja")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        current_user => auth_session.user,
        community,
        community_id => id,
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn hx_do_edit_community(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Form(form): Form<CreateCommunityForm>,
) -> Result<impl IntoResponse, AppError> {
    if form.name.is_empty() {
        return Ok(StatusCode::BAD_REQUEST.into_response());
    }

    let community_uuid = Uuid::parse_str(&id)?;

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let updated_community = update_community(
        &mut tx,
        community_uuid,
        CommunityDraft {
            name: form.name,
            slug: form.slug,
            description: form.description,
            is_private: form.is_private == Some("on".to_string()),
        },
        Some(&state.config), // Pass config to also update the community actor
    )
    .await?;
    let _ = tx.commit().await;

    let template = state.env.get_template("community.jinja")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template
        .eval_to_state(context! {
            current_user => auth_session.user,
            community => updated_community,
            community_id => id,
            ..create_base_ftl_context(&bundle)
        })?
        .render_block("community_edit_block")?;

    Ok(Html(rendered).into_response())
}
