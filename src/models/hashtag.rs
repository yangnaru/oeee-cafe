use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize)]
pub struct Hashtag {
    pub id: Uuid,
    pub name: String,
    pub display_name: String,
    pub post_count: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Parse hashtag input from user (comma or space-separated)
/// Returns normalized (lowercase, trimmed, hyphens converted to underscores) hashtag names with original display names
pub fn parse_hashtag_input(input: &str) -> Vec<(String, String)> {
    input
        .split(|c| c == ',' || c == ' ')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| {
            // Convert hyphens to underscores, then normalize to lowercase
            let normalized = s.replace('-', "_").to_lowercase();
            // Also replace hyphens in display name
            let display = s.replace('-', "_");
            (normalized, display)
        })
        .collect()
}

/// Find existing hashtag by name or create a new one
pub async fn find_or_create_hashtag(
    tx: &mut Transaction<'_, Postgres>,
    name: &str,
    display_name: &str,
) -> Result<Hashtag> {
    // Try to find existing hashtag
    let existing = sqlx::query_as!(
        Hashtag,
        r#"
        SELECT id, name, display_name, post_count, created_at, updated_at
        FROM hashtags
        WHERE name = $1
        "#,
        name
    )
    .fetch_optional(&mut **tx)
    .await?;

    if let Some(hashtag) = existing {
        Ok(hashtag)
    } else {
        // Create new hashtag
        let hashtag = sqlx::query_as!(
            Hashtag,
            r#"
            INSERT INTO hashtags (name, display_name)
            VALUES ($1, $2)
            RETURNING id, name, display_name, post_count, created_at, updated_at
            "#,
            name,
            display_name
        )
        .fetch_one(&mut **tx)
        .await?;
        Ok(hashtag)
    }
}

/// Link a post to multiple hashtags and increment their post_counts
pub async fn link_post_to_hashtags(
    tx: &mut Transaction<'_, Postgres>,
    post_id: Uuid,
    hashtag_names: &[(String, String)], // (normalized_name, display_name) tuples
) -> Result<()> {
    for (name, display_name) in hashtag_names {
        // Find or create hashtag
        let hashtag = find_or_create_hashtag(tx, name, display_name).await?;

        // Create post_hashtags association (ignore if already exists)
        let _ = sqlx::query!(
            r#"
            INSERT INTO post_hashtags (post_id, hashtag_id)
            VALUES ($1, $2)
            ON CONFLICT (post_id, hashtag_id) DO NOTHING
            "#,
            post_id,
            hashtag.id
        )
        .execute(&mut **tx)
        .await;

        // Increment post_count
        sqlx::query!(
            r#"
            UPDATE hashtags
            SET post_count = post_count + 1, updated_at = NOW()
            WHERE id = $1
            "#,
            hashtag.id
        )
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// Remove all hashtag associations for a post and decrement post_counts
pub async fn unlink_post_hashtags(tx: &mut Transaction<'_, Postgres>, post_id: Uuid) -> Result<()> {
    // Get all hashtags for this post
    let hashtag_ids: Vec<Uuid> = sqlx::query!(
        r#"
        SELECT hashtag_id FROM post_hashtags WHERE post_id = $1
        "#,
        post_id
    )
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .map(|row| row.hashtag_id)
    .collect();

    // Delete post_hashtags associations
    sqlx::query!(
        r#"
        DELETE FROM post_hashtags WHERE post_id = $1
        "#,
        post_id
    )
    .execute(&mut **tx)
    .await?;

    // Decrement post_count for each hashtag
    for hashtag_id in hashtag_ids {
        sqlx::query!(
            r#"
            UPDATE hashtags
            SET post_count = GREATEST(post_count - 1, 0), updated_at = NOW()
            WHERE id = $1
            "#,
            hashtag_id
        )
        .execute(&mut **tx)
        .await?;
    }

    Ok(())
}

/// Get all hashtags for a post
pub async fn get_hashtags_for_post(
    tx: &mut Transaction<'_, Postgres>,
    post_id: Uuid,
) -> Result<Vec<Hashtag>> {
    let hashtags = sqlx::query_as!(
        Hashtag,
        r#"
        SELECT h.id, h.name, h.display_name, h.post_count, h.created_at, h.updated_at
        FROM hashtags h
        JOIN post_hashtags ph ON h.id = ph.hashtag_id
        WHERE ph.post_id = $1
        ORDER BY ph.created_at ASC
        "#,
        post_id
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(hashtags)
}

/// Find posts by hashtag name (for hashtag view page)
/// Only returns posts from public communities
pub async fn find_posts_by_hashtag(
    tx: &mut Transaction<'_, Postgres>,
    hashtag_name: &str,
    limit: i64,
) -> Result<Vec<crate::models::post::SerializablePost>> {
    let posts = sqlx::query!(
        r#"
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
        JOIN post_hashtags ph ON posts.id = ph.post_id
        JOIN hashtags h ON ph.hashtag_id = h.id
        JOIN communities c ON posts.community_id = c.id
        LEFT JOIN images ON posts.image_id = images.id
        LEFT JOIN users ON posts.author_id = users.id
        WHERE h.name = $1
        AND posts.published_at IS NOT NULL
        AND posts.deleted_at IS NULL
        AND c.is_private = false
        ORDER BY posts.published_at DESC
        LIMIT $2
        "#,
        hashtag_name,
        limit
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(posts
        .into_iter()
        .map(|row| crate::models::post::SerializablePost {
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

/// Search hashtags for autocomplete (prefix match)
pub async fn search_hashtags(
    tx: &mut Transaction<'_, Postgres>,
    query: &str,
    limit: i64,
) -> Result<Vec<Hashtag>> {
    let search_pattern = format!("{}%", query.to_lowercase());
    let hashtags = sqlx::query_as!(
        Hashtag,
        r#"
        SELECT id, name, display_name, post_count, created_at, updated_at
        FROM hashtags
        WHERE name LIKE $1
        ORDER BY post_count DESC, name ASC
        LIMIT $2
        "#,
        search_pattern,
        limit
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(hashtags)
}

/// Get trending hashtags using a time-decay algorithm
/// Score = log10(post_count) - (age_in_hours / 24)
/// This favors hashtags that are both popular AND recent
pub async fn get_trending_hashtags(
    tx: &mut Transaction<'_, Postgres>,
    limit: i64,
) -> Result<Vec<Hashtag>> {
    let hashtags = sqlx::query_as!(
        Hashtag,
        r#"
        SELECT id, name, display_name, post_count, created_at, updated_at
        FROM hashtags
        WHERE post_count > 0
        ORDER BY
            -- Trending score: popularity + recency bonus
            -- Recent activity (posts in last 7 days) gets a significant boost
            CASE
                WHEN updated_at > NOW() - INTERVAL '7 days' THEN
                    log(GREATEST(post_count, 1)) * 10 +
                    (1.0 - EXTRACT(EPOCH FROM (NOW() - updated_at)) / (7 * 24 * 3600)) * 5
                ELSE
                    log(GREATEST(post_count, 1)) * 10
            END DESC,
            updated_at DESC
        LIMIT $1
        "#,
        limit
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(hashtags)
}

/// Get hashtag by name
pub async fn find_hashtag_by_name(
    tx: &mut Transaction<'_, Postgres>,
    name: &str,
) -> Result<Option<Hashtag>> {
    let hashtag = sqlx::query_as!(
        Hashtag,
        r#"
        SELECT id, name, display_name, post_count, created_at, updated_at
        FROM hashtags
        WHERE name = $1
        "#,
        name
    )
    .fetch_optional(&mut **tx)
    .await?;
    Ok(hashtag)
}
