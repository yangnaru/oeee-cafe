use super::{get_bundle, ExtractAcceptLanguage};
use crate::{app_error::AppError, models::comment::find_comments_to_posts_by_author};
use axum::{
    extract::State,
    response::{Html, IntoResponse},
};
use axum_messages::Messages;
use minijinja::context;

use crate::{models::user::AuthSession, web::state::AppState};

pub async fn list_notifications(
    auth_session: AuthSession,
    State(state): State<AppState>,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    messages: Messages,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);

    let comments =
        find_comments_to_posts_by_author(&mut tx, auth_session.user.clone().unwrap().id).await?;
    let comments_with_post_id = comments
        .into_iter()
        .map(|comment| {
            let post_id = comment.post_id.to_string();
            (comment, post_id)
        })
        .collect::<Vec<_>>();

    let ftl_lang = bundle.locales.first().unwrap().to_string();
    let template: minijinja::Template<'_, '_> = state.env.get_template("notifications.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        messages => messages.into_iter().collect::<Vec<_>>(),
        comments => comments_with_post_id,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        ftl_lang
    })?;

    Ok(Html(rendered).into_response())
}
