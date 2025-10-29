use crate::app_error::AppError;
use crate::models::user::AuthSession;
use crate::web::state::AppState;
use axum::extract::Query;
use axum::response::IntoResponse;
use axum::{extract::State, response::Json};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
    #[serde(default)]
    limit: Option<i64>,
}

pub async fn search_json(
    _auth_session: AuthSession,
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let search_term = format!("%{}%", query.q);
    let limit = query.limit.unwrap_or(20).min(50);

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
        INNER JOIN communities ON posts.community_id = communities.id
        WHERE (posts.title ILIKE $1 OR posts.content ILIKE $1)
          AND posts.published_at IS NOT NULL
          AND posts.deleted_at IS NULL
          AND communities.visibility = 'public'
        ORDER BY posts.published_at DESC
        LIMIT $2
        "#,
        search_term,
        limit
    )
    .fetch_all(&mut *tx)
    .await?;

    tx.commit().await?;

    // Convert users to JSON
    let users_json: Vec<serde_json::Value> = users
        .into_iter()
        .map(|user| {
            serde_json::json!({
                "id": user.id,
                "login_name": user.login_name,
                "display_name": user.display_name,
            })
        })
        .collect();

    // Convert posts to JSON with minimal fields for thumbnails
    let posts_json: Vec<serde_json::Value> = posts
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

            serde_json::json!({
                "id": post.id,
                "image_url": image_url,
                "image_width": post.image_width,
                "image_height": post.image_height,
                "is_sensitive": post.is_sensitive,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "users": users_json,
        "posts": posts_json,
    }))
    .into_response())
}
