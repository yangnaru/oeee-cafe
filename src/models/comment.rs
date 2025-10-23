use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize)]
pub struct Comment {
    pub id: Uuid,
    pub post_id: Uuid,
    pub actor_id: Uuid,
    pub content: String,
    pub content_html: Option<String>,
    pub iri: Option<String>,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

pub struct CommentDraft {
    pub post_id: Uuid,
    pub actor_id: Uuid,
    pub content: String,
    pub content_html: Option<String>,
}

#[derive(Serialize)]
pub struct SerializableComment {
    pub id: Uuid,
    pub post_id: Uuid,
    pub actor_id: Uuid,
    pub content: String,
    pub content_html: Option<String>,
    pub iri: Option<String>,
    pub actor_name: String,
    pub actor_handle: String,
    pub actor_url: String,
    pub actor_login_name: Option<String>,
    pub is_local: bool,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct NotificationComment {
    pub id: Uuid,
    pub post_id: Uuid,
    pub actor_id: Uuid,
    pub content: String,
    pub content_html: Option<String>,
    pub iri: Option<String>,
    pub actor_name: String,
    pub actor_handle: String,
    pub actor_url: String,
    pub actor_login_name: Option<String>,
    pub is_local: bool,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub post_title: Option<String>,
    pub post_author_login_name: String,
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
            comments.actor_id,
            comments.updated_at,
            comments.created_at,
            comments.content,
            comments.content_html,
            comments.iri,
            actors.name AS actor_name,
            actors.handle AS actor_handle,
            actors.url AS actor_url,
            users.login_name AS "user_login_name?"
        FROM comments
        LEFT JOIN actors ON comments.actor_id = actors.id
        LEFT JOIN users ON actors.user_id = users.id
        WHERE post_id = $1
        ORDER BY created_at ASC
        "#,
        post_id
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(comments
        .into_iter()
        .map(|comment| {
            let is_local = comment.user_login_name.is_some();
            SerializableComment {
                id: comment.id,
                post_id: comment.post_id,
                actor_id: comment.actor_id,
                content: comment.content,
                content_html: comment.content_html,
                iri: comment.iri,
                actor_name: comment.actor_name,
                actor_handle: comment.actor_handle,
                actor_url: comment.actor_url,
                actor_login_name: comment.user_login_name.clone(),
                is_local,
                updated_at: comment.updated_at,
                created_at: comment.created_at,
            }
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
            comments.actor_id,
            comments.updated_at,
            comments.created_at,
            comments.content,
            comments.content_html,
            comments.iri,
            actors.name AS actor_name,
            actors.handle AS actor_handle,
            actors.url AS actor_url,
            comment_authors.login_name AS "actor_login_name?",
            CASE WHEN comment_authors.id IS NOT NULL THEN true ELSE false END AS "is_local!",
            posts.title AS post_title,
            post_authors.login_name AS post_author_login_name,
            images.image_filename AS post_image_filename,
            images.width AS post_image_width,
            images.height AS post_image_height
        FROM comments
        LEFT JOIN actors ON comments.actor_id = actors.id
        LEFT JOIN users AS comment_authors ON actors.user_id = comment_authors.id
        LEFT JOIN posts ON comments.post_id = posts.id
        LEFT JOIN users AS post_authors ON posts.author_id = post_authors.id
        LEFT JOIN images ON posts.image_id = images.id
        WHERE posts.author_id = $1
        AND actors.user_id != $1
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
            comments.actor_id,
            comments.updated_at,
            comments.created_at,
            comments.content,
            comments.content_html,
            comments.iri,
            actors.name AS actor_name,
            actors.handle AS actor_handle,
            actors.url AS actor_url,
            comment_authors.login_name AS "actor_login_name?",
            CASE WHEN comment_authors.id IS NOT NULL THEN true ELSE false END AS "is_local!",
            posts.title AS post_title,
            post_authors.login_name AS post_author_login_name,
            images.image_filename AS post_image_filename,
            images.width AS post_image_width,
            images.height AS post_image_height
        FROM comments
        LEFT JOIN actors ON comments.actor_id = actors.id
        LEFT JOIN users AS comment_authors ON actors.user_id = comment_authors.id
        LEFT JOIN posts ON comments.post_id = posts.id
        LEFT JOIN users AS post_authors ON posts.author_id = post_authors.id
        LEFT JOIN images ON posts.image_id = images.id
        WHERE posts.community_id = $1
        AND posts.published_at IS NOT NULL
        AND (actors.user_id IS NULL OR actors.user_id != posts.author_id)
        AND posts.deleted_at IS NULL
        ORDER BY comments.created_at DESC
        LIMIT $2
        "#,
        community_id,
        limit
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(comments)
}

pub async fn find_latest_comments_from_public_communities(
    tx: &mut Transaction<'_, Postgres>,
    limit: i64,
) -> Result<Vec<NotificationComment>> {
    let comments = sqlx::query_as!(
        NotificationComment,
        r#"
        WITH ranked_comments AS (
            SELECT
                comments.id,
                comments.post_id,
                comments.actor_id,
                comments.updated_at,
                comments.created_at,
                comments.content,
                comments.content_html,
                comments.iri,
                actors.name AS actor_name,
                actors.handle AS actor_handle,
                actors.url AS actor_url,
                comment_authors.login_name AS actor_login_name,
                CASE WHEN comment_authors.id IS NOT NULL THEN true ELSE false END AS is_local,
                posts.title AS post_title,
                post_authors.login_name AS post_author_login_name,
                images.image_filename AS post_image_filename,
                images.width AS post_image_width,
                images.height AS post_image_height,
                ROW_NUMBER() OVER (PARTITION BY comments.post_id ORDER BY comments.created_at DESC) AS rn
            FROM comments
            LEFT JOIN actors ON comments.actor_id = actors.id
            LEFT JOIN users AS comment_authors ON actors.user_id = comment_authors.id
            LEFT JOIN posts ON comments.post_id = posts.id
            LEFT JOIN users AS post_authors ON posts.author_id = post_authors.id
            LEFT JOIN images ON posts.image_id = images.id
            LEFT JOIN communities ON posts.community_id = communities.id
            WHERE communities.visibility = 'public'
            AND posts.published_at IS NOT NULL
            AND (actors.user_id IS NULL OR actors.user_id != posts.author_id)
            AND posts.deleted_at IS NULL
        )
        SELECT
            id,
            post_id,
            actor_id,
            updated_at,
            created_at,
            content,
            content_html,
            iri,
            actor_name,
            actor_handle,
            actor_url,
            actor_login_name AS "actor_login_name?",
            is_local AS "is_local!",
            post_title,
            post_author_login_name,
            post_image_filename,
            post_image_width,
            post_image_height
        FROM ranked_comments
        WHERE rn = 1
        ORDER BY created_at DESC
        LIMIT $1
        "#,
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
        INSERT INTO comments (post_id, actor_id, content, content_html)
        VALUES ($1, $2, $3, $4)
        RETURNING *
        "#,
        draft.post_id,
        draft.actor_id,
        draft.content,
        draft.content_html
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(comment)
}

pub async fn find_comment_by_iri(
    tx: &mut Transaction<'_, Postgres>,
    iri: &str,
) -> Result<Option<Comment>> {
    let comment = sqlx::query_as!(
        Comment,
        r#"
        SELECT * FROM comments
        WHERE iri = $1
        "#,
        iri
    )
    .fetch_optional(&mut **tx)
    .await?;

    Ok(comment)
}

pub async fn delete_comment_by_iri(
    tx: &mut Transaction<'_, Postgres>,
    iri: &str,
) -> Result<bool> {
    let result = sqlx::query!(
        r#"
        DELETE FROM comments
        WHERE iri = $1
        "#,
        iri
    )
    .execute(&mut **tx)
    .await?;

    Ok(result.rows_affected() > 0)
}

pub async fn create_comment_from_activitypub(
    tx: &mut Transaction<'_, Postgres>,
    post_id: Uuid,
    actor_id: Uuid,
    content: String,
    content_html: Option<String>,
    iri: String,
) -> Result<Comment> {
    let comment = sqlx::query_as!(
        Comment,
        r#"
        INSERT INTO comments (post_id, actor_id, content, content_html, iri)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
        "#,
        post_id,
        actor_id,
        content,
        content_html,
        iri
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(comment)
}

/// Extract @mentions from comment content
/// Returns a list of login names (without the @ prefix)
pub fn extract_mentions(content: &str) -> Vec<String> {
    let mut mentions = std::collections::HashSet::new();
    let mut chars = content.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '@' {
            let mut username = String::new();

            // Extract username: alphanumeric, hyphens, underscores
            while let Some(&next_ch) = chars.peek() {
                if next_ch.is_alphanumeric() || next_ch == '-' || next_ch == '_' {
                    username.push(next_ch);
                    chars.next();
                } else {
                    break;
                }
            }

            if !username.is_empty() {
                mentions.insert(username);
            }
        }
    }

    mentions.into_iter().collect()
}

/// Find users by their login names
pub async fn find_users_by_login_names(
    tx: &mut Transaction<'_, Postgres>,
    login_names: &[String],
) -> Result<Vec<(Uuid, String)>> {
    if login_names.is_empty() {
        return Ok(vec![]);
    }

    let users = sqlx::query!(
        r#"
        SELECT id, login_name
        FROM users
        WHERE login_name = ANY($1)
        "#,
        login_names
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(users
        .into_iter()
        .map(|u| (u.id, u.login_name))
        .collect())
}
