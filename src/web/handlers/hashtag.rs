use crate::app_error::AppError;
use crate::models::hashtag::{
    find_hashtag_by_name, find_posts_by_hashtag, get_trending_hashtags, search_hashtags,
};
use crate::models::user::AuthSession;
use crate::web::context::CommonContext;
use crate::web::handlers::ExtractFtlLang;
use crate::web::state::AppState;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse};
use minijinja::context;
use serde::Deserialize;
use sqlx::PgPool;

/// Display posts for a specific hashtag
pub async fn hashtag_view(
    auth_session: AuthSession,
    State(state): State<AppState>,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    Path(hashtag_name): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Normalize hashtag name (lowercase)
    let normalized_name = hashtag_name.to_lowercase();

    // Find the hashtag
    let hashtag = find_hashtag_by_name(&mut tx, &normalized_name).await?;
    if hashtag.is_none() {
        return Ok((
            StatusCode::NOT_FOUND,
            Html("<h1>Hashtag not found</h1>".to_string()),
        )
            .into_response());
    }
    let hashtag = hashtag.unwrap();

    // Get posts for this hashtag
    let posts = find_posts_by_hashtag(&mut tx, &normalized_name, 50).await?;

    let common_ctx =
        CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    tx.commit().await?;

    let template = state.env.get_template("hashtag_view.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        hashtag => hashtag,
        posts => posts,
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        ftl_lang
    })?;

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct AutocompleteQuery {
    q: String,
}

/// Autocomplete endpoint for hashtag search
pub async fn hashtag_autocomplete(
    State(state): State<AppState>,
    Query(params): Query<AutocompleteQuery>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Search for hashtags matching the query
    let hashtags = search_hashtags(&mut tx, &params.q, 10).await?;

    tx.commit().await?;

    let template = state.env.get_template("hashtag_autocomplete.jinja")?;
    let rendered = template.render(context! {
        hashtags => hashtags,
        query => params.q
    })?;

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct HashtagDiscoveryQuery {
    q: Option<String>,
    sort: Option<String>,
}

/// Hashtag discovery/search page
pub async fn hashtag_discovery(
    auth_session: AuthSession,
    State(state): State<AppState>,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    Query(params): Query<HashtagDiscoveryQuery>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let common_ctx =
        CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    // Determine sort order
    let sort_by = params.sort.as_deref().unwrap_or("trending");

    // Get hashtags based on search query or show all
    let hashtags = if let Some(ref query) = params.q {
        // Search mode
        search_hashtags(&mut tx, query, 100).await?
    } else {
        // Browse mode - get all hashtags sorted by chosen method
        match sort_by {
            "trending" => get_trending_hashtags(&mut tx, 100).await?,
            "popular" => get_all_hashtags_by_popularity(&db, 100).await?,
            "recent" => get_all_hashtags_by_recency(&db, 100).await?,
            "alphabetical" => get_all_hashtags_alphabetically(&db, 100).await?,
            _ => get_trending_hashtags(&mut tx, 100).await?,
        }
    };

    tx.commit().await?;

    let template = state.env.get_template("hashtag_discovery.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        hashtags => hashtags,
        search_query => params.q,
        sort_by => sort_by,
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        ftl_lang
    })?;

    Ok(Html(rendered).into_response())
}

/// Get all hashtags sorted by post count
async fn get_all_hashtags_by_popularity(
    db: &PgPool,
    limit: i64,
) -> Result<Vec<crate::models::hashtag::Hashtag>, anyhow::Error> {
    let mut tx = db.begin().await?;
    let hashtags = sqlx::query_as!(
        crate::models::hashtag::Hashtag,
        r#"
        SELECT id, name, display_name, post_count, created_at, updated_at
        FROM hashtags
        WHERE post_count > 0
        ORDER BY post_count DESC, name ASC
        LIMIT $1
        "#,
        limit
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(hashtags)
}

/// Get all hashtags sorted by most recently updated
async fn get_all_hashtags_by_recency(
    db: &PgPool,
    limit: i64,
) -> Result<Vec<crate::models::hashtag::Hashtag>, anyhow::Error> {
    let mut tx = db.begin().await?;
    let hashtags = sqlx::query_as!(
        crate::models::hashtag::Hashtag,
        r#"
        SELECT id, name, display_name, post_count, created_at, updated_at
        FROM hashtags
        WHERE post_count > 0
        ORDER BY updated_at DESC
        LIMIT $1
        "#,
        limit
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(hashtags)
}

/// Get all hashtags sorted alphabetically
async fn get_all_hashtags_alphabetically(
    db: &PgPool,
    limit: i64,
) -> Result<Vec<crate::models::hashtag::Hashtag>, anyhow::Error> {
    let mut tx = db.begin().await?;
    let hashtags = sqlx::query_as!(
        crate::models::hashtag::Hashtag,
        r#"
        SELECT id, name, display_name, post_count, created_at, updated_at
        FROM hashtags
        WHERE post_count > 0
        ORDER BY name ASC
        LIMIT $1
        "#,
        limit
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(hashtags)
}
