use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{query, Postgres, Transaction};
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
    .await
    .expect("Failed to insert follow");

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
    .expect("Failed to delete follow");
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
    .await
    .expect("Failed to check follow");

    Ok(query.count == Some(1))
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct FollowingInfo {
    pub user_id: Uuid,
    pub login_name: String,
    pub display_name: String,
}

pub async fn find_followings_by_user_id(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<Vec<FollowingInfo>> {
    let query = query!(
        "SELECT follows.following_id, users.login_name, users.display_name
        FROM follows
        LEFT JOIN users ON follows.following_id = users.id
        WHERE follower_id = $1",
        user_id
    )
    .fetch_all(&mut **tx)
    .await
    .expect("Failed to find followings");

    Ok(query
        .iter()
        .map(|row| FollowingInfo {
            user_id: row.following_id,
            login_name: row.login_name.clone(),
            display_name: row.display_name.clone(),
        })
        .collect())
}
