use crate::models::post::Tool;
use anyhow::Result;
use chrono::{DateTime, Utc};
use data_encoding::BASE64URL_NOPAD;
use serde::{Deserialize, Serialize};
use sqlx::{postgres::types::PgInterval, query, Postgres, Transaction};
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct Banner {
    pub id: Uuid,
    pub image_id: Uuid,
    pub author_id: Uuid,
    pub created_at: DateTime<Utc>,
}

pub struct BannerDraft {
    pub author_id: Uuid,
    pub paint_duration: PgInterval,
    pub stroke_count: i32,
    pub width: i32,
    pub height: i32,
    pub image_filename: String,
    pub replay_filename: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct SerializableBanner {
    pub id: String,
    pub author_id: Uuid,
    pub paint_duration: String,
    pub stroke_count: i32,
    pub width: i32,
    pub height: i32,
    pub image_filename: String,
    pub replay_filename: String,
    pub viewer_count: i32,
    pub published_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

pub async fn create_banner(
    tx: &mut Transaction<'_, Postgres>,
    banner_draft: BannerDraft,
) -> Result<SerializableBanner> {
    let image = query!(
        "
            INSERT INTO images (
                paint_duration,
                stroke_count,
                width,
                height,
                image_filename,
                replay_filename,
                tool
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
        ",
        banner_draft.paint_duration,
        banner_draft.stroke_count,
        banner_draft.width,
        banner_draft.height,
        banner_draft.image_filename,
        banner_draft.replay_filename,
        Tool::Neo as _
    )
    .fetch_one(&mut **tx)
    .await?;

    let post = query!(
        "
            INSERT INTO banners (
                author_id,
                image_id
            )
            VALUES ($1, $2)
            RETURNING id, created_at
        ",
        banner_draft.author_id,
        image.id,
    )
    .fetch_one(&mut **tx)
    .await?;

    query!(
        "
            UPDATE users
            SET banner_id = $1
            WHERE id = $2
        ",
        post.id,
        banner_draft.author_id,
    )
    .execute(&mut **tx)
    .await?;

    Ok(SerializableBanner {
        id: BASE64URL_NOPAD.encode(post.id.as_bytes()),
        author_id: banner_draft.author_id,
        paint_duration: banner_draft.paint_duration.microseconds.to_string(),
        stroke_count: banner_draft.stroke_count,
        image_filename: banner_draft.image_filename,
        replay_filename: banner_draft.replay_filename,
        width: banner_draft.width,
        height: banner_draft.height,
        viewer_count: 0,
        published_at: None,
        created_at: post.created_at,
    })
}

pub async fn find_banner_by_id(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<SerializableBanner> {
    let banner = query!(
        "
            SELECT
                banners.id,
                banners.author_id,
                images.paint_duration,
                images.stroke_count,
                images.width,
                images.height,
                images.image_filename,
                images.replay_filename,
                banners.created_at
            FROM banners
            LEFT JOIN images ON banners.image_id = images.id
            WHERE banners.id = $1
        ",
        id
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(SerializableBanner {
        id: BASE64URL_NOPAD.encode(banner.id.as_bytes()),
        author_id: banner.author_id,
        paint_duration: banner.paint_duration.microseconds.to_string(),
        stroke_count: banner.stroke_count,
        image_filename: banner.image_filename,
        replay_filename: banner.replay_filename,
        width: banner.width,
        height: banner.height,
        viewer_count: 0,
        published_at: None,
        created_at: banner.created_at,
    })
}
