use super::ExtractAcceptLanguage;
use crate::app_error::AppError;
use crate::models::community::get_public_communities;
use crate::models::post::{find_following_posts_by_user_id, get_draft_post_count};
use crate::models::user::AuthSession;
use crate::web::handlers::{create_base_ftl_context, get_bundle};
use crate::web::state::AppState;
use axum::debug_handler;
use axum::response::IntoResponse;
use axum::{extract::State, response::Html};
use axum_messages::Messages;
use data_encoding::BASE64URL_NOPAD;
use minijinja::context;
use std::collections::HashMap;

#[debug_handler]
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

    if auth_session.user.is_none() {
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

        let template = state.env.get_template("communities.html")?;
        let rendered = template.render(context! {
            public_communities,
            current_user => auth_session.user,
            messages => messages.clone().collect::<Vec<_>>(),
            ..create_base_ftl_context(&bundle)
        })?;

        return Ok(Html(rendered).into_response());
    }

    let timeline_posts = match auth_session.user.clone() {
        Some(user) => find_following_posts_by_user_id(&mut tx, user.id).await?,
        None => vec![],
    };

    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let template: minijinja::Template<'_, '_> = state.env.get_template("home.html")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        messages => messages.into_iter().collect::<Vec<_>>(),
        posts => timeline_posts,
        draft_post_count,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered).into_response())
}
