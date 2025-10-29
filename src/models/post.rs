use anyhow::Result;
use chrono::{DateTime, Duration, Utc};
use chrono_tz::Asia::Seoul;
use humantime::format_duration;
use serde::{Deserialize, Serialize};
use sqlx::Type;
use sqlx::{postgres::types::PgInterval, query, Postgres, Transaction};
use std::collections::HashMap;
use uuid::Uuid;

use super::community::CommunityVisibility;

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
    pub id: Uuid,
    pub title: Option<String>,
    pub author_id: Uuid,
    pub user_login_name: Option<String>,
    pub paint_duration: String,
    pub stroke_count: i32,
    pub viewer_count: i32,
    pub image_filename: String,
    pub image_width: i32,
    pub image_height: i32,
    pub replay_filename: Option<String>,
    pub is_sensitive: Option<bool>,
    pub published_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct SerializableProfilePost {
    pub id: Uuid,
    pub title: Option<String>,
    pub author_id: Uuid,
    pub paint_duration: String,
    pub stroke_count: i32,
    pub viewer_count: i32,
    pub image_filename: String,
    pub image_width: i32,
    pub image_height: i32,
    pub replay_filename: Option<String>,
    pub published_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub community_visibility: CommunityVisibility,
}

#[derive(Serialize)]
pub struct SerializablePostForHome {
    pub id: Uuid,
    pub title: Option<String>,
    pub author_id: Uuid,
    pub user_login_name: String,
    pub paint_duration: String,
    pub stroke_count: i32,
    pub viewer_count: i32,
    pub image_filename: String,
    pub image_width: i32,
    pub image_height: i32,
    pub replay_filename: Option<String>,
    pub is_sensitive: bool,
    pub published_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct SerializableDraftPost {
    pub id: Uuid,
    pub title: Option<String>,
    pub content: Option<String>,
    pub community_id: Uuid,
    pub community_name: String,
    pub image_filename: String,
    pub image_width: i32,
    pub image_height: i32,
    pub updated_at: DateTime<Utc>,
}

// Minimal structs for post thumbnails (grid/list views)
#[derive(Serialize)]
pub struct PostThumbnail {
    pub id: Uuid,
    pub image_filename: String,
    pub image_width: i32,
    pub image_height: i32,
}

#[derive(Serialize)]
pub struct PostThumbnailWithSensitivity {
    pub id: Uuid,
    pub image_filename: String,
    pub image_width: i32,
    pub image_height: i32,
    pub is_sensitive: bool,
}

#[derive(Serialize)]
pub struct SerializableThreadedPost {
    pub id: Uuid,
    pub title: Option<String>,
    pub content: Option<String>,
    pub author_id: Uuid,
    pub user_login_name: String,
    pub user_display_name: String,
    pub user_actor_handle: String,
    pub image_filename: String,
    pub image_width: i32,
    pub image_height: i32,
    pub published_at: Option<DateTime<Utc>>,
    pub published_at_formatted: Option<String>,
    pub comments_count: i64,
    pub children: Vec<SerializableThreadedPost>,
}

impl Post {
    pub fn path(&self) -> String {
        format!("/posts/{}", self.id)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Type)]
#[sqlx(type_name = "tool", rename_all = "kebab-case")]
pub enum Tool {
    Neo,
    Tegaki,
    Cucumber,
    #[serde(rename = "neo-cucumber")]
    #[sqlx(rename = "neo-cucumber")]
    NeoCucumber,
}

pub struct PostDraft {
    pub author_id: Uuid,
    pub community_id: Uuid,
    pub paint_duration: PgInterval,
    pub stroke_count: i32,
    pub width: i32,
    pub height: i32,
    pub image_filename: String,
    pub replay_filename: Option<String>,
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
            id: row.id,
            title: row.title,
            author_id: row.author_id,
            user_login_name: None,
            paint_duration: row.paint_duration.microseconds.to_string(),
            stroke_count: row.stroke_count,
            image_filename: row.image_filename,
            image_width: row.width,
            image_height: row.height,
            replay_filename: row.replay_filename,
            is_sensitive: None,
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
    limit: i64,
    offset: i64,
) -> Result<Vec<SerializableProfilePost>> {
    let q = query!(
        r#"
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
                communities.visibility as "visibility: CommunityVisibility"
            FROM posts
            LEFT JOIN images ON posts.image_id = images.id
            LEFT JOIN communities ON posts.community_id = communities.id
            WHERE author_id = $1
            AND communities.visibility = 'public'
            AND published_at IS NOT NULL
            AND posts.deleted_at IS NULL
            ORDER BY published_at DESC
            LIMIT $2 OFFSET $3
        "#,
        author_id,
        limit,
        offset
    );
    let result = q.fetch_all(&mut **tx).await?;
    Ok(result
        .into_iter()
        .map(|row| SerializableProfilePost {
            id: row.id,
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
            community_visibility: row.visibility,
        })
        .collect())
}

pub async fn find_published_posts_by_author_id(
    tx: &mut Transaction<'_, Postgres>,
    author_id: Uuid,
) -> Result<Vec<SerializableProfilePost>> {
    let q = query!(
        r#"
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
                communities.visibility as "visibility: CommunityVisibility"
            FROM posts
            LEFT JOIN images ON posts.image_id = images.id
            LEFT JOIN communities ON posts.community_id = communities.id
            WHERE author_id = $1
            AND published_at IS NOT NULL
            AND posts.deleted_at IS NULL
            ORDER BY published_at DESC
        "#,
        author_id
    );
    let result = q.fetch_all(&mut **tx).await?;
    Ok(result
        .into_iter()
        .map(|row| SerializableProfilePost {
            id: row.id,
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
            community_visibility: row.visibility,
        })
        .collect())
}

pub async fn find_draft_posts_by_author_id(
    tx: &mut Transaction<'_, Postgres>,
    author_id: Uuid,
) -> Result<Vec<SerializableDraftPost>> {
    let result = query!(
        "
            SELECT
                posts.id,
                posts.title,
                posts.content,
                posts.community_id,
                posts.updated_at,
                images.image_filename,
                images.width,
                images.height,
                communities.name as community_name
            FROM posts
            LEFT JOIN images ON posts.image_id = images.id
            LEFT JOIN communities ON posts.community_id = communities.id
            WHERE posts.author_id = $1
            AND posts.published_at IS NULL
            AND posts.deleted_at IS NULL
            ORDER BY posts.updated_at DESC
        ",
        author_id
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(result
        .into_iter()
        .map(|row| SerializableDraftPost {
            id: row.id,
            title: row.title,
            content: row.content,
            community_id: row.community_id,
            community_name: row.community_name,
            image_filename: row.image_filename,
            image_width: row.width,
            image_height: row.height,
            updated_at: row.updated_at,
        })
        .collect())
}

pub async fn find_published_posts_by_community_id(
    tx: &mut Transaction<'_, Postgres>,
    community_id: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<SerializablePost>> {
    let q = query!(
        "
            SELECT
                posts.id,
                posts.title,
                posts.author_id,
                users.login_name,
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
            LEFT JOIN users ON posts.author_id = users.id
            WHERE community_id = $1
            AND published_at IS NOT NULL
            AND posts.deleted_at IS NULL
            ORDER BY published_at DESC
            LIMIT $2 OFFSET $3
        ",
        community_id,
        limit,
        offset
    );
    let result = q.fetch_all(&mut **tx).await?;
    Ok(result
        .into_iter()
        .map(|row| SerializablePost {
            id: row.id,
            title: row.title,
            author_id: row.author_id,
            user_login_name: Some(row.login_name),
            paint_duration: row.paint_duration.microseconds.to_string(),
            stroke_count: row.stroke_count,
            image_filename: row.image_filename,
            image_width: row.width,
            image_height: row.height,
            replay_filename: row.replay_filename,
            is_sensitive: row.is_sensitive,
            viewer_count: row.viewer_count,
            published_at: row.published_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
        .collect())
}

/// Struct for recent post thumbnails in community cards
pub struct CommunityRecentPost {
    pub id: Uuid,
    pub community_id: Uuid,
    pub image_filename: String,
    pub image_width: i32,
    pub image_height: i32,
    pub author_login_name: String,
    pub title: Option<String>,
    pub paint_duration: Option<String>,
    pub stroke_count: Option<i32>,
    pub viewer_count: Option<i32>,
    pub published_at: Option<DateTime<Utc>>,
}

/// Fetch recent posts (up to `limit` per community) for multiple communities
pub async fn find_recent_posts_by_communities(
    tx: &mut Transaction<'_, Postgres>,
    community_ids: &[Uuid],
    limit: i64,
) -> Result<Vec<CommunityRecentPost>> {
    if community_ids.is_empty() {
        return Ok(Vec::new());
    }

    let result = sqlx::query!(
        r#"
        SELECT
            ranked.id,
            ranked.community_id,
            ranked.image_filename,
            ranked.image_width,
            ranked.image_height,
            ranked.author_login_name,
            ranked.title,
            ranked.paint_duration,
            ranked.stroke_count,
            ranked.viewer_count,
            ranked.published_at
        FROM (
            SELECT
                p.id,
                p.community_id,
                i.image_filename,
                i.width as image_width,
                i.height as image_height,
                u.login_name as author_login_name,
                p.title,
                i.paint_duration,
                i.stroke_count,
                p.viewer_count,
                p.published_at,
                ROW_NUMBER() OVER (PARTITION BY p.community_id ORDER BY p.published_at DESC) as rn
            FROM posts p
            INNER JOIN images i ON p.image_id = i.id
            INNER JOIN users u ON p.author_id = u.id
            WHERE p.community_id = ANY($1)
                AND p.published_at IS NOT NULL
                AND p.deleted_at IS NULL
        ) ranked
        WHERE ranked.rn <= $2
        ORDER BY ranked.community_id, ranked.rn
        "#,
        community_ids,
        limit
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(result
        .into_iter()
        .map(|row| CommunityRecentPost {
            id: row.id,
            community_id: row.community_id,
            image_filename: row.image_filename,
            image_width: row.image_width,
            image_height: row.image_height,
            author_login_name: row.author_login_name,
            title: row.title,
            paint_duration: Some(row.paint_duration.microseconds.to_string()),
            stroke_count: Some(row.stroke_count),
            viewer_count: Some(row.viewer_count),
            published_at: row.published_at,
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
        id: post.id,
        title: None,
        author_id: post_draft.author_id,
        user_login_name: None,
        paint_duration: post_draft.paint_duration.microseconds.to_string(),
        stroke_count: post_draft.stroke_count,
        image_filename: post_draft.image_filename,
        image_width: post_draft.width,
        image_height: post_draft.height,
        replay_filename: post_draft.replay_filename,
        is_sensitive: None,
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
                communities.name AS community_name,
                communities.slug AS community_slug
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
        map.insert("replay_filename".to_string(), row.replay_filename);
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

                // Insert UTC published_at time with timezone
                map.insert(
                    "published_at_utc".to_string(),
                    Some(published_at.to_rfc3339()),
                );
            }
        }

        let updated_at_seoul = row.updated_at.with_timezone(&Seoul);
        let updated_at_human_readable = updated_at_seoul.format("%Y-%m-%d %H:%M").to_string();
        map.insert("updated_at".to_string(), Some(updated_at_human_readable));

        // Insert UTC updated_at time with timezone
        map.insert(
            "updated_at_utc".to_string(),
            Some(row.updated_at.to_rfc3339()),
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
            "community_slug".to_string(),
            Some(row.community_slug.to_string()),
        );
        map.insert(
            "parent_post_id".to_string(),
            row.parent_post_id.map(|id| id.to_string()),
        );
        map
    }))
}

pub async fn find_child_posts_by_parent_id(
    tx: &mut Transaction<'_, Postgres>,
    parent_post_id: Uuid,
) -> Result<Vec<SerializableThreadedPost>> {
    let q = query!(
        "
            SELECT
                posts.id,
                posts.title,
                posts.content,
                posts.author_id,
                users.login_name,
                users.display_name,
                actors.handle as actor_handle,
                images.image_filename,
                images.width,
                images.height,
                posts.published_at
            FROM posts
            LEFT JOIN images ON posts.image_id = images.id
            LEFT JOIN users ON posts.author_id = users.id
            LEFT JOIN actors ON actors.user_id = users.id
            WHERE posts.parent_post_id = $1
            AND posts.published_at IS NOT NULL
            AND posts.deleted_at IS NULL
            ORDER BY posts.published_at ASC
        ",
        parent_post_id
    );
    let result = q.fetch_all(&mut **tx).await?;

    Ok(result
        .into_iter()
        .map(|row| {
            // Format the published_at date
            let published_at_formatted = row.published_at.as_ref().map(|dt| {
                use chrono::TimeZone;
                let seoul = chrono_tz::Asia::Seoul;
                let seoul_time = seoul.from_utc_datetime(&dt.naive_utc());
                seoul_time.format("%Y-%m-%d %H:%M").to_string()
            });

            SerializableThreadedPost {
                id: row.id,
                title: row.title,
                content: row.content,
                author_id: row.author_id,
                user_login_name: row.login_name,
                user_display_name: row.display_name,
                user_actor_handle: row.actor_handle,
                image_filename: row.image_filename,
                image_width: row.width,
                image_height: row.height,
                published_at: row.published_at,
                published_at_formatted,
                comments_count: 0, // Will be populated by build_thread_tree
                children: Vec::new(), // Will be populated by build_thread_tree
            }
        })
        .collect())
}

pub async fn build_thread_tree(
    tx: &mut Transaction<'_, Postgres>,
    parent_post_id: Uuid,
) -> Result<Vec<SerializableThreadedPost>> {
    use std::collections::HashMap;

    // Use recursive CTE to fetch all descendants in a single query
    let rows = query!(
        r#"
            WITH RECURSIVE post_tree AS (
                -- Base case: direct children
                SELECT
                    posts.id,
                    posts.title,
                    posts.content,
                    posts.author_id,
                    posts.parent_post_id,
                    users.login_name,
                    users.display_name,
                    actors.handle as actor_handle,
                    images.image_filename,
                    images.width,
                    images.height,
                    posts.published_at,
                    COALESCE(comment_counts.count, 0) as comments_count
                FROM posts
                LEFT JOIN images ON posts.image_id = images.id
                LEFT JOIN users ON posts.author_id = users.id
                LEFT JOIN actors ON actors.user_id = users.id
                LEFT JOIN (
                    SELECT post_id, COUNT(*) as count
                    FROM comments
                    GROUP BY post_id
                ) comment_counts ON posts.id = comment_counts.post_id
                WHERE posts.parent_post_id = $1
                AND posts.published_at IS NOT NULL
                AND posts.deleted_at IS NULL

                UNION ALL

                -- Recursive case: children of children
                SELECT
                    p.id,
                    p.title,
                    p.content,
                    p.author_id,
                    p.parent_post_id,
                    u.login_name,
                    u.display_name,
                    a.handle as actor_handle,
                    i.image_filename,
                    i.width,
                    i.height,
                    p.published_at,
                    COALESCE(cc.count, 0) as comments_count
                FROM posts p
                LEFT JOIN images i ON p.image_id = i.id
                LEFT JOIN users u ON p.author_id = u.id
                LEFT JOIN actors a ON a.user_id = u.id
                LEFT JOIN (
                    SELECT post_id, COUNT(*) as count
                    FROM comments
                    GROUP BY post_id
                ) cc ON p.id = cc.post_id
                INNER JOIN post_tree pt ON p.parent_post_id = pt.id
                WHERE p.published_at IS NOT NULL
                AND p.deleted_at IS NULL
            )
            SELECT * FROM post_tree
            ORDER BY published_at ASC
        "#,
        parent_post_id
    )
    .fetch_all(&mut **tx)
    .await?;

    if rows.is_empty() {
        return Ok(Vec::new());
    }

    // Build a map to track children for each parent
    let mut children_map: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    let mut post_data: HashMap<Uuid, (Option<String>, Option<String>, Uuid, String, String, String, String, i32, i32, Option<chrono::DateTime<chrono::Utc>>, i64)> = HashMap::new();

    for row in &rows {
        // Skip posts with missing required data
        let Some(id) = row.id else { continue };
        let Some(author_id) = row.author_id else { continue };
        let Some(login_name) = &row.login_name else { continue };
        let Some(display_name) = &row.display_name else { continue };
        let Some(actor_handle) = &row.actor_handle else { continue };
        let Some(image_filename) = &row.image_filename else { continue };
        let Some(width) = row.width else { continue };
        let Some(height) = row.height else { continue };
        let Some(comments_count) = row.comments_count else { continue };

        post_data.insert(
            id,
            (
                row.title.clone(),
                row.content.clone(),
                author_id,
                login_name.clone(),
                display_name.clone(),
                actor_handle.clone(),
                image_filename.clone(),
                width,
                height,
                row.published_at,
                comments_count,
            ),
        );

        if let Some(parent_id) = row.parent_post_id {
            children_map.entry(parent_id).or_insert_with(Vec::new).push(id);
        }
    }

    // Recursive function to build tree for a given post ID
    fn build_subtree(
        post_id: Uuid,
        post_data: &HashMap<Uuid, (Option<String>, Option<String>, Uuid, String, String, String, String, i32, i32, Option<chrono::DateTime<chrono::Utc>>, i64)>,
        children_map: &HashMap<Uuid, Vec<Uuid>>,
    ) -> Option<SerializableThreadedPost> {
        let (title, content, author_id, login_name, display_name, actor_handle, image_filename, width, height, published_at, comments_count) = post_data.get(&post_id)?;

        // Format the published_at date
        let published_at_formatted = published_at.as_ref().map(|dt| {
            use chrono::TimeZone;
            let seoul = chrono_tz::Asia::Seoul;
            let seoul_time = seoul.from_utc_datetime(&dt.naive_utc());
            seoul_time.format("%Y-%m-%d %H:%M").to_string()
        });

        let children = children_map
            .get(&post_id)
            .map(|child_ids| {
                child_ids
                    .iter()
                    .filter_map(|child_id| build_subtree(*child_id, post_data, children_map))
                    .collect()
            })
            .unwrap_or_default();

        Some(SerializableThreadedPost {
            id: post_id,
            title: title.clone(),
            content: content.clone(),
            author_id: *author_id,
            user_login_name: login_name.clone(),
            user_display_name: display_name.clone(),
            user_actor_handle: actor_handle.clone(),
            image_filename: image_filename.clone(),
            image_width: *width,
            image_height: *height,
            published_at: *published_at,
            published_at_formatted,
            comments_count: *comments_count,
            children,
        })
    }

    // Build trees for all root posts (direct children of parent_post_id)
    let result: Vec<SerializableThreadedPost> = rows
        .iter()
        .filter_map(|row| {
            let id = row.id?;
            if row.parent_post_id == Some(parent_post_id) {
                build_subtree(id, &post_data, &children_map)
            } else {
                None
            }
        })
        .collect();

    Ok(result)
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
    // Use a recursive CTE to update the post and all its descendants
    let q = query!(
        r#"
            WITH RECURSIVE post_tree AS (
                -- Base case: the root post being moved
                SELECT id
                FROM posts
                WHERE id = $2

                UNION ALL

                -- Recursive case: all child posts
                SELECT p.id
                FROM posts p
                INNER JOIN post_tree pt ON p.parent_post_id = pt.id
            )
            UPDATE posts
            SET community_id = $1
            WHERE id IN (SELECT id FROM post_tree)
        "#,
        new_community_id,
        id
    );
    q.execute(&mut **tx).await?;
    Ok(())
}

pub async fn find_public_community_posts(
    tx: &mut Transaction<'_, Postgres>,
    limit: i64,
    offset: i64,
) -> Result<Vec<SerializablePostForHome>> {
    let q = query!(
        "
            SELECT
                posts.id,
                posts.title,
                posts.author_id,
                users.login_name,
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
            LEFT JOIN users ON posts.author_id = users.id
            WHERE communities.visibility = 'public'
            AND posts.published_at IS NOT NULL
            AND posts.deleted_at IS NULL
            ORDER BY posts.published_at DESC
            LIMIT $1
            OFFSET $2
        ",
        limit,
        offset
    );
    let result = q.fetch_all(&mut **tx).await?;
    Ok(result
        .into_iter()
        .map(|row| SerializablePostForHome {
            id: row.id,
            title: row.title,
            author_id: row.author_id,
            user_login_name: row.login_name,
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
    limit: i64,
    offset: i64,
) -> Result<Vec<SerializablePostForHome>> {
    let q = query!(
        "
            SELECT
                posts.id,
                posts.title,
                posts.author_id,
                users.login_name,
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
            LEFT JOIN users ON posts.author_id = users.id
            WHERE communities.visibility = 'public'
            AND posts.published_at IS NOT NULL
            AND posts.deleted_at IS NULL
            AND communities.owner_id != $1
            ORDER BY posts.published_at DESC
            LIMIT $2
            OFFSET $3
        ",
        community_owner_id,
        limit,
        offset
    );
    let result = q.fetch_all(&mut **tx).await?;
    Ok(result
        .into_iter()
        .map(|row| SerializablePostForHome {
            id: row.id,
            title: row.title,
            author_id: row.author_id,
            user_login_name: row.login_name,
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
                users.login_name,
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
            LEFT JOIN users ON posts.author_id = users.id
            LEFT JOIN actors author_actor ON posts.author_id = author_actor.user_id
            LEFT JOIN follows ON author_actor.id = follows.following_actor_id
            LEFT JOIN actors follower_actor ON follows.follower_actor_id = follower_actor.id
            LEFT JOIN communities ON posts.community_id = communities.id
            WHERE follower_actor.user_id = $1
            AND communities.visibility = 'public'
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
            id: row.id,
            title: row.title,
            author_id: row.author_id,
            user_login_name: Some(row.login_name),
            paint_duration: row.paint_duration.microseconds.to_string(),
            stroke_count: row.stroke_count,
            image_filename: row.image_filename,
            image_width: row.width,
            image_height: row.height,
            replay_filename: row.replay_filename,
            is_sensitive: row.is_sensitive,
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

pub async fn delete_post_with_activity(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    app_state: Option<&crate::web::state::AppState>,
) -> Result<()> {
    // First, get post details before deletion
    let post = find_post_by_id(tx, id).await?;
    let post = match post {
        Some(post) => post,
        None => return Err(anyhow::anyhow!("Post not found")),
    };

    // Get the author's actor
    let author_id_str = post
        .get("author_id")
        .and_then(|v| v.as_ref())
        .ok_or_else(|| anyhow::anyhow!("Post has no author"))?;
    let author_id = uuid::Uuid::parse_str(author_id_str)?;

    // Perform the deletion
    delete_post(tx, id).await?;

    // If app_state is provided, send ActivityPub Delete activity
    if let Some(state) = app_state {
        // Get the author's actor
        if let Some(author_actor) =
            crate::models::actor::Actor::find_by_user_id(tx, author_id).await?
        {
            // Create the object URL that was deleted
            let object_url = format!("https://{}/ap/posts/{}", state.config.domain, id);
            let object_url = object_url.parse()?;

            // Send Delete activity - don't fail if this fails
            if let Err(e) = crate::web::handlers::activitypub::send_delete_activity(
                &author_actor,
                object_url,
                state,
            )
            .await
            {
                tracing::warn!("Failed to send Delete activity for post {}: {:?}", id, e);
            }
        }
    }

    Ok(())
}
