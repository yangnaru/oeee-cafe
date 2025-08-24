use crate::app_error::AppError;
use crate::models::comment::{create_comment, find_comments_by_post_id, CommentDraft};
use crate::models::community::{find_community_by_id, get_known_communities};
use crate::models::image::find_image_by_id;
use crate::models::post::{
    delete_post, edit_post, edit_post_community, find_draft_posts_by_author_id, find_post_by_id,
    get_draft_post_count, increment_post_viewer_count, publish_post,
};
use crate::models::user::AuthSession;
use crate::web::handlers::{
    create_base_ftl_context, get_bundle, parse_id_with_legacy_support, ParsedId,
};
use crate::web::state::AppState;
use anyhow::Error;
use aws_sdk_s3::config::{Credentials as AwsCredentials, Region, SharedCredentialsProvider};
use aws_sdk_s3::types::{Delete, ObjectIdentifier};
use aws_sdk_s3::Client;
use axum::extract::Path;
use axum::http::{HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Redirect};
use axum::{extract::State, http::StatusCode, response::Html, Form};
use minijinja::context;
use serde::Deserialize;
use uuid::Uuid;

use super::{handler_404, ExtractAcceptLanguage};

pub async fn post_relay_view(
    auth_session: AuthSession,
    State(state): State<AppState>,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let uuid = match parse_id_with_legacy_support(&id, "/posts", &state)? {
        ParsedId::Uuid(uuid) => uuid,
        ParsedId::Redirect(redirect) => return Ok(redirect.into_response()),
        ParsedId::InvalidId(error_response) => return Ok(error_response),
    };
    let db = state.config.connect_database().await.unwrap();
    let mut tx: sqlx::Transaction<'_, sqlx::Postgres> = db.begin().await.unwrap();
    let post = find_post_by_id(&mut tx, uuid).await.unwrap();

    if post.is_none() {
        return Ok((
            StatusCode::NOT_FOUND,
            handler_404(
                auth_session,
                ExtractAcceptLanguage(accept_language),
                State(state),
            )
            .await?,
        )
            .into_response());
    }

    let template: minijinja::Template<'_, '_> =
        state.env.get_template("draw_post_neo.jinja").unwrap();
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let community_id = Uuid::parse_str(
        post.clone()
            .unwrap()
            .get("community_id")
            .unwrap()
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    let community = find_community_by_id(&mut tx, community_id).await?.unwrap();
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        parent_post => post.clone().unwrap(),
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        community_name => community.name,
        width => post.clone().unwrap().get("image_width").unwrap().as_ref().unwrap().parse::<u32>()?,
        height => post.unwrap().get("image_height").unwrap().as_ref().unwrap().parse::<u32>()?,
        background_color => community.background_color,
        foreground_color => community.foreground_color,
        community_id => community_id.to_string(),
        draft_post_count,
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn post_view(
    auth_session: AuthSession,
    headers: HeaderMap,
    State(state): State<AppState>,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let uuid = match parse_id_with_legacy_support(&id, "/posts", &state)? {
        ParsedId::Uuid(uuid) => uuid,
        ParsedId::Redirect(redirect) => return Ok(redirect.into_response()),
        ParsedId::InvalidId(error_response) => return Ok(error_response),
    };
    let db = state.config.connect_database().await.unwrap();
    let mut tx: sqlx::Transaction<'_, sqlx::Postgres> = db.begin().await.unwrap();
    let post = find_post_by_id(&mut tx, uuid).await.unwrap();

    match post {
        Some(_) => {
            increment_post_viewer_count(&mut tx, uuid).await.unwrap();
        }
        None => {
            return Ok((
                StatusCode::NOT_FOUND,
                handler_404(
                    auth_session,
                    ExtractAcceptLanguage(accept_language),
                    State(state),
                )
                .await?,
            )
                .into_response());
        }
    }

    let comments = find_comments_by_post_id(&mut tx, uuid).await.unwrap();

    let community_id = Uuid::parse_str(
        post.clone()
            .as_ref()
            .unwrap()
            .get("community_id")
            .unwrap()
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };
    tx.commit().await?;

    let community_id = community_id.to_string();

    let template: minijinja::Template<'_, '_> = state.env.get_template("post_view.jinja").unwrap();
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
                post => {
                    post.as_ref()
                },
                post_id => id,
                ..create_base_ftl_context(&bundle)
            })?
            .render_block("post_edit_block")
            .unwrap();
        Ok(Html(rendered).into_response())
    } else {
        let rendered = template
            .render(context! {
                current_user => auth_session.user,
                default_community_id => state.config.default_community_id.clone(),
                r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
                post => {
                    post.as_ref()
                },
                parent_post_id => post.clone().unwrap().get("parent_post_id")
                    .and_then(|id| id.as_ref())
                    .and_then(|id| Uuid::parse_str(id).ok())
                    .map(|uuid| uuid.to_string())
                    .unwrap_or_default(),
                post_id => post.unwrap().get("id").unwrap().as_ref().unwrap().clone(),
                community_id,
                draft_post_count,
                base_url => state.config.base_url.clone(),
                comments,
                ..create_base_ftl_context(&bundle)
            })
            .unwrap();
        Ok(Html(rendered).into_response())
    }
}

