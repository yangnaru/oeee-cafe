use crate::app_error::AppError;
use crate::models::user::{find_users_with_public_posts_and_banner, AuthSession};
use crate::web::context::CommonContext;
use crate::web::state::AppState;
use axum::{extract::State, response::Html};

use minijinja::context;

use super::ExtractFtlLang;

pub async fn about(
    State(state): State<AppState>,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    auth_session: AuthSession,
) -> Result<Html<String>, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let common_ctx =
        CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    let users_with_public_posts_and_banner = find_users_with_public_posts_and_banner(&mut tx)
        .await
        .unwrap_or_default();

    let template: minijinja::Template<'_, '_> = state.env.get_template("about.jinja")?;
    let rendered: String = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        users_with_public_posts_and_banner,
        ftl_lang,
    })?;

    Ok(Html(rendered))
}
