use crate::app_error::AppError;
use crate::models::community::{
    create_community, find_community_by_id, get_own_communities, get_public_communities,
    CommunityDraft,
};
use crate::models::post::{find_published_posts_by_community_id, get_draft_post_count};
use crate::models::user::AuthSession;
use crate::web::state::AppState;
use axum::extract::Path;
use axum::response::{IntoResponse, Redirect};
use axum::{extract::State, http::StatusCode, response::Html, Form};
use axum_messages::Messages;
use data_encoding::BASE64URL_NOPAD;
use minijinja::context;
use serde::Deserialize;
use std::collections::HashMap;
use uuid::Uuid;

pub async fn community(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let uuid = Uuid::from_slice(BASE64URL_NOPAD.decode(id.as_bytes()).unwrap().as_slice())?;
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let community = find_community_by_id(&mut tx, uuid).await?;

    if community.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let posts = find_published_posts_by_community_id(&mut tx, uuid).await?;
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let template: minijinja::Template<'_, '_> = state.env.get_template("community.html")?;
    let rendered = template.render(context! {
        community => community,
        encoded_community_id => BASE64URL_NOPAD.encode(uuid.as_bytes()),
        current_user => auth_session.user,
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
        draft_post_count,
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn communities(
    auth_session: AuthSession,
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
            let link = format!(
                "/communities/{}",
                BASE64URL_NOPAD.encode(community.id.as_bytes())
            );
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
            let link = format!(
                "/communities/{}",
                BASE64URL_NOPAD.encode(community.id.as_bytes())
            );
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

    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let template: minijinja::Template<'_, '_> = state.env.get_template("communities.html")?;
    let rendered = template.clone().render(context! {
        title => "홈",
        current_user => auth_session.user,
        messages => messages.into_iter().collect::<Vec<_>>(),
        draft_post_count,
        public_communities,
        own_communities,
    })?;

    Ok(Html(rendered))
}

#[derive(Deserialize)]
pub struct CreateCommunityForm {
    name: String,
    description: String,
    is_private: Option<String>,
}

pub async fn do_create_community(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Form(form): Form<CreateCommunityForm>,
) -> Result<impl IntoResponse, AppError> {
    let db: sqlx::Pool<sqlx::Postgres> = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let _ = create_community(
        &mut tx,
        auth_session.user.unwrap().id,
        CommunityDraft {
            name: form.name,
            description: form.description,
            is_private: form.is_private == Some("on".to_string()),
        },
    )
    .await;
    let _ = tx.commit().await;

    Ok(Redirect::to("/").into_response())
}

pub async fn create_community_form(
    auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<Html<String>, AppError> {
    let db: sqlx::Pool<sqlx::Postgres> = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let template: minijinja::Template<'_, '_> = state.env.get_template("create_community.html")?;
    let rendered = template.render(context! {
        title => "커뮤니티 생성",
        current_user => auth_session.user,
        draft_post_count,
    })?;

    Ok(Html(rendered))
}
