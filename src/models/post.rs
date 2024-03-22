use std::iter::Map;

use anyhow::Result;
use chrono::{DateTime, Duration, TimeDelta, Utc};
use chrono_tz::Asia::Seoul;
use data_encoding::BASE64URL_NOPAD;
use humantime::format_duration;
use serde::Serialize;
use sqlx::{postgres::types::PgInterval, query, Postgres, Transaction};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct Post {
    pub id: String,
    pub title: Option<String>,
    pub author_id: Uuid,
    pub paint_duration: PgInterval,
    pub stroke_count: i32,
    pub image_filename: String,
    pub replay_filename: String,
    pub published_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]

pub struct SerializablePost {
    pub id: String,
    pub author_id: Uuid,
    pub paint_duration: String,
    pub stroke_count: i32,
    pub image_filename: String,
    pub replay_filename: String,
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
    pub stroke_count: i32,
    pub width: i32,
    pub height: i32,
    pub image_filename: String,
    pub replay_filename: String,
}

pub async fn find_posts_by_community_id(
    tx: &mut Transaction<'_, Postgres>,
    community_id: Uuid,
) -> Result<Vec<Post>> {
    let q = query!(
        "
            SELECT
                id,
                title,
                author_id,
                paint_duration,
                stroke_count,
                image_filename,
                replay_filename,
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
        .map(|row| {
            return Post {
                id: BASE64URL_NOPAD.encode(row.id.as_bytes()),
                title: row.title,
                author_id: row.author_id,
                paint_duration: row.paint_duration,
                stroke_count: row.stroke_count,
                image_filename: row.image_filename,
                replay_filename: row.replay_filename,
                published_at: row.published_at,
                created_at: row.created_at,
                updated_at: row.updated_at,
            };
        })
        .collect())
}

pub async fn get_draft_post_count(
    tx: &mut Transaction<'_, Postgres>,
    author_id: Uuid,
) -> Result<i64> {
    let q = query!(
        "
            SELECT COUNT(*) FROM posts WHERE author_id = $1 AND published_at IS NULL
        ",
        author_id
    );
    let result = q.fetch_one(&mut **tx).await?;
    Ok(result.count.unwrap_or(0))
}

pub async fn find_draft_posts_by_author_id(
    tx: &mut Transaction<'_, Postgres>,
    author_id: Uuid,
) -> Result<Vec<SerializablePost>> {
    let q = query!(
        "
            SELECT
                id,
                author_id,
                paint_duration,
                stroke_count,
                image_filename,
                replay_filename,
                published_at,
                created_at,
                updated_at
            FROM posts
            WHERE author_id = $1
            AND published_at IS NULL
        ",
        author_id
    );
    let result = q.fetch_all(&mut **tx).await?;
    Ok(result
        .into_iter()
        .map(|row| SerializablePost {
            id: BASE64URL_NOPAD.encode(row.id.as_bytes()),
            author_id: row.author_id,
            paint_duration: row.paint_duration.microseconds.to_string(),
            stroke_count: row.stroke_count,
            image_filename: row.image_filename,
            replay_filename: row.replay_filename,
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
                title,
                author_id,
                paint_duration,
                stroke_count,
                image_filename,
                replay_filename,
                published_at,
                created_at,
                updated_at
            FROM posts
            WHERE community_id = $1
            AND published_at IS NOT NULL
            ORDER BY published_at DESC
        ",
        community_id
    );
    let result = q.fetch_all(&mut **tx).await?;
    Ok(result
        .into_iter()
        .map(|row| Post {
            id: BASE64URL_NOPAD.encode(row.id.as_bytes()),
            title: row.title,
            author_id: row.author_id,
            paint_duration: row.paint_duration,
            stroke_count: row.stroke_count,
            image_filename: row.image_filename,
            replay_filename: row.replay_filename,
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
                is_sensitive,
                paint_duration,
                stroke_count,
                width,
                height,
                image_filename,
                replay_filename
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id, created_at, updated_at
        ",
        post_draft.author_id,
        post_draft.community_id,
        false,
        post_draft.paint_duration,
        post_draft.stroke_count,
        post_draft.width,
        post_draft.height,
        &post_draft.image_filename,
        &post_draft.replay_filename,
    );
    let result = q.fetch_one(&mut **tx).await?;

    Ok(Post {
        id: BASE64URL_NOPAD.encode(result.id.as_bytes()),
        title: None,
        author_id: post_draft.author_id,
        paint_duration: post_draft.paint_duration,
        stroke_count: post_draft.stroke_count,
        image_filename: post_draft.image_filename,
        replay_filename: post_draft.replay_filename,
        published_at: None,
        created_at: result.created_at,
        updated_at: result.updated_at,
    })
}

// ...

pub async fn find_post_by_id(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<Option<HashMap<String, Option<String>>>> {
    let q = query!(
        "
            SELECT
                posts.id,
                posts.title,
                posts.content,
                posts.author_id,
                posts.paint_duration,
                posts.width,
                posts.height,
                posts.image_filename,
                posts.replay_filename,
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
        let mut map: HashMap<String, Option<String>> = HashMap::new();
        map.insert("id".to_string(), Some(row.id.to_string()));
        map.insert("author_id".to_string(), Some(row.author_id.to_string()));
        map.insert("title".to_string(), row.title);
        map.insert("content".to_string(), row.content);

        let paint_duration = Duration::try_seconds(row.paint_duration.microseconds / 1000000)
            .unwrap()
            .to_std()
            .unwrap();
        let paint_duration_human_readable = format_duration(paint_duration);
        map.insert(
            "paint_duration".to_string(),
            Some(paint_duration_human_readable.to_string()),
        );

        map.insert("width".to_string(), Some(row.width.to_string()));
        map.insert("height".to_string(), Some(row.height.to_string()));
        map.insert("image_filename".to_string(), Some(row.image_filename));
        map.insert("replay_filename".to_string(), Some(row.replay_filename));

        let created_at_seoul = row.created_at.with_timezone(&Seoul);
        let created_at_human_readable = created_at_seoul.format("%Y-%m-%d %H:%M").to_string();
        map.insert("created_at".to_string(), Some(created_at_human_readable));

        map.insert(
            "published_at".to_string(),
            row.published_at
                .map(|published_at| published_at.format("%Y-%m-%d %H:%M").to_string()),
        );
        map.insert(
            "updated_at".to_string(),
            Some(row.updated_at.format("%Y-%m-%d %H:%M").to_string()),
        );
        map.insert(
            "community_id".to_string(),
            Some(row.community_id.to_string()),
        );
        map.insert(
            "community_name".to_string(),
            Some(row.community_name.to_string()),
        );
        map
    }))
}

pub async fn publish_post(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    title: String,
    content: String,
    is_sensitive: bool,
) -> Result<()> {
    let q = query!(
        "
            UPDATE posts
            SET
                published_at = now(),
                title = $1,
                content = $2,
                is_sensitive = $3
            WHERE id = $4
        ",
        title,
        content,
        is_sensitive,
        id
    );
    q.execute(&mut **tx).await?;
    Ok(())
}
