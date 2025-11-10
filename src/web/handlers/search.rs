use crate::app_error::AppError;
use crate::models::user::AuthSession;
use crate::web::responses::{SearchPostResult, SearchResponse, SearchUserResult};
use crate::web::state::AppState;
use axum::extract::Query;
use axum::{extract::State, response::Json};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
    #[serde(default)]
    limit: Option<i64>,
}

pub async fn search_json(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<SearchResponse>, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let search_term = format!("%{}%", query.q);
    let limit = query.limit.unwrap_or(20).min(50);

    // Get viewer preferences for sensitive content filtering
    let (viewer_user_id, viewer_show_sensitive) = if let Some(user) = auth_session.user {
        (Some(user.id), user.show_sensitive_content)
    } else {
        (None, false)
    };

    // Search for users by login_name or display_name
    let users = sqlx::query!(
        r#"
        SELECT
            id,
            login_name,
            display_name
        FROM users
        WHERE login_name ILIKE $1
           OR display_name ILIKE $1
        ORDER BY
            CASE
                WHEN login_name ILIKE $2 THEN 0
                WHEN display_name ILIKE $2 THEN 1
                ELSE 2
            END,
            login_name
        LIMIT $3
        "#,
        search_term,
        query.q,
        limit
    )
    .fetch_all(&mut *tx)
    .await?;

    // Search for posts by title or content (only from public communities)
    let posts = sqlx::query!(
        r#"
        SELECT
            posts.id,
            posts.title,
            posts.content,
            posts.author_id,
            users.login_name AS user_login_name,
            images.image_filename AS "image_filename?",
            images.width AS "image_width?",
            images.height AS "image_height?",
            posts.published_at,
            posts.is_sensitive
        FROM posts
        LEFT JOIN users ON posts.author_id = users.id
        LEFT JOIN images ON posts.image_id = images.id
        LEFT JOIN communities ON posts.community_id = communities.id
        WHERE (posts.title ILIKE $1 OR posts.content ILIKE $1)
          AND posts.published_at IS NOT NULL
          AND posts.deleted_at IS NULL
          AND (communities.visibility = 'public' OR posts.community_id IS NULL)
          AND (posts.is_sensitive = false OR $3 = true OR posts.author_id = $4)
        ORDER BY posts.published_at DESC
        LIMIT $2
        "#,
        search_term,
        limit,
        viewer_show_sensitive,
        viewer_user_id
    )
    .fetch_all(&mut *tx)
    .await?;

    tx.commit().await?;

    // Convert users to typed structs
    let users_typed: Vec<SearchUserResult> = users
        .into_iter()
        .map(|user| SearchUserResult {
            id: user.id,
            login_name: user.login_name,
            display_name: user.display_name,
        })
        .collect();

    // Convert posts to typed structs with minimal fields for thumbnails
    let posts_typed: Vec<SearchPostResult> = posts
        .into_iter()
        .map(|post| {
            let image_url = if let Some(ref filename) = post.image_filename {
                let image_prefix = &filename[..2];
                format!(
                    "{}/image/{}/{}",
                    state.config.r2_public_endpoint_url, image_prefix, filename
                )
            } else {
                String::new()
            };

            SearchPostResult {
                id: post.id,
                image_url,
                image_width: post.image_width,
                image_height: post.image_height,
                is_sensitive: post.is_sensitive,
            }
        })
        .collect();

    Ok(Json(SearchResponse {
        users: users_typed,
        posts: posts_typed,
    }))
}
