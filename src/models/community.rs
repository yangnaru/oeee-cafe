use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::query;
use sqlx::query_as;
use sqlx::Postgres;
use sqlx::Transaction;
use uuid::Uuid;

use super::post::SerializablePost;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Community {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub is_private: bool,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub background_color: Option<String>,
    pub foreground_color: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct PublicCommunity {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub owner_login_name: String,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub is_private: bool,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub posts_count: Option<i64>,
    pub background_color: Option<String>,
    pub foreground_color: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct PublicCommunityWithPosts {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub owner_login_name: String,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub is_private: bool,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub posts: Vec<SerializablePost>,
}

impl Community {
    pub fn get_url(&self) -> String {
        format!("/communities/@{}", self.slug)
    }
}

pub struct CommunityDraft {
    pub name: String,
    pub slug: String,
    pub description: String,
    pub is_private: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct CommunityStats {
    pub total_posts: i64,
    pub total_contributors: i64,
    pub total_comments: i64,
}

pub async fn get_own_communities(
    tx: &mut Transaction<'_, Postgres>,
    owner_id: Uuid,
) -> Result<Vec<Community>> {
    let q = query_as!(
        Community,
        "SELECT id, owner_id, name, slug, description, is_private, updated_at, created_at, background_color, foreground_color FROM communities WHERE owner_id = $1",
        owner_id
    );

    Ok(q.fetch_all(&mut **tx).await?)
}

pub async fn get_communities(tx: &mut Transaction<'_, Postgres>) -> Result<Vec<Community>> {
    let q = query_as!(Community, "SELECT id, owner_id, name, slug, description, is_private, updated_at, created_at, background_color, foreground_color FROM communities");
    Ok(q.fetch_all(&mut **tx).await?)
}

pub async fn get_public_communities(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<Vec<PublicCommunity>> {
    // Select communities ordered by latest published post
    let q = query_as!(
        PublicCommunity,
        "
            SELECT communities.id, communities.owner_id, users.login_name AS owner_login_name, communities.name, communities.slug, communities.description, communities.is_private, communities.updated_at, communities.created_at, communities.background_color, communities.foreground_color, COALESCE(COUNT(posts.id), 0) AS posts_count
            FROM communities
            LEFT JOIN posts ON communities.id = posts.community_id AND posts.published_at IS NOT NULL AND posts.deleted_at IS NULL
            LEFT JOIN users ON communities.owner_id = users.id
            WHERE communities.is_private = false
            GROUP BY communities.id, users.login_name
            HAVING MAX(posts.published_at) IS NOT NULL
            ORDER BY MAX(posts.published_at) DESC
        "
    );

    Ok(q.fetch_all(&mut **tx).await?)
}

pub async fn get_active_public_communities_excluding_owner(
    tx: &mut Transaction<'_, Postgres>,
    community_owner_id: Uuid,
) -> Result<Vec<PublicCommunity>> {
    let q = query_as!(
        PublicCommunity,
        "
            SELECT communities.id, communities.owner_id, users.login_name AS owner_login_name, communities.name, communities.slug, communities.description, communities.is_private, communities.updated_at, communities.created_at, communities.background_color, communities.foreground_color, COUNT(posts.id) AS posts_count
            FROM communities
            LEFT JOIN posts ON communities.id = posts.community_id AND posts.published_at IS NOT NULL AND posts.deleted_at IS NULL
            LEFT JOIN users ON communities.owner_id = users.id
            WHERE communities.is_private = false AND communities.owner_id != $1
            GROUP BY communities.id, users.login_name
            HAVING MAX(posts.published_at) IS NOT NULL
            ORDER BY MAX(posts.published_at) DESC
        ",
        community_owner_id
    );

    Ok(q.fetch_all(&mut **tx).await?)
}

pub async fn get_user_communities_with_latest_9_posts(
    tx: &mut Transaction<'_, Postgres>,
    community_owner_id: Uuid,
) -> Result<Vec<PublicCommunityWithPosts>> {
    // Select communities ordered by latest published post
    let communities = query_as!(
        PublicCommunity,
        "
            SELECT
                communities.id,
                communities.owner_id,
                users.login_name AS owner_login_name,
                communities.name,
                communities.slug,
                communities.description,
                communities.is_private,
                communities.updated_at,
                communities.created_at,
                communities.foreground_color,
                communities.background_color,
                COUNT(posts.id) AS posts_count
            FROM communities
            LEFT JOIN users ON communities.owner_id = users.id
            LEFT JOIN posts ON communities.id = posts.community_id AND posts.published_at IS NOT NULL AND posts.deleted_at IS NULL
            WHERE communities.owner_id = $1
            AND communities.is_private = false
            GROUP BY communities.id, users.login_name
            ORDER BY MAX(posts.published_at) DESC
            LIMIT 9
        ",
        community_owner_id
    )
    .fetch_all(&mut **tx)
    .await?;

    let mut result = Vec::new();

    for community in communities {
        let q = query!(
            "
                SELECT
                    posts.id,
                    posts.title,
                    posts.author_id,
                    users.login_name,
                    images.paint_duration AS paint_duration,
                    images.stroke_count AS stroke_count,
                    images.image_filename AS image_filename,
                    images.width AS width,
                    images.height AS height,
                    images.replay_filename AS replay_filename,
                    posts.viewer_count,
                    posts.is_sensitive,
                    posts.published_at,
                    posts.created_at,
                    posts.updated_at
                FROM posts
                LEFT JOIN images ON posts.image_id = images.id
                LEFT JOIN users ON posts.author_id = users.id
                WHERE community_id = $1
                AND posts.deleted_at IS NULL
                AND posts.published_at IS NOT NULL
                ORDER BY posts.published_at DESC
                LIMIT 9
            ",
            community.id
        );
        let r = q.fetch_all(&mut **tx).await?;
        let posts = r
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
            .collect();

        result.push(PublicCommunityWithPosts {
            id: community.id,
            owner_id: community.owner_id,
            owner_login_name: community.owner_login_name,
            name: community.name,
            slug: community.slug,
            description: community.description,
            is_private: community.is_private,
            updated_at: community.updated_at,
            created_at: community.created_at,
            posts,
        });
    }

    Ok(result)
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct KnownCommunity {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub owner_login_name: String,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub is_private: bool,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub background_color: Option<String>,
    pub foreground_color: Option<String>,
}

pub async fn get_known_communities(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<Vec<KnownCommunity>> {
    // Select public communities and private communities that the user is owner of, and private communities that the user has posted in, ordered by latest published post
    let q = query_as!(
        KnownCommunity,
        "
            SELECT communities.id, communities.owner_id, users.login_name AS owner_login_name, communities.name, communities.slug, communities.description, communities.is_private, communities.updated_at, communities.created_at, communities.background_color, communities.foreground_color
            FROM communities
            LEFT JOIN posts ON communities.id = posts.community_id
            LEFT JOIN users ON communities.owner_id = users.id
            WHERE communities.is_private = false OR communities.id IN (
                SELECT DISTINCT community_id
                FROM posts
                WHERE author_id = $1
            ) OR communities.owner_id = $1
            GROUP BY communities.id, users.login_name
            ORDER BY MAX(posts.published_at) DESC
        ",
        user_id
    );

    Ok(q.fetch_all(&mut **tx).await?)
}

pub async fn get_participating_communities(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<Vec<Community>> {
    // Select communities that the user is owner of, or has posted in, ordered by latest published post
    let q = query_as!(
        Community,
        "
            SELECT communities.id, communities.owner_id, communities.name, communities.slug, communities.description, communities.is_private, communities.updated_at, communities.created_at, communities.background_color, communities.foreground_color
            FROM communities
            LEFT JOIN posts ON communities.id = posts.community_id
            WHERE communities.id IN (
                SELECT DISTINCT community_id
                FROM posts
                WHERE author_id = $1
            ) OR communities.owner_id = $1
            GROUP BY communities.id
            ORDER BY MAX(posts.published_at) DESC
        ",
        user_id
    );

    Ok(q.fetch_all(&mut **tx).await?)
}

pub async fn find_community_by_id(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<Option<Community>> {
    let q = query_as!(Community, "SELECT id, owner_id, name, slug, description, is_private, updated_at, created_at, background_color, foreground_color FROM communities WHERE id = $1", id);
    Ok(q.fetch_optional(&mut **tx).await?)
}

pub async fn find_community_by_slug(
    tx: &mut Transaction<'_, Postgres>,
    slug: String,
) -> Result<Option<Community>> {
    let q = query_as!(Community, "SELECT id, owner_id, name, slug, description, is_private, updated_at, created_at, background_color, foreground_color FROM communities WHERE slug = $1", slug);
    Ok(q.fetch_optional(&mut **tx).await?)
}

pub async fn create_community(
    tx: &mut Transaction<'_, Postgres>,
    owner_id: Uuid,
    community_draft: CommunityDraft,
) -> Result<Community> {
    let q = query!(
        "
            INSERT INTO communities (
                owner_id,
                name,
                slug,
                description,
                is_private
            )
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, created_at, updated_at
        ",
        owner_id,
        community_draft.name,
        community_draft.slug,
        community_draft.description,
        community_draft.is_private,
    );
    let result = q.fetch_one(&mut **tx).await?;

    Ok(Community {
        id: result.id,
        owner_id,
        name: community_draft.name,
        slug: community_draft.slug,
        description: community_draft.description,
        is_private: community_draft.is_private,
        created_at: result.created_at,
        updated_at: result.updated_at,
        background_color: None,
        foreground_color: None,
    })
}

pub async fn update_community(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    community_draft: CommunityDraft,
    config: Option<&crate::AppConfig>,
) -> Result<Community> {
    let q = query!(
        "
            UPDATE communities
            SET name = $2, slug = $3, description = $4, is_private = $5, updated_at = now()
            WHERE id = $1
            RETURNING owner_id, created_at
        ",
        id,
        community_draft.name,
        community_draft.slug,
        community_draft.description,
        community_draft.is_private,
    );
    let result = q.fetch_one(&mut **tx).await?;

    // If config is provided, also update the corresponding community actor
    if let Some(config) = config {
        let _ = super::actor::update_actor_for_community(
            tx,
            id,
            community_draft.slug.clone(), // Use slug as username
            community_draft.name.clone(),
            community_draft.description.clone(),
            config,
        )
        .await;
    }

    Ok(Community {
        id,
        owner_id: result.owner_id,
        name: community_draft.name,
        slug: community_draft.slug,
        description: community_draft.description,
        is_private: community_draft.is_private,
        created_at: result.created_at,
        updated_at: Utc::now(),
        background_color: None,
        foreground_color: None,
    })
}

pub async fn update_community_with_activity(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    community_draft: CommunityDraft,
    config: &crate::AppConfig,
    state: Option<&crate::web::state::AppState>,
) -> Result<Community> {
    // First update the community
    let community = update_community(tx, id, community_draft, Some(config)).await?;

    // If state is provided, send ActivityPub Update activity
    if let Some(state) = state {
        // Get the updated actor
        if let Some(updated_actor) = super::actor::Actor::find_by_community_id(tx, id).await? {
            // Send Update activity - don't fail if this fails
            if let Err(e) =
                crate::web::handlers::activitypub::send_update_activity(&updated_actor, state).await
            {
                tracing::warn!(
                    "Failed to send Update activity for community {}: {:?}",
                    id,
                    e
                );
            }
        }
    }

    Ok(community)
}

// Get communities a user can post to (public communities or private communities they own)
pub async fn get_communities_for_collaboration(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<Vec<Community>> {
    let q = query_as!(
        Community,
        r#"
        SELECT id, owner_id, name, slug, description, is_private, updated_at, created_at,
               background_color, foreground_color
        FROM communities
        WHERE is_private = false OR owner_id = $1
        ORDER BY name ASC
        "#,
        user_id
    );

    Ok(q.fetch_all(&mut **tx).await?)
}

// Get statistics for a community
pub async fn get_community_stats(
    tx: &mut Transaction<'_, Postgres>,
    community_id: Uuid,
) -> Result<CommunityStats> {
    let stats = sqlx::query!(
        r#"
        SELECT
            COUNT(DISTINCT CASE WHEN posts.published_at IS NOT NULL AND posts.deleted_at IS NULL THEN posts.id END) AS "total_posts!",
            COUNT(DISTINCT CASE WHEN posts.published_at IS NOT NULL AND posts.deleted_at IS NULL THEN posts.author_id END) AS "total_contributors!",
            COUNT(DISTINCT comments.id) AS "total_comments!"
        FROM communities
        LEFT JOIN posts ON communities.id = posts.community_id
        LEFT JOIN comments ON posts.id = comments.post_id
        WHERE communities.id = $1
        "#,
        community_id
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(CommunityStats {
        total_posts: stats.total_posts,
        total_contributors: stats.total_contributors,
        total_comments: stats.total_comments,
    })
}

/// Struct for community member stats
pub struct CommunityMembersCount {
    pub community_id: Uuid,
    pub members_count: Option<i64>,
}

/// Fetch members count (unique contributors) for multiple communities
pub async fn get_communities_members_count(
    tx: &mut Transaction<'_, Postgres>,
    community_ids: &[Uuid],
) -> Result<Vec<CommunityMembersCount>> {
    if community_ids.is_empty() {
        return Ok(Vec::new());
    }

    let result = sqlx::query!(
        r#"
        SELECT
            p.community_id,
            COUNT(DISTINCT p.author_id) as members_count
        FROM posts p
        WHERE p.community_id = ANY($1)
            AND p.published_at IS NOT NULL
            AND p.deleted_at IS NULL
        GROUP BY p.community_id
        "#,
        community_ids
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(result
        .into_iter()
        .map(|row| CommunityMembersCount {
            community_id: row.community_id,
            members_count: row.members_count,
        })
        .collect())
}
