use anyhow::Result;
use chrono::{DateTime, Utc};
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