pub async fn post_replay_view(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let uuid = match parse_id_with_legacy_support(&id, "/posts", &state)? {
        ParsedId::Uuid(uuid) => uuid,
        ParsedId::Redirect(redirect) => return Ok(redirect.into_response()),
        ParsedId::InvalidId(error_response) => return Ok(error_response),
    };
    let db = state.config.connect_database().await.unwrap();
    let mut tx: sqlx::Transaction<'_, sqlx::Postgres> = db.begin().await.unwrap();
    let post = find_post_by_id(&mut tx, uuid).await.unwrap();
    if post.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let community_id = Uuid::parse_str(
        post.clone()
            .as_ref()
            .unwrap()
            .get("community_id")
            .unwrap()
            .as_ref()
            .unwrap(),
    )
    .unwrap();

    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };
    let community_id = community_id.to_string();

    let template_filename = match post.clone().unwrap().get("replay_filename") {
        Some(replay_filename) => {
            let replay_filename = replay_filename.as_ref().unwrap();
            if replay_filename.ends_with(".pch") {
                "post_replay_view_pch.jinja"
            } else if replay_filename.ends_with(".tgkr") {
                "post_replay_view_tgkr.jinja"
            } else {
                "post_replay_view_pch.jinja"
            }
        }
        None => "post_replay_view_pch.jinja",
    };

    let template: minijinja::Template<'_, '_> = state.env.get_template(template_filename).unwrap();
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template
        .render(context! {
            current_user => auth_session.user,
            default_community_id => state.config.default_community_id.clone(),
            r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
            post => {
                post.as_ref()
            },
            post_id => post.unwrap().get("id").unwrap().as_ref().unwrap().clone(),
            community_id,
            draft_post_count,
            ..create_base_ftl_context(&bundle),
        })
        .unwrap();
    Ok(Html(rendered).into_response())
}

