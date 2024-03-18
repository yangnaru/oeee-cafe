use std::iter::Map;

use anyhow::Result;
use chrono::{DateTime, Duration, TimeDelta, Utc};
use serde::Serialize;
use sqlx::{postgres::types::PgInterval, query, Postgres, Transaction};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct Post {
    pub id: Uuid,
    pub author_id: Uuid,
    pub paint_duration: PgInterval,
    pub image_sha256: String,
    pub replay_sha256: String,
    pub published_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

impl Post {
    pub fn path(&self) -> String {
        format!("/posts/{}", self.id)
    }
}

pub struct PostDraft {
    pub author_id: Uuid,
    pub community_id: Uuid,
    pub paint_duration: PgInterval,
    pub image_sha256: String,
    pub replay_sha256: String,
}

pub async fn find_posts_by_community_id(
    tx: &mut Transaction<'_, Postgres>,
    community_id: Uuid,
) -> Result<Vec<Post>> {
    let q = query!(
        "
            SELECT
                id,
                author_id,
                paint_duration,
                image_sha256,
                replay_sha256,
                published_at,
                created_at,
                updated_at
            FROM posts
            WHERE community_id = $1
        ",
        community_id
    );
    let result = q.fetch_all(&mut **tx).await?;
    Ok(result
        .into_iter()
        .map(|row| Post {
            id: row.id,
            author_id: row.author_id,
            paint_duration: row.paint_duration,
            image_sha256: hex::encode(row.image_sha256),
            replay_sha256: hex::encode(row.replay_sha256),
            published_at: row.published_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
        .collect())
}

pub async fn find_published_posts_by_community_id(
    tx: &mut Transaction<'_, Postgres>,
    community_id: Uuid,
) -> Result<Vec<Post>> {
    let q = query!(
        "
            SELECT
                id,
                author_id,
                paint_duration,
                image_sha256,
                replay_sha256,
                published_at,
                created_at,
                updated_at
            FROM posts
            WHERE community_id = $1
            AND published_at IS NOT NULL
        ",
        community_id
    );
    let result = q.fetch_all(&mut **tx).await?;
    Ok(result
        .into_iter()
        .map(|row| Post {
            id: row.id,
            author_id: row.author_id,
            paint_duration: row.paint_duration,
            image_sha256: hex::encode(row.image_sha256),
            replay_sha256: hex::encode(row.replay_sha256),
            published_at: row.published_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
        .collect())
}

pub async fn create_post(
    tx: &mut Transaction<'_, Postgres>,
    post_draft: PostDraft,
) -> Result<Post> {
    let q = query!(
        "
            INSERT INTO posts (
                author_id,
                community_id,
                paint_duration,
                image_sha256,
                replay_sha256
            )
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, created_at, updated_at
        ",
        post_draft.author_id,
        post_draft.community_id,
        post_draft.paint_duration,
        hex::decode(&post_draft.image_sha256).unwrap(),
        hex::decode(&post_draft.replay_sha256).unwrap(),
    );
    let result = q.fetch_one(&mut **tx).await?;

    Ok(Post {
        id: result.id,
        author_id: post_draft.author_id,
        paint_duration: post_draft.paint_duration,
        image_sha256: post_draft.image_sha256,
        replay_sha256: post_draft.replay_sha256,
        published_at: None,
        created_at: result.created_at,
        updated_at: result.updated_at,
    })
}

// ...

pub async fn find_post_by_id(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<Option<HashMap<String, String>>> {
    let q = query!(
        "
            SELECT
                posts.id,
                posts.author_id,
                posts.paint_duration,
                posts.image_sha256,
                posts.replay_sha256,
                posts.published_at,
                posts.created_at,
                posts.updated_at,
                communities.id AS community_id,
                communities.name AS community_name
            FROM posts
            LEFT JOIN communities ON posts.community_id = communities.id
            WHERE posts.id = $1
        ",
        id
    );
    let result = q.fetch_optional(&mut **tx).await?;

    Ok(result.map(|row| {
        let mut map = HashMap::new();
        map.insert("id".to_string(), row.id.to_string());
        map.insert("author_id".to_string(), row.author_id.to_string());
        map.insert("image_sha256".to_string(), hex::encode(row.image_sha256));
        map.insert("replay_sha256".to_string(), hex::encode(row.replay_sha256));
        map.insert("created_at".to_string(), row.created_at.to_string());
        map.insert("updated_at".to_string(), row.updated_at.to_string());
        map.insert("community_id".to_string(), row.community_id.to_string());
        map.insert("community_name".to_string(), row.community_name.to_string());
        map
    }))
}

pub async fn publish_post(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    title: String,
    content: String,
) -> Result<()> {
    let q = query!(
        "
            UPDATE posts
            SET
                published_at = now(),
                title = $1,
                content = $2
            WHERE id = $3
        ",
        title,
        content,
        id
    );
    q.execute(&mut **tx).await?;
    Ok(())
}
