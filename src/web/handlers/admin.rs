use crate::app_error::AppError;
use crate::models::community::{Community, CommunityVisibility};
use crate::web::context::CommonContext;
use crate::web::handlers::{AdminUser, ExtractFtlLang};
use crate::web::state::AppState;
use axum::extract::{Query, State};
use axum::response::Html;
use minijinja::context;
use serde::Deserialize;
use sqlx::query_as;

#[derive(Deserialize)]
pub struct CommunitySearchParams {
    pub q: Option<String>,
    pub visibility: Option<String>,
}

#[derive(serde::Serialize)]
pub struct CommunityWithOwner {
    pub id: uuid::Uuid,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub visibility: CommunityVisibility,
    pub owner_login_name: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub member_count: Option<i64>,
    pub post_count: Option<i64>,
}

pub async fn admin_page(
    AdminUser(admin): AdminUser,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    Query(params): Query<CommunitySearchParams>,
    State(state): State<AppState>,
) -> Result<Html<String>, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let common_ctx = CommonContext::build(&mut tx, Some(admin.id)).await?;

    // Build the search query
    let search_term = params.q.as_deref().unwrap_or("");
    let visibility_filter = params.visibility.as_deref();

    let mut query = String::from(
        r#"
        SELECT
            c.id,
            c.name,
            c.slug,
            c.description,
            c.visibility,
            c.created_at,
            u.login_name AS owner_login_name,
            COUNT(DISTINCT cm.id) AS member_count,
            COUNT(DISTINCT p.id) AS post_count
        FROM communities c
        LEFT JOIN users u ON c.owner_id = u.id
        LEFT JOIN community_members cm ON c.id = cm.community_id
        LEFT JOIN posts p ON c.id = p.community_id AND p.deleted_at IS NULL
        WHERE c.deleted_at IS NULL
    "#,
    );

    // Add search filter
    if !search_term.is_empty() {
        query.push_str(&format!(
            " AND (c.name ILIKE '%{}%' OR c.slug ILIKE '%{}%' OR c.description ILIKE '%{}%')",
            search_term.replace('\'', "''"),
            search_term.replace('\'', "''"),
            search_term.replace('\'', "''")
        ));
    }

    // Add visibility filter
    if let Some(visibility) = visibility_filter {
        match visibility {
            "public" => query.push_str(" AND c.visibility = 'public'"),
            "unlisted" => query.push_str(" AND c.visibility = 'unlisted'"),
            "private" => query.push_str(" AND c.visibility = 'private'"),
            _ => {}
        }
    }

    query.push_str(
        " GROUP BY c.id, u.login_name ORDER BY c.created_at DESC LIMIT 100",
    );

    let communities = query_as::<_, CommunityWithOwner>(&query)
        .fetch_all(&mut *tx)
        .await?;

    tx.commit().await?;

    let template = state.env.get_template("admin/index.jinja")?;
    let rendered = template.render(context! {
        current_user => admin,
        default_community_id => state.config.default_community_id.clone(),
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        communities => communities,
        search_query => search_term,
        visibility_filter => visibility_filter,
        ftl_lang
    })?;

    Ok(Html(rendered))
}
