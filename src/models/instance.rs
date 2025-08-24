use anyhow::Result;
use chrono::{DateTime, Utc};
use sqlx::{query_as, Postgres, Transaction};

#[derive(Clone, Debug)]
pub struct Instance {
    pub host: String,
    pub software: Option<String>,
    pub software_version: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub async fn find_or_create_local_instance(
    tx: &mut Transaction<'_, Postgres>,
    host: &str,
    software: Option<&str>,
    software_version: Option<&str>,
) -> Result<Instance> {
    // First try to find existing instance
    let existing = query_as!(
        Instance,
        "SELECT host, software, software_version, created_at, updated_at FROM instances WHERE host = $1",
        host
    )
    .fetch_optional(&mut **tx)
    .await?;

    if let Some(instance) = existing {
        return Ok(instance);
    }

    // Create new instance if not found
    let instance = query_as!(
        Instance,
        r#"
        INSERT INTO instances (host, software, software_version)
        VALUES ($1, $2, $3)
        RETURNING host, software, software_version, created_at, updated_at
        "#,
        host,
        software,
        software_version
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(instance)
}
