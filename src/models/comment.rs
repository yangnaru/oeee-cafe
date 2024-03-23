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
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
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
            users.display_name AS user_display_name
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
            updated_at: comment.updated_at,
            created_at: comment.created_at,
        })
        .collect())
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
