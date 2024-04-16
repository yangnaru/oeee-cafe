use crate::models::post::get_draft_post_count;
use crate::models::user::AuthSession;
use crate::web::handlers::get_bundle;
use crate::web::state::AppState;
use crate::{app_error::AppError, web::handlers::create_base_ftl_context};
use axum::{extract::State, response::Html};
use minijinja::context;

use super::ExtractAcceptLanguage;

pub async fn about(
    State(state): State<AppState>,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    auth_session: AuthSession,
) -> Result<Html<String>, AppError> {
    let db: sqlx::Pool<sqlx::Postgres> = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let template: minijinja::Template<'_, '_> = state.env.get_template("about.html")?;
    let rendered: String = template.render(context! {
        current_user => auth_session.user,
        draft_post_count,
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered))
}
