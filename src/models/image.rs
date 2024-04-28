use anyhow::Result;
use chrono::{DateTime, Utc};
use sqlx::{postgres::types::PgInterval, query_as, Postgres, Transaction};
use uuid::Uuid;

pub struct Image {
    pub id: String,
    pub paint_duration: PgInterval,
    pub stroke_count: i32,
    pub width: i32,
    pub height: i32,
    pub image_filename: String,
    pub replay_filename: String,
    pub created_at: DateTime<Utc>,
}

pub async fn find_image_by_id(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<Image> {
    let image = query_as!(
        Image,
        "
        SELECT
            id,
            paint_duration,
            stroke_count,
            width,
            height,
            image_filename,
            replay_filename,
            created_at
        FROM images
        WHERE id = $1
        ",
        id
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(image)
}