pub async fn post_publish_form(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let post_uuid = Uuid::parse_str(&id)?;

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let post = find_post_by_id(&mut tx, post_uuid).await?;

    if post.is_none() {
        return Ok((
            StatusCode::NOT_FOUND,
            handler_404(
                auth_session,
                ExtractAcceptLanguage(accept_language),
                State(state),
            )
            .await?,
        )
            .into_response());
    }

    if *post
        .clone()
        .unwrap()
        .get("author_id")
        .unwrap()
        .as_ref()
        .unwrap()
        != auth_session.user.clone().unwrap().id.to_string()
    {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let published_at = post.clone().unwrap().get("published_at").unwrap().clone();
    if published_at.is_some() {
        return Ok(Redirect::to(&format!("/posts/{}", id)).into_response());
    }

    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let community_id = Uuid::parse_str(
        post.clone()
            .unwrap()
            .get("community_id")
            .unwrap()
            .as_ref()
            .unwrap(),
    )?;
    let link = format!("/communities/{}", community_id);

    let template: minijinja::Template<'_, '_> = state.env.get_template("post_form.jinja")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        post_id => id,
        link,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        post => {
            post
        },
        draft_post_count,
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct PostPublishForm {
    post_id: String,
    title: String,
    content: String,
    is_sensitive: Option<String>,
    allow_relay: Option<String>,
}

pub async fn post_publish(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Form(form): Form<PostPublishForm>,
) -> Result<impl IntoResponse, AppError> {
    let post_id = Uuid::parse_str(&form.post_id)?;

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let post = find_post_by_id(&mut tx, post_id).await?;
    if post.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let author_id = Uuid::parse_str(
        post.clone()
            .unwrap()
            .clone()
            .get("author_id")
            .unwrap()
            .as_ref()
            .unwrap(),
    )?;
    let user_id = auth_session.user.unwrap().id;
    if author_id != user_id {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let is_sensitive = form.is_sensitive == Some("on".to_string());
    let allow_relay = form.allow_relay == Some("on".to_string());
    let _ = publish_post(
        &mut tx,
        post_id,
        form.title,
        form.content,
        is_sensitive,
        allow_relay,
    )
    .await;
    let _ = tx.commit().await;

    let community_id = Uuid::parse_str(
        &post
            .clone()
            .unwrap()
            .get("community_id")
            .unwrap()
            .clone()
            .unwrap(),
    )?;
    let community_id = community_id.to_string();
    Ok(Redirect::to(&format!("/communities/{}", community_id)).into_response())
}

pub async fn draft_posts(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
) -> Result<Html<String>, AppError> {
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };
    let posts =
        find_draft_posts_by_author_id(&mut tx, auth_session.user.clone().unwrap().id).await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("draft_posts.jinja")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        posts => posts,
        draft_post_count,
        ..create_base_ftl_context(&bundle),
    })?;

    Ok(Html(rendered))
}

#[derive(Deserialize)]
pub struct CreateCommentForm {
    pub post_id: String,
    pub content: String,
}

pub async fn do_create_comment(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Form(form): Form<CreateCommentForm>,
) -> Result<impl IntoResponse, AppError> {
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let user_id = auth_session.user.unwrap().id;
    let post_id = Uuid::parse_str(&form.post_id).unwrap();
    let _ = create_comment(
        &mut tx,
        CommentDraft {
            user_id,
            post_id,
            content: form.content,
        },
    )
    .await;
    let comments = find_comments_by_post_id(&mut tx, post_id).await?;
    let _ = tx.commit().await;

    let template: minijinja::Template<'_, '_> = state.env.get_template("post_comments.jinja")?;
    let rendered = template.render(context! {
        comments => comments,
        ..create_base_ftl_context(&bundle)
    })?;
    Ok(Html(rendered).into_response())
}

