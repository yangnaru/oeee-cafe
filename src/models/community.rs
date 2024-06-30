use anyhow::Result;
use chrono::{DateTime, Utc};
use data_encoding::BASE64URL_NOPAD;
use serde::{Deserialize, Serialize};
use sqlx::query;
use sqlx::query_as;
use sqlx::Postgres;
use sqlx::Transaction;
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Community {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub name: String,
    pub description: String,
    pub is_private: bool,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
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
}

impl Community {
    pub fn get_url(&self) -> String {
        format!(
            "/communities/{}",
            BASE64URL_NOPAD.encode(self.id.as_bytes())
        )
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
        "SELECT * FROM communities WHERE owner_id = $1",
        owner_id
    );

    Ok(q.fetch_all(&mut **tx).await?)
}

pub async fn get_communities(tx: &mut Transaction<'_, Postgres>) -> Result<Vec<Community>> {
    let q = query_as!(Community, "SELECT * FROM communities");
    Ok(q.fetch_all(&mut **tx).await?)
}

pub async fn get_public_communities(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<Vec<PublicCommunity>> {
    // Select communities ordered by latest published post
    let q = query_as!(
        PublicCommunity,
        "
            SELECT communities.*, users.login_name AS owner_login_name
            FROM communities
            LEFT JOIN posts ON communities.id = posts.community_id
            LEFT JOIN users ON communities.owner_id = users.id
            WHERE communities.is_private = false
            GROUP BY communities.id, users.login_name
            HAVING MAX(posts.published_at) IS NOT NULL
            ORDER BY MAX(posts.published_at) DESC
        "
    );

    Ok(q.fetch_all(&mut **tx).await?)
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
    let q = query_as!(Community, "SELECT * FROM communities WHERE id = $1", id);
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
    })
}
