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
    pub description: String,
    pub is_private: bool,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub posts: Vec<SerializablePost>,
}

impl Community {
    pub fn get_url(&self) -> String {
        format!("/communities/{}", self.id)
    }
}

pub struct CommunityDraft {
    pub name: String,
    pub description: String,
    pub is_private: bool,
}

pub async fn get_own_communities(
    tx: &mut Transaction<'_, Postgres>,
    owner_id: Uuid,
) -> Result<Vec<Community>> {
    let q = query_as!(
        Community,
        "SELECT id, owner_id, name, description, is_private, updated_at, created_at, background_color, foreground_color FROM communities WHERE owner_id = $1",
        owner_id
    );

    Ok(q.fetch_all(&mut **tx).await?)
}

pub async fn get_communities(tx: &mut Transaction<'_, Postgres>) -> Result<Vec<Community>> {
    let q = query_as!(Community, "SELECT id, owner_id, name, description, is_private, updated_at, created_at, background_color, foreground_color FROM communities");
    Ok(q.fetch_all(&mut **tx).await?)
}

pub async fn get_public_communities(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<Vec<PublicCommunity>> {
    // Select communities ordered by latest published post
    let q = query_as!(
        PublicCommunity,
        "
            SELECT communities.*, users.login_name AS owner_login_name, COALESCE(COUNT(posts.id), 0) AS posts_count
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
            SELECT communities.*, users.login_name AS owner_login_name, COUNT(posts.id) AS posts_count
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
            .collect();

        result.push(PublicCommunityWithPosts {
            id: community.id,
            owner_id: community.owner_id,
            owner_login_name: community.owner_login_name,
            name: community.name,
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
            SELECT communities.*, users.login_name AS owner_login_name
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
            SELECT communities.*
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
    let q = query_as!(Community, "SELECT id, owner_id, name, description, is_private, updated_at, created_at, background_color, foreground_color FROM communities WHERE id = $1", id);
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
                description,
                is_private
            )
            VALUES ($1, $2, $3, $4)
            RETURNING id, created_at, updated_at
        ",
        owner_id,
        community_draft.name,
        community_draft.description,
        community_draft.is_private,
    );
    let result = q.fetch_one(&mut **tx).await?;

    Ok(Community {
        id: result.id,
        owner_id,
        name: community_draft.name,
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
) -> Result<Community> {
    let q = query!(
        "
            UPDATE communities
            SET name = $2, description = $3, is_private = $4, updated_at = now()
            WHERE id = $1
            RETURNING owner_id, created_at
        ",
        id,
        community_draft.name,
        community_draft.description,
        community_draft.is_private,
    );
    let result = q.fetch_one(&mut **tx).await?;

    Ok(Community {
        id,
        owner_id: result.owner_id,
        name: community_draft.name,
        description: community_draft.description,
        is_private: community_draft.is_private,
        created_at: result.created_at,
        updated_at: Utc::now(),
        background_color: None,
        foreground_color: None,
    })
}
