use crate::app_error::AppError;
use crate::models::user::AuthSession;
use crate::web::context::CommonContext;
use crate::web::handlers::ExtractFtlLang;
use crate::web::state::AppState;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::response::Html;
use minijinja::context;

pub async fn admin_reports_page(
    auth_session: AuthSession,
    State(state): State<AppState>,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
) -> Result<impl IntoResponse, AppError> {
    // Check if user is logged in
    if auth_session.user.is_none() {
        return Ok(axum::response::Redirect::to("/login").into_response());
    }

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let common_ctx =
        CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    tx.commit().await?;

    let template = state.env.get_template("admin_reports.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        ftl_lang
    })?;

    Ok(Html(rendered))
}
