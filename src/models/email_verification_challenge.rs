use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{query_as, Postgres, Transaction};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct EmailVerificationChallenge {
    pub id: Uuid,
    pub user_id: Uuid,
    pub email: String,
    pub token: String,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

pub async fn create_email_verification_challenge(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    email: &str,
    token: &str,
    expires_at: DateTime<Utc>,
) -> Result<EmailVerificationChallenge> {
    let challenge = query_as!(
        EmailVerificationChallenge,
        r#"
        INSERT INTO email_verification_challenges (user_id, email, token, expires_at)
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

pub async fn find_email_verification_challenge_by_id(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<Option<EmailVerificationChallenge>> {
    let challenge = query_as!(
        EmailVerificationChallenge,
        r#"
        SELECT * FROM email_verification_challenges
        WHERE id = $1
        "#,
        id
    )
    .fetch_optional(&mut **tx)
    .await?;

    Ok(challenge)
}
