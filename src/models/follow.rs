use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{query, query_as, Postgres, Transaction};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Follow {
    pub follower_id: Uuid,
    pub following_id: Uuid,
    pub created_at: DateTime<Utc>,
}

pub async fn follow_user(
    tx: &mut Transaction<'_, Postgres>,
    follower_id: Uuid,
    following_id: Uuid,
) -> Result<Follow> {
    let query = query!(
        "INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) RETURNING *",
        follower_id,
        following_id,
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(Follow {
        follower_id: query.follower_id,
        following_id: query.following_id,
        created_at: query.created_at,
    })
}

pub async fn unfollow_user(
    tx: &mut Transaction<'_, Postgres>,
    follower_id: Uuid,
    following_id: Uuid,
) {
    query!(
        "DELETE FROM follows WHERE follower_id = $1 AND following_id = $2",
        follower_id,
        following_id
    )
    .execute(&mut **tx)
    .await
    .unwrap_or_default();
}

// Check if user is following another user
pub async fn is_following(
    tx: &mut Transaction<'_, Postgres>,
    follower_id: Uuid,
    following_id: Uuid,
) -> Result<bool> {
    let query = query!(
        "SELECT COUNT(*) FROM follows WHERE follower_id = $1 AND following_id = $2",
        follower_id,
        following_id
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(query.count == Some(1))
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct FollowingInfo {
    pub user_id: Uuid,
    pub login_name: String,
    pub display_name: String,
    pub banner_image_filename: Option<String>,
}

pub async fn find_followings_by_user_id(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<Vec<FollowingInfo>> {
    let query = query_as!(
        FollowingInfo,
        r#"SELECT
            follows.following_id AS user_id,
            users.login_name,
            users.display_name,
            images.image_filename AS "banner_image_filename?"
        FROM follows
        LEFT JOIN users ON follows.following_id = users.id
        LEFT JOIN banners ON users.banner_id = banners.id
        LEFT JOIN images ON banners.image_id = images.id
        WHERE follower_id = $1"#,
        user_id
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(query)
}
