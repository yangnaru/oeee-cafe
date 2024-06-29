use super::{get_bundle, ExtractAcceptLanguage};
use crate::{
    app_error::AppError, models::comment::find_comments_to_posts_by_author,
    web::handlers::create_base_ftl_context,
};
use axum::{
    extract::State,
    response::{Html, IntoResponse},
};
use axum_messages::Messages;
use data_encoding::BASE64URL_NOPAD;
use minijinja::context;
use uuid::Uuid;

use crate::{models::user::AuthSession, web::state::AppState};

pub async fn list_notifications(
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

    let comments =
        find_comments_to_posts_by_author(&mut tx, auth_session.user.clone().unwrap().id).await?;
    let comments_with_encoded_post_id = comments
        .into_iter()
        .map(|comment| {
            let encoded_post_id = BASE64URL_NOPAD.encode(comment.post_id.as_bytes());
            (comment, encoded_post_id)
        })
        .collect::<Vec<_>>();

    let template: minijinja::Template<'_, '_> = state.env.get_template("notifications.html")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        encoded_default_community_id => BASE64URL_NOPAD.encode(Uuid::parse_str(&state.config.default_community_id).unwrap().as_bytes()),
        messages => messages.into_iter().collect::<Vec<_>>(),
        comments => comments_with_encoded_post_id,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered).into_response())
}
