use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{query, Postgres, Transaction};
use uuid::Uuid;


#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Follow {
    pub follower_actor_id: Uuid,
    pub following_actor_id: Uuid,
    pub created_at: DateTime<Utc>,
}

async fn get_actor_id_by_user_id(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<Uuid> {
    let result = query!("SELECT id FROM actors WHERE user_id = $1", user_id)
        .fetch_one(&mut **tx)
        .await?;

    Ok(result.id)
}

pub async fn follow_user(
    tx: &mut Transaction<'_, Postgres>,
    follower_user_id: Uuid,
    following_user_id: Uuid,
) -> Result<Follow> {
    let follower_actor_id = get_actor_id_by_user_id(tx, follower_user_id).await?;
    let following_actor_id = get_actor_id_by_user_id(tx, following_user_id).await?;

    let query = query!(
        "INSERT INTO follows (follower_actor_id, following_actor_id) VALUES ($1, $2) RETURNING *",
        follower_actor_id,
        following_actor_id,
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(Follow {
        follower_actor_id: query.follower_actor_id,
        following_actor_id: query.following_actor_id,
        created_at: query.created_at,
    })
}

pub async fn unfollow_user(
    tx: &mut Transaction<'_, Postgres>,
    follower_user_id: Uuid,
    following_user_id: Uuid,
) -> Result<()> {
    let follower_actor_id = get_actor_id_by_user_id(tx, follower_user_id).await?;
    let following_actor_id = get_actor_id_by_user_id(tx, following_user_id).await?;

    query!(
        "DELETE FROM follows WHERE follower_actor_id = $1 AND following_actor_id = $2",
        follower_actor_id,
        following_actor_id
    )
    .execute(&mut **tx)
    .await?;

    Ok(())
}

// Check if user is following another user
pub async fn is_following(
    tx: &mut Transaction<'_, Postgres>,
    follower_user_id: Uuid,
    following_user_id: Uuid,
) -> Result<bool> {
    let follower_actor_id = get_actor_id_by_user_id(tx, follower_user_id).await?;
    let following_actor_id = get_actor_id_by_user_id(tx, following_user_id).await?;

    let query = query!(
        "SELECT COUNT(*) FROM follows WHERE follower_actor_id = $1 AND following_actor_id = $2",
        follower_actor_id,
        following_actor_id
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
    pub banner_image_width: Option<i32>,
    pub banner_image_height: Option<i32>,
}

pub async fn find_followings_by_user_id(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<Vec<FollowingInfo>> {
    let follower_actor_id = get_actor_id_by_user_id(tx, user_id).await?;

    let rows = query!(
        r#"SELECT
            actors.user_id,
            users.login_name,
            users.display_name,
            images.image_filename AS "image_filename?",
            images.width AS "width?",
            images.height AS "height?"
        FROM follows
        LEFT JOIN actors ON follows.following_actor_id = actors.id
        LEFT JOIN users ON actors.user_id = users.id
        LEFT JOIN banners ON users.banner_id = banners.id
        LEFT JOIN images ON banners.image_id = images.id
        WHERE follower_actor_id = $1"#,
        follower_actor_id
    )
    .fetch_all(&mut **tx)
    .await?;

    let following_infos = rows
        .into_iter()
        .filter_map(|row| {
            row.user_id.map(|user_id| FollowingInfo {
                user_id,
                login_name: row.login_name,
                display_name: row.display_name,
                banner_image_filename: row.image_filename,
                banner_image_width: row.width,
                banner_image_height: row.height,
            })
        })
        .collect();

    Ok(following_infos)
}
