use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Post {
    pub id: Uuid,
    pub author_id: Uuid,
    pub login_name: String,
    pub display_name: String,
    pub email: String,
    pub paint_time: u32,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}
