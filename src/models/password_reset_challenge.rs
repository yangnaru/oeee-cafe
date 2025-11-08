use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{query_as, Postgres, Transaction};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct PasswordResetChallenge {
    pub id: Uuid,
    pub user_id: Uuid,
    pub email: String,
    pub token: String,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

pub async fn create_password_reset_challenge(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    email: &str,
    token: &str,
    expires_at: DateTime<Utc>,
) -> Result<PasswordResetChallenge> {
    let challenge = query_as!(
        PasswordResetChallenge,
        r#"
        INSERT INTO password_reset_challenges (user_id, email, token, expires_at)
        VALUES ($1, $2, $3, $4)
        RETURNING *
        "#,
        user_id,
        email,
        token,
        expires_at
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(challenge)
}

pub async fn find_password_reset_challenge_by_token(
    tx: &mut Transaction<'_, Postgres>,
    token: &str,
) -> Result<Option<PasswordResetChallenge>> {
    let challenge = query_as!(
        PasswordResetChallenge,
        r#"
        SELECT * FROM password_reset_challenges
        WHERE token = $1 AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
        "#,
        token
    )
    .fetch_optional(&mut **tx)
    .await?;

    Ok(challenge)
}

pub async fn delete_password_reset_challenges_for_user(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<()> {
    sqlx::query!(
        r#"
        DELETE FROM password_reset_challenges
        WHERE user_id = $1
        "#,
        user_id
    )
    .execute(&mut **tx)
    .await?;

    Ok(())
}
