use super::ExtractAcceptLanguage;
use crate::app_error::AppError;
use crate::models::post::{
    find_following_posts_by_user_id, find_public_community_posts, get_draft_post_count,
};
use crate::models::user::AuthSession;
use crate::web::handlers::{create_base_ftl_context, get_bundle};
use crate::web::state::AppState;
use axum::response::IntoResponse;
use axum::{extract::State, response::Html};
use axum_messages::Messages;
use data_encoding::BASE64URL_NOPAD;
use minijinja::context;
use uuid::Uuid;

pub async fn home(
    auth_session: AuthSession,
    State(state): State<AppState>,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    messages: Messages,
) -> Result<impl IntoResponse, AppError> {
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;

    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);

    let posts = find_public_community_posts(&mut tx).await?;
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let template: minijinja::Template<'_, '_> = state.env.get_template("home.html")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        encoded_default_community_id => BASE64URL_NOPAD.encode(Uuid::parse_str(&state.config.default_community_id).unwrap().as_bytes()),
        messages => messages.into_iter().collect::<Vec<_>>(),
        posts,
        draft_post_count,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn my_timeline(
    auth_session: AuthSession,
    State(state): State<AppState>,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    messages: Messages,
) -> Result<impl IntoResponse, AppError> {
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;

    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);

    let posts =
        find_following_posts_by_user_id(&mut tx, auth_session.user.clone().unwrap().id).await?;
    let draft_post_count = get_draft_post_count(&mut tx, auth_session.user.clone().unwrap().id)
        .await
        .unwrap_or_default();

    let template: minijinja::Template<'_, '_> = state.env.get_template("timeline.html")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        encoded_default_community_id => BASE64URL_NOPAD.encode(Uuid::parse_str(&state.config.default_community_id).unwrap().as_bytes()),
        messages => messages.into_iter().collect::<Vec<_>>(),
        posts,
        draft_post_count,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered).into_response())
}
