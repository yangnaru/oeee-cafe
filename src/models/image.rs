use chrono::{DateTime, Utc};
use sqlx::postgres::types::PgInterval;

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
