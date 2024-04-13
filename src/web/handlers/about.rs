use crate::app_error::AppError;
use crate::models::post::get_draft_post_count;
use crate::models::user::AuthSession;
use crate::web::state::AppState;
use axum::{extract::State, response::Html};
use minijinja::context;

pub async fn about(
    State(state): State<AppState>,
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

    let template: minijinja::Template<'_, '_> = state.env.get_template("about.html")?;
    let rendered: String = template.render(context! {
        current_user => auth_session.user,
        draft_post_count,
    })?;

    Ok(Html(rendered))
}