pub async fn post_edit_community(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let post_uuid = Uuid::parse_str(&id)?;

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let post = find_post_by_id(&mut tx, post_uuid).await?;
    if post.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    if *post
        .clone()
        .unwrap()
        .get("author_id")
        .unwrap()
        .as_ref()
        .unwrap()
        != auth_session.user.clone().unwrap().id.to_string()
    {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let known_communities =
        get_known_communities(&mut tx, auth_session.user.clone().unwrap().id).await?;
    let filtered_known_communities = known_communities
        .iter()
        .filter(|c| {
            c.id != Uuid::parse_str(
                post.clone()
                    .unwrap()
                    .get("community_id")
                    .unwrap()
                    .as_ref()
                    .unwrap(),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    let known_communities_with_community_id = filtered_known_communities
        .iter()
        .map(|c| {
            let community_id = c.id.to_string();
            (c, community_id)
        })
        .collect::<Vec<_>>();

    let template: minijinja::Template<'_, '_> =
        state.env.get_template("post_edit_community.jinja")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        post,
        post_id => id,
        known_communities_with_community_id,
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct EditPostCommunityForm {
    pub community_id: Uuid,
}

pub async fn do_post_edit_community(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Form(form): Form<EditPostCommunityForm>,
) -> Result<impl IntoResponse, AppError> {
    let post_uuid = Uuid::parse_str(&id)?;

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let post = find_post_by_id(&mut tx, post_uuid).await?;
    if post.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    if *post
        .clone()
        .unwrap()
        .get("author_id")
        .unwrap()
        .as_ref()
        .unwrap()
        != auth_session.user.clone().unwrap().id.to_string()
    {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let _ = edit_post_community(&mut tx, post_uuid, form.community_id).await;
    let _ = tx.commit().await;

    Ok(Redirect::to(&format!("/posts/{}", id)).into_response())
}

pub async fn hx_edit_post(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let post_uuid = Uuid::parse_str(&id)?;

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let post = find_post_by_id(&mut tx, post_uuid).await?;

    if post.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    if *post
        .clone()
        .unwrap()
        .get("author_id")
        .unwrap()
        .as_ref()
        .unwrap()
        != auth_session.user.clone().unwrap().id.to_string()
    {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let template: minijinja::Template<'_, '_> = state.env.get_template("post_edit.jinja")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        post,
        post_id => id,
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct EditPostForm {
    pub title: String,
    pub content: String,
    pub is_sensitive: Option<String>,
    pub allow_relay: Option<String>,
}

pub async fn hx_do_edit_post(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Form(form): Form<EditPostForm>,
) -> Result<impl IntoResponse, AppError> {
    let post_uuid = Uuid::parse_str(&id)?;

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let post = find_post_by_id(&mut tx, post_uuid).await?;
    if post.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    if *post
        .clone()
        .unwrap()
        .get("author_id")
        .unwrap()
        .as_ref()
        .unwrap()
        != auth_session.user.clone().unwrap().id.to_string()
    {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let _ = edit_post(
        &mut tx,
        post_uuid,
        form.title,
        form.content,
        form.is_sensitive == Some("on".to_string()),
        form.allow_relay == Some("on".to_string()),
    )
    .await;
    let post = find_post_by_id(&mut tx, post_uuid).await?;
    let _ = tx.commit().await;

    let template: minijinja::Template<'_, '_> = state.env.get_template("post_view.jinja")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template
        .eval_to_state(context! {
            current_user => auth_session.user,
            default_community_id => state.config.default_community_id.clone(),
            post,
            post_id => id,
            ..create_base_ftl_context(&bundle)
        })?
        .render_block("post_edit_block")?;

    Ok(Html(rendered).into_response())
}

pub async fn hx_delete_post(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let post_uuid = Uuid::parse_str(&id)?;

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let post = find_post_by_id(&mut tx, post_uuid).await?;
    if post.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    if *post
        .clone()
        .unwrap()
        .get("author_id")
        .unwrap()
        .as_ref()
        .unwrap()
        != auth_session.user.clone().unwrap().id.to_string()
    {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let image_id = Uuid::parse_str(
        &post
            .clone()
            .unwrap()
            .get("image_id")
            .unwrap()
            .clone()
            .unwrap(),
    )
    .unwrap();
    let image = find_image_by_id(&mut tx, image_id).await?;

    let keys = [
        format!(
            "replay/{}{}/{}",
            image.replay_filename.chars().next().unwrap(),
            image.replay_filename.chars().nth(1).unwrap(),
            image.replay_filename
        ),
        format!(
            "image/{}{}/{}",
            image.image_filename.chars().next().unwrap(),
            image.image_filename.chars().nth(1).unwrap(),
            image.image_filename
        ),
    ];

    let credentials: AwsCredentials = AwsCredentials::new(
        state.config.aws_access_key_id.clone(),
        state.config.aws_secret_access_key.clone(),
        None,
        None,
        "",
    );
    let credentials_provider = SharedCredentialsProvider::new(credentials);
    let config = aws_sdk_s3::Config::builder()
        .endpoint_url(state.config.r2_endpoint_url.clone())
        .region(Region::new(state.config.aws_region.clone()))
        .credentials_provider(credentials_provider)
        .behavior_version_latest()
        .build();
    let client = Client::from_conf(config);
    client
        .delete_objects()
        .bucket(state.config.aws_s3_bucket)
        .delete(
            Delete::builder()
                .set_objects(Some(
                    keys.iter()
                        .map(|key| ObjectIdentifier::builder().key(key).build().unwrap())
                        .collect::<Vec<_>>(),
                ))
                .build()
                .map_err(Error::from)?,
        )
        .send()
        .await?;
    delete_post(&mut tx, post_uuid).await?;
    tx.commit().await?;

    let community_id = post.unwrap().get("community_id").unwrap().clone().unwrap();
    let community_id = community_id.clone();
    Ok(([("HX-Redirect", &format!("/communities/{}", community_id))],).into_response())
}

pub async fn post_view_by_login_name(
    auth_session: AuthSession,
    headers: HeaderMap,
    State(state): State<AppState>,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    Path((login_name, post_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let uuid = match parse_id_with_legacy_support(&post_id, &format!("/@{}", login_name), &state)? {
        ParsedId::Uuid(uuid) => uuid,
        ParsedId::Redirect(redirect) => return Ok(redirect.into_response()),
        ParsedId::InvalidId(error_response) => return Ok(error_response),
    };

    let db = state.config.connect_database().await.unwrap();
    let mut tx: sqlx::Transaction<'_, sqlx::Postgres> = db.begin().await.unwrap();
    let post = find_post_by_id(&mut tx, uuid).await.unwrap();

    match post {
        Some(post_data) => {
            let post_login_name = post_data.get("login_name").unwrap().as_ref().unwrap();
            if post_login_name != &login_name {
                return Ok(StatusCode::NOT_FOUND.into_response());
            }
            increment_post_viewer_count(&mut tx, uuid).await.unwrap();
        }
        None => {
            return Ok((
                StatusCode::NOT_FOUND,
                handler_404(
                    auth_session,
                    ExtractAcceptLanguage(accept_language),
                    State(state),
                )
                .await?,
            )
                .into_response());
        }
    }

    let comments = find_comments_by_post_id(&mut tx, uuid).await.unwrap();
    let post = find_post_by_id(&mut tx, uuid).await.unwrap();

    let community_id = Uuid::parse_str(
        post.clone()
            .as_ref()
            .unwrap()
            .get("community_id")
            .unwrap()
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };
    tx.commit().await?;

    let community_id = community_id.to_string();

    let template: minijinja::Template<'_, '_> = state.env.get_template("post_view.jinja").unwrap();
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
                post => {
                    post.as_ref()
                },
                post_id => post_id,
                ..create_base_ftl_context(&bundle)
            })?
            .render_block("post_edit_block")
            .unwrap();
        Ok(Html(rendered).into_response())
    } else {
        let rendered = template
            .render(context! {
                current_user => auth_session.user,
                default_community_id => state.config.default_community_id.clone(),
                r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
                post => {
                    post.as_ref()
                },
                parent_post_id => post.clone().unwrap().get("parent_post_id")
                    .and_then(|id| id.as_ref())
                    .and_then(|id| Uuid::parse_str(id).ok())
                    .map(|uuid| uuid.to_string())
                    .unwrap_or_default(),
                post_id => post.unwrap().get("id").unwrap().as_ref().unwrap().clone(),
                community_id,
                draft_post_count,
                base_url => state.config.base_url.clone(),
                comments,
                ..create_base_ftl_context(&bundle)
            })
            .unwrap();
        Ok(Html(rendered).into_response())
    }
}

pub async fn redirect_post_to_login_name(
    State(state): State<AppState>,
    Path(post_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let uuid = match parse_id_with_legacy_support(&post_id, "/posts", &state)? {
        ParsedId::Uuid(uuid) => uuid,
        ParsedId::Redirect(redirect) => return Ok(redirect.into_response()),
        ParsedId::InvalidId(error_response) => return Ok(error_response),
    };

    let db = state.config.connect_database().await.unwrap();
    let mut tx: sqlx::Transaction<'_, sqlx::Postgres> = db.begin().await.unwrap();
    let post = find_post_by_id(&mut tx, uuid).await.unwrap();
    tx.commit().await?;

    match post {
        Some(post_data) => {
            let login_name = post_data.get("login_name").unwrap().as_ref().unwrap();
            let post_uuid_str = post_data.get("id").unwrap().as_ref().unwrap();
            Ok(Redirect::permanent(&format!("/@{}/{}", login_name, post_uuid_str)).into_response())
        }
        None => Ok(StatusCode::NOT_FOUND.into_response()),
    }
}
