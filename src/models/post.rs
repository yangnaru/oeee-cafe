use anyhow::Result;
use chrono::{DateTime, Duration, Utc};
use chrono_tz::Asia::Seoul;
use data_encoding::BASE64URL_NOPAD;
use humantime::format_duration;
use serde::{Deserialize, Serialize};
use sqlx::Type;
use sqlx::{postgres::types::PgInterval, query, Postgres, Transaction};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct Post {
    pub id: Uuid,
    pub image_id: Uuid,
    pub title: Option<String>,
    pub author_id: Uuid,
    pub paint_duration: PgInterval,
    pub viewer_count: i32,
    pub published_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]

pub struct SerializablePost {
    pub id: String,
    pub title: Option<String>,
    pub author_id: Uuid,
    pub paint_duration: String,
    pub stroke_count: i32,
    pub viewer_count: i32,
    pub image_filename: String,
    pub image_width: i32,
    pub image_height: i32,
    pub replay_filename: String,
    pub published_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct SerializableProfilePost {
    pub id: String,
    pub title: Option<String>,
    pub author_id: Uuid,
    pub paint_duration: String,
    pub stroke_count: i32,
    pub viewer_count: i32,
    pub image_filename: String,
    pub image_width: i32,
    pub image_height: i32,
    pub replay_filename: String,
    pub published_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub community_is_private: bool,
}

#[derive(Serialize)]
pub struct SerializablePostForHome {
    pub id: String,
    pub title: Option<String>,
    pub author_id: Uuid,
    pub paint_duration: String,
    pub stroke_count: i32,
    pub viewer_count: i32,
    pub image_filename: String,
    pub image_width: i32,
    pub image_height: i32,
    pub replay_filename: String,
    pub is_sensitive: bool,
    pub published_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

impl Post {
    pub fn path(&self) -> String {
        format!("/posts/{}", self.id)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Type)]
#[sqlx(type_name = "tool", rename_all = "lowercase")]
pub enum Tool {
    Neo,
    Tegaki,
    Cucumber,
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
    pub tool: Tool,
    pub parent_post_id: Option<Uuid>,
}

pub async fn find_posts_by_community_id(
    tx: &mut Transaction<'_, Postgres>,
    community_id: Uuid,
) -> Result<Vec<SerializablePost>> {
    let q = query!(
        "
            SELECT
                posts.id,
                posts.title,
                posts.author_id,
                images.paint_duration AS paint_duration,
                images.stroke_count AS stroke_count,
                images.image_filename AS image_filename,
                images.width AS width,
                images.height AS height,
                images.replay_filename AS replay_filename,
                posts.viewer_count,
                posts.published_at,
                posts.created_at,
                posts.updated_at
            FROM posts
            LEFT JOIN images ON posts.image_id = images.id
            WHERE community_id = $1
            AND posts.deleted_at IS NULL
        ",
        community_id
    );
    let result = q.fetch_all(&mut **tx).await?;
    Ok(result
        .into_iter()
        .map(|row| SerializablePost {
            id: BASE64URL_NOPAD.encode(row.id.as_bytes()),
            title: row.title,
            author_id: row.author_id,
            paint_duration: row.paint_duration.microseconds.to_string(),
            stroke_count: row.stroke_count,
            image_filename: row.image_filename,
            image_width: row.width,
            image_height: row.height,
            replay_filename: row.replay_filename,
            viewer_count: row.viewer_count,
            published_at: row.published_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
        .collect())
}

pub async fn get_draft_post_count(
    tx: &mut Transaction<'_, Postgres>,
    author_id: Uuid,
) -> Result<i64> {
    let q = query!(
        "
            SELECT COUNT(*)
            FROM posts
            WHERE author_id = $1
            AND published_at IS NULL
            AND deleted_at IS NULL 
        ",
        author_id
    );
    let result = q.fetch_one(&mut **tx).await?;
    Ok(result.count.unwrap_or(0))
}

pub async fn find_published_public_posts_by_author_id(
    tx: &mut Transaction<'_, Postgres>,
    author_id: Uuid,
) -> Result<Vec<SerializableProfilePost>> {
    let q = query!(
        "
            SELECT
                posts.id,
                posts.author_id,
                posts.title,
                posts.viewer_count,
                images.paint_duration,
                images.stroke_count,
                images.image_filename,
                images.width,
                images.height,
                images.replay_filename,
                posts.published_at,
                posts.created_at,
                posts.updated_at,
                communities.is_private
            FROM posts
            LEFT JOIN images ON posts.image_id = images.id
            LEFT JOIN communities ON posts.community_id = communities.id
            WHERE author_id = $1
            AND communities.is_private = FALSE
            AND published_at IS NOT NULL
            AND posts.deleted_at IS NULL
            ORDER BY published_at DESC
        ",
        author_id
    );
    let result = q.fetch_all(&mut **tx).await?;
    Ok(result
        .into_iter()
        .map(|row| SerializableProfilePost {
            id: BASE64URL_NOPAD.encode(row.id.as_bytes()),
            title: row.title,
            viewer_count: row.viewer_count,
            author_id: row.author_id,
            paint_duration: row.paint_duration.microseconds.to_string(),
            stroke_count: row.stroke_count,
            image_filename: row.image_filename,
            image_width: row.width,
            image_height: row.height,
            replay_filename: row.replay_filename,
            published_at: row.published_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
            community_is_private: row.is_private,
        })
        .collect())
}

pub async fn find_published_posts_by_author_id(
    tx: &mut Transaction<'_, Postgres>,
    author_id: Uuid,
) -> Result<Vec<SerializableProfilePost>> {
    let q = query!(
        "
            SELECT
                posts.id,
                posts.author_id,
                posts.title,
                posts.viewer_count,
                images.paint_duration,
                images.stroke_count,
                images.image_filename,
                images.width,
                images.height,
                images.replay_filename,
                posts.published_at,
                posts.created_at,
                posts.updated_at,
                communities.is_private
            FROM posts
            LEFT JOIN images ON posts.image_id = images.id
            LEFT JOIN communities ON posts.community_id = communities.id
            WHERE author_id = $1
            AND published_at IS NOT NULL
            AND posts.deleted_at IS NULL
            ORDER BY published_at DESC
        ",
        author_id
    );
    let result = q.fetch_all(&mut **tx).await?;
    Ok(result
        .into_iter()
        .map(|row| SerializableProfilePost {
            id: BASE64URL_NOPAD.encode(row.id.as_bytes()),
            title: row.title,
            viewer_count: row.viewer_count,
            author_id: row.author_id,
            paint_duration: row.paint_duration.microseconds.to_string(),
            stroke_count: row.stroke_count,
            image_filename: row.image_filename,
            image_width: row.width,
            image_height: row.height,
            replay_filename: row.replay_filename,
            published_at: row.published_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
            community_is_private: row.is_private,
        })
        .collect())
}

pub async fn find_draft_posts_by_author_id(
    tx: &mut Transaction<'_, Postgres>,
    author_id: Uuid,
) -> Result<Vec<SerializablePost>> {
    let q = query!(
        "
            SELECT
                posts.id,
                posts.author_id,
                posts.title,
                posts.viewer_count,
                images.paint_duration,
                images.stroke_count,
                images.image_filename,
                images.width,
                images.height,
                images.replay_filename,
                posts.published_at,
                posts.created_at,
                posts.updated_at
            FROM posts
            LEFT JOIN images ON posts.image_id = images.id
            WHERE author_id = $1
            AND published_at IS NULL
            AND posts.deleted_at IS NULL
        ",
        author_id
    );
    let result = q.fetch_all(&mut **tx).await?;
    Ok(result
        .into_iter()
        .map(|row| SerializablePost {
            id: BASE64URL_NOPAD.encode(row.id.as_bytes()),
            title: row.title,
            viewer_count: row.viewer_count,
            author_id: row.author_id,
            paint_duration: row.paint_duration.microseconds.to_string(),
            stroke_count: row.stroke_count,
            image_filename: row.image_filename,
            image_width: row.width,
            image_height: row.height,
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
) -> Result<Vec<SerializablePost>> {
    let q = query!(
        "
            SELECT
                posts.id,
                posts.title,
                posts.author_id,
                images.paint_duration,
                images.stroke_count,
                images.image_filename,
                images.width,
                images.height,
                images.replay_filename,
                posts.viewer_count,
                posts.published_at,
                posts.created_at,
                posts.updated_at
            FROM posts
            LEFT JOIN images ON posts.image_id = images.id
            WHERE community_id = $1
            AND published_at IS NOT NULL
            AND posts.deleted_at IS NULL
            ORDER BY published_at DESC
        ",
        community_id
    );
    let result = q.fetch_all(&mut **tx).await?;
    Ok(result
        .into_iter()
        .map(|row| SerializablePost {
            id: BASE64URL_NOPAD.encode(row.id.as_bytes()),
            title: row.title,
            author_id: row.author_id,
            paint_duration: row.paint_duration.microseconds.to_string(),
            stroke_count: row.stroke_count,
            image_filename: row.image_filename,
            image_width: row.width,
            image_height: row.height,
            replay_filename: row.replay_filename,
            viewer_count: row.viewer_count,
            published_at: row.published_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
        .collect())
}

pub async fn create_post(
    tx: &mut Transaction<'_, Postgres>,
    post_draft: PostDraft,
) -> Result<SerializablePost> {
    let image = query!(
        r#"
            INSERT INTO images (
                paint_duration,
                stroke_count,
                width,
                height,
                image_filename,
                replay_filename,
                tool
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
        "#,
        post_draft.paint_duration,
        post_draft.stroke_count,
        post_draft.width,
        post_draft.height,
        post_draft.image_filename,
        post_draft.replay_filename,
        post_draft.tool as _
    )
    .fetch_one(&mut **tx)
    .await?;

    let post = query!(
        "
            INSERT INTO posts (
                author_id,
                image_id,
                community_id,
                is_sensitive,
                parent_post_id
            )
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, created_at, updated_at
        ",
        post_draft.author_id,
        image.id,
        post_draft.community_id,
        false,
        post_draft.parent_post_id
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(SerializablePost {
        id: BASE64URL_NOPAD.encode(post.id.as_bytes()),
        title: None,
        author_id: post_draft.author_id,
        paint_duration: post_draft.paint_duration.microseconds.to_string(),
        stroke_count: post_draft.stroke_count,
        image_filename: post_draft.image_filename,
        image_width: post_draft.width,
        image_height: post_draft.height,
        replay_filename: post_draft.replay_filename,
        viewer_count: 0,
        published_at: None,
        created_at: post.created_at,
        updated_at: post.updated_at,
    })
}

pub async fn increment_post_viewer_count(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<()> {
    let q = query!(
        "
            UPDATE posts
            SET viewer_count = viewer_count + 1
            WHERE id = $1
        ",
        id
    );
    q.execute(&mut **tx).await?;
    Ok(())
}

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
                posts.is_sensitive,
                posts.author_id,
                images.id AS image_id,
                images.tool::text AS image_tool,
                images.paint_duration,
                images.width,
                images.height,
                images.image_filename,
                images.replay_filename,
                posts.viewer_count,
                posts.published_at,
                posts.created_at,
                posts.updated_at,
                posts.allow_relay,
                posts.parent_post_id,
                users.display_name AS display_name,
                users.login_name AS login_name,
                communities.id AS community_id,
                communities.name AS community_name
            FROM posts
            LEFT JOIN images ON posts.image_id = images.id
            LEFT JOIN communities ON posts.community_id = communities.id
            LEFT JOIN users ON posts.author_id = users.id
            WHERE posts.id = $1
            AND posts.deleted_at IS NULL
        ",
        id
    );
    let result = q.fetch_optional(&mut **tx).await?;

    Ok(result.map(|row| {
        let mut map: HashMap<String, Option<String>> = HashMap::new();
        map.insert("id".to_string(), Some(row.id.to_string()));
        map.insert("author_id".to_string(), Some(row.author_id.to_string()));
        map.insert("display_name".to_string(), Some(row.display_name));
        map.insert("login_name".to_string(), Some(row.login_name));
        map.insert("title".to_string(), row.title);
        map.insert("content".to_string(), row.content);
        map.insert(
            "is_sensitive".to_string(),
            row.is_sensitive
                .map(|is_sensitive| is_sensitive.to_string()),
        );

        let paint_duration = Duration::try_seconds(row.paint_duration.microseconds / 1000000)
            .unwrap()
            .to_std()
            .unwrap();
        let paint_duration_human_readable = format_duration(paint_duration);
        map.insert(
            "paint_duration".to_string(),
            Some(paint_duration_human_readable.to_string()),
        );

        map.insert("image_id".to_string(), Some(row.image_id.to_string()));
        map.insert("image_tool".to_string(), Some(row.image_tool.unwrap()));
        map.insert("image_width".to_string(), Some(row.width.to_string()));
        map.insert("image_height".to_string(), Some(row.height.to_string()));
        map.insert("image_filename".to_string(), Some(row.image_filename));
        map.insert("replay_filename".to_string(), Some(row.replay_filename));
        map.insert(
            "viewer_count".to_string(),
            Some(row.viewer_count.to_string()),
        );
        map.insert("allow_relay".to_string(), Some(row.allow_relay.to_string()));

        let created_at_seoul = row.created_at.with_timezone(&Seoul);
        let created_at_human_readable = created_at_seoul.format("%Y-%m-%d %H:%M").to_string();
        map.insert("created_at".to_string(), Some(created_at_human_readable));

        match row.published_at {
            None => {
                map.insert("published_at".to_string(), None);
            }
            Some(published_at) => {
                let published_at_seoul = published_at.with_timezone(&Seoul);
                let published_at_human_readable =
                    published_at_seoul.format("%Y-%m-%d %H:%M").to_string();
                map.insert(
                    "published_at".to_string(),
                    Some(published_at_human_readable),
                );
            }
        }

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
        map.insert(
            "parent_post_id".to_string(),
            row.parent_post_id.map(|id| id.to_string()),
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
    allow_relay: bool,
) -> Result<()> {
    let q = query!(
        "
            UPDATE posts
            SET
                published_at = now(),
                title = $1,
                content = $2,
                is_sensitive = $3,
                allow_relay = $4
            WHERE id = $5
        ",
        title,
        content,
        is_sensitive,
        allow_relay,
        id
    );
    q.execute(&mut **tx).await?;
    Ok(())
}

pub async fn edit_post(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    title: String,
    content: String,
    is_sensitive: bool,
    allow_relay: bool,
) -> Result<()> {
    let q = query!(
        "
            UPDATE posts
            SET
                title = $1,
                content = $2,
                is_sensitive = $3,
                allow_relay = $4
            WHERE id = $5
        ",
        title,
        content,
        is_sensitive,
        allow_relay,
        id
    );
    q.execute(&mut **tx).await?;
    Ok(())
}

pub async fn edit_post_community(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    new_community_id: Uuid,
) -> Result<()> {
    let q = query!(
        "
            UPDATE posts
            SET community_id = $1
            WHERE id = $2
        ",
        new_community_id,
        id
    );
    q.execute(&mut **tx).await?;
    Ok(())
}

pub async fn find_public_community_posts(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<Vec<SerializablePostForHome>> {
    let q = query!(
        "
            SELECT
                posts.id,
                posts.title,
                posts.author_id,
                images.paint_duration,
                images.stroke_count,
                images.image_filename,
                images.width,
                images.height,
                images.replay_filename,
                posts.viewer_count,
                posts.is_sensitive,
                posts.published_at,
                posts.created_at,
                posts.updated_at
            FROM posts
            LEFT JOIN images ON posts.image_id = images.id
            LEFT JOIN communities ON posts.community_id = communities.id
            WHERE communities.is_private = FALSE
            AND posts.published_at IS NOT NULL
            AND posts.deleted_at IS NULL
            ORDER BY posts.published_at DESC
        "
    );
    let result = q.fetch_all(&mut **tx).await?;
    Ok(result
        .into_iter()
        .map(|row| SerializablePostForHome {
            id: BASE64URL_NOPAD.encode(row.id.as_bytes()),
            title: row.title,
            author_id: row.author_id,
            paint_duration: row.paint_duration.microseconds.to_string(),
            stroke_count: row.stroke_count,
            image_filename: row.image_filename,
            image_width: row.width,
            image_height: row.height,
            replay_filename: row.replay_filename,
            is_sensitive: row.is_sensitive.unwrap_or(false),
            viewer_count: row.viewer_count,
            published_at: row.published_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
        .collect())
}

pub async fn find_public_community_posts_excluding_from_community_owner(
    tx: &mut Transaction<'_, Postgres>,
    community_owner_id: Uuid,
) -> Result<Vec<SerializablePostForHome>> {
    let q = query!(
        "
            SELECT
                posts.id,
                posts.title,
                posts.author_id,
                images.paint_duration,
                images.stroke_count,
                images.image_filename,
                images.width,
                images.height,
                images.replay_filename,
                posts.viewer_count,
                posts.is_sensitive,
                posts.published_at,
                posts.created_at,
                posts.updated_at
            FROM posts
            LEFT JOIN images ON posts.image_id = images.id
            LEFT JOIN communities ON posts.community_id = communities.id
            WHERE communities.is_private = FALSE
            AND posts.published_at IS NOT NULL
            AND posts.deleted_at IS NULL
            AND communities.owner_id != $1
            ORDER BY posts.published_at DESC
            LIMIT 9
        ",
        community_owner_id
    );
    let result = q.fetch_all(&mut **tx).await?;
    Ok(result
        .into_iter()
        .map(|row| SerializablePostForHome {
            id: BASE64URL_NOPAD.encode(row.id.as_bytes()),
            title: row.title,
            author_id: row.author_id,
            paint_duration: row.paint_duration.microseconds.to_string(),
            stroke_count: row.stroke_count,
            image_filename: row.image_filename,
            image_width: row.width,
            image_height: row.height,
            replay_filename: row.replay_filename,
            is_sensitive: row.is_sensitive.unwrap_or(false),
            viewer_count: row.viewer_count,
            published_at: row.published_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
        .collect())
}

pub async fn find_following_posts_by_user_id(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<Vec<SerializablePost>> {
    let q = query!(
        "
            SELECT
                posts.id,
                posts.title,
                posts.author_id,
                images.paint_duration,
                images.stroke_count,
                images.image_filename,
                images.width,
                images.height,
                images.replay_filename,
                posts.viewer_count,
                posts.published_at,
                posts.created_at,
                posts.updated_at
            FROM posts
            LEFT JOIN images ON posts.image_id = images.id
            LEFT JOIN follows ON posts.author_id = follows.following_id
            LEFT JOIN communities ON posts.community_id = communities.id
            WHERE follows.follower_id = $1
            AND communities.is_private = FALSE
            AND posts.published_at IS NOT NULL
            AND posts.deleted_at IS NULL
            ORDER BY posts.published_at DESC
        ",
        user_id
    );
    let result = q.fetch_all(&mut **tx).await?;
    Ok(result
        .into_iter()
        .map(|row| SerializablePost {
            id: BASE64URL_NOPAD.encode(row.id.as_bytes()),
            title: row.title,
            author_id: row.author_id,
            paint_duration: row.paint_duration.microseconds.to_string(),
            stroke_count: row.stroke_count,
            image_filename: row.image_filename,
            image_width: row.width,
            image_height: row.height,
            replay_filename: row.replay_filename,
            viewer_count: row.viewer_count,
            published_at: row.published_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
        .collect())
}

pub async fn delete_post(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<()> {
    let q = query!(
        "
        UPDATE posts
        SET
            deleted_at = now(),
            title = NULL,
            content = NULL,
            is_sensitive = NULL
        WHERE id = $1
        RETURNING image_id
    ",
        id
    )
    .fetch_one(&mut **tx)
    .await?;

    println!("image_id: {:?}", q.image_id);

    query!(
        "
        UPDATE images
        SET deleted_at = now()
        WHERE id = $1
        ",
        q.image_id
    )
    .execute(&mut **tx)
    .await?;

    Ok(())
}
