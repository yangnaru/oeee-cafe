use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction, Type};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq)]
#[sqlx(type_name = "platform_type", rename_all = "lowercase")]
pub enum PlatformType {
    Ios,
    Android,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PushToken {
    pub id: Uuid,
    pub user_id: Uuid,
    pub device_token: String,
    pub platform: PlatformType,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Register or update a push token for a user
pub async fn register_push_token(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    device_token: String,
    platform: PlatformType,
) -> Result<PushToken> {
    let token = sqlx::query_as!(
        PushToken,
        r#"
        INSERT INTO push_tokens (user_id, device_token, platform)
        VALUES ($1, $2, $3)
        ON CONFLICT (device_token, platform)
        DO UPDATE SET
            user_id = EXCLUDED.user_id,
            updated_at = CURRENT_TIMESTAMP
        RETURNING
            id,
            user_id,
            device_token,
            platform as "platform: PlatformType",
            created_at,
            updated_at
        "#,
        user_id,
        device_token,
        platform as PlatformType,
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(token)
}

/// Delete a push token
pub async fn delete_push_token(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    device_token: String,
) -> Result<bool> {
    let result = sqlx::query!(
        r#"
        DELETE FROM push_tokens
        WHERE user_id = $1 AND device_token = $2
        "#,
        user_id,
        device_token,
    )
    .execute(&mut **tx)
    .await?;

    Ok(result.rows_affected() > 0)
}

/// Get all push tokens for a user
pub async fn get_user_tokens(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<Vec<PushToken>> {
    let tokens = sqlx::query_as!(
        PushToken,
        r#"
        SELECT
            id,
            user_id,
            device_token,
            platform as "platform: PlatformType",
            created_at,
            updated_at
        FROM push_tokens
        WHERE user_id = $1
        ORDER BY created_at DESC
        "#,
        user_id,
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(tokens)
}

/// Delete an invalid push token (called when push fails)
pub async fn delete_invalid_token(
    tx: &mut Transaction<'_, Postgres>,
    device_token: String,
    platform: PlatformType,
) -> Result<bool> {
    let result = sqlx::query!(
        r#"
        DELETE FROM push_tokens
        WHERE device_token = $1 AND platform = $2
        "#,
        device_token,
        platform as PlatformType,
    )
    .execute(&mut **tx)
    .await?;

    Ok(result.rows_affected() > 0)
}

/// Get tokens by platform for a user
pub async fn get_user_tokens_by_platform(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    platform: PlatformType,
) -> Result<Vec<PushToken>> {
    let tokens = sqlx::query_as!(
        PushToken,
        r#"
        SELECT
            id,
            user_id,
            device_token,
            platform as "platform: PlatformType",
            created_at,
            updated_at
        FROM push_tokens
        WHERE user_id = $1 AND platform = $2
        ORDER BY created_at DESC
        "#,
        user_id,
        platform as PlatformType,
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(tokens)
}
