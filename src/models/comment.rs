use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize)]
pub struct Comment {
    pub id: Uuid,
    pub post_id: Uuid,
    pub user_id: Uuid,
    pub content: String,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

pub struct CommentDraft {
    pub post_id: Uuid,
    pub user_id: Uuid,
    pub content: String,
}

#[derive(Serialize)]
pub struct SerializableComment {
    pub id: Uuid,
    pub post_id: Uuid,
    pub user_id: Uuid,
    pub content: String,
    pub user_display_name: String,
    pub user_login_name: String,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct NotificationComment {
    pub id: Uuid,
    pub post_id: Uuid,
    pub user_id: Uuid,
    pub content: String,
    pub user_display_name: String,
    pub user_login_name: String,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub post_title: Option<String>,
    pub post_image_filename: Option<String>,
    pub post_image_width: Option<i32>,
    pub post_image_height: Option<i32>,
}

pub async fn find_comments_by_post_id(
    tx: &mut Transaction<'_, Postgres>,
    post_id: Uuid,
) -> Result<Vec<SerializableComment>> {
    let comments = sqlx::query!(
        r#"
        SELECT
            comments.id,
            comments.post_id,
            comments.user_id,
            comments.updated_at,
            comments.created_at,
            comments.content,
            users.display_name AS user_display_name,
            users.login_name AS user_login_name
        FROM comments
        LEFT JOIN users ON comments.user_id = users.id
        WHERE post_id = $1
        ORDER BY created_at DESC
        "#,
        post_id
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(comments
        .into_iter()
        .map(|comment| SerializableComment {
            id: comment.id,
            post_id: comment.post_id,
            user_id: comment.user_id,
            content: comment.content,
            user_display_name: comment.user_display_name,
            user_login_name: comment.user_login_name,
            updated_at: comment.updated_at,
            created_at: comment.created_at,
        })
        .collect())
}

pub async fn find_comments_to_posts_by_author(
    tx: &mut Transaction<'_, Postgres>,
    author_id: Uuid,
) -> Result<Vec<NotificationComment>> {
    let comments = sqlx::query_as!(
        NotificationComment,
        r#"
        SELECT
            comments.id,
            comments.post_id,
            comments.user_id,
            comments.updated_at,
            comments.created_at,
            comments.content,
            users.display_name AS user_display_name,
            users.login_name AS user_login_name,
            posts.title AS post_title,
            images.image_filename AS post_image_filename,
            images.width AS post_image_width,
            images.height AS post_image_height
        FROM comments
        LEFT JOIN users ON comments.user_id = users.id
        LEFT JOIN posts ON comments.post_id = posts.id
        LEFT JOIN images ON posts.image_id = images.id
        WHERE posts.author_id = $1
        AND comments.user_id != $1
        AND posts.deleted_at IS NULL
        ORDER BY created_at DESC
        "#,
        author_id
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(comments)
}

pub async fn find_latest_comments_in_community(
    tx: &mut Transaction<'_, Postgres>,
    community_id: Uuid,
    limit: i64,
) -> Result<Vec<NotificationComment>> {
    let comments = sqlx::query_as!(
        NotificationComment,
        r#"
        SELECT
            comments.id,
            comments.post_id,
            comments.user_id,
            comments.updated_at,
            comments.created_at,
            comments.content,
            users.display_name AS user_display_name,
            users.login_name AS user_login_name,
            posts.title AS post_title,
            images.image_filename AS post_image_filename,
            images.width AS post_image_width,
            images.height AS post_image_height
        FROM comments
        LEFT JOIN users ON comments.user_id = users.id
        LEFT JOIN posts ON comments.post_id = posts.id
        LEFT JOIN images ON posts.image_id = images.id
        WHERE posts.community_id = $1
        AND posts.published_at IS NOT NULL
        AND comments.user_id != posts.author_id
        AND posts.deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT $2
        "#,
        community_id,
        limit
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(comments)
}

pub async fn create_comment(
    tx: &mut Transaction<'_, Postgres>,
    draft: CommentDraft,
) -> Result<Comment> {
    let comment = sqlx::query_as!(
        Comment,
        r#"
        INSERT INTO comments (post_id, user_id, content)
        VALUES ($1, $2, $3)
        RETURNING *
        "#,
        draft.post_id,
        draft.user_id,
        draft.content
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(comment)
}
