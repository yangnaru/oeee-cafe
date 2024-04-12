use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[derive(Serialize, Deserialize, Debug)]
pub struct Link {
    pub id: Uuid,
    pub user_id: Uuid,
    pub url: String,
    pub description: String,
    pub index: i32,
    pub created_at: DateTime<Utc>,
}

pub struct LinkDraft {
    pub user_id: Uuid,
    pub url: String,
    pub description: String,
}

pub async fn delete_link(
    tx: &mut Transaction<'_, Postgres>,
    link_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"
        DELETE FROM links
        WHERE id = $1
        "#,
        link_id
    )
    .execute(&mut **tx)
    .await?;

    Ok(())
}

pub async fn create_link(
    tx: &mut Transaction<'_, Postgres>,
    link_draft: LinkDraft,
) -> Result<Link, sqlx::Error> {
    let link = sqlx::query_as!(
        Link,
        r#"
        INSERT INTO links (user_id, url, description, index)
        VALUES ($1, $2, $3, (SELECT COALESCE(MAX(index), 0) + 1 FROM links WHERE user_id = $1))
        RETURNING *
        "#,
        link_draft.user_id,
        link_draft.url,
        link_draft.description
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(link)
}

pub async fn find_links_by_user_id(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<Vec<Link>, sqlx::Error> {
    let links = sqlx::query_as!(
        Link,
        r#"
        SELECT * FROM links
        WHERE user_id = $1
        ORDER BY index ASC
        "#,
        user_id
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(links)
}

pub async fn update_link_order(
    tx: &mut Transaction<'_, Postgres>,
    link_id: Uuid,
    index: i32,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"
        UPDATE links
        SET index = $1
        WHERE id = $2
        "#,
        index,
        link_id
    )
    .execute(&mut **tx)
    .await?;

    Ok(())
}
