use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
pub struct CreateSessionRequest {
    pub title: Option<String>,
    pub width: i32,
    pub height: i32,
    pub is_public: bool,
    pub max_participants: i32,
}

#[derive(Serialize)]
pub struct CreateSessionResponse {
    pub session_id: String,
    pub url: String,
}

#[derive(Serialize)]
pub struct SaveSessionResponse {
    pub post_id: String,
    pub owner_login_name: String,
    pub post_url: String,
}

#[derive(Serialize)]
pub struct SessionWithCounts {
    pub id: Uuid,
    pub owner_login_name: String,
    pub title: Option<String>,
    pub width: i32,
    pub height: i32,
    pub created_at: chrono::NaiveDateTime,
    pub participant_count: Option<i64>,
}

#[derive(Serialize)]
pub struct AuthInfo {
    pub user_id: String,
    pub login_name: String,
    pub preferred_locale: String,
}

#[derive(Serialize)]
pub struct CollaborationMeta {
    pub title: String,
    pub width: i32,
    pub height: i32,
    #[serde(rename = "ownerId")]
    pub owner_id: String,
    #[serde(rename = "savedPostId")]
    pub saved_post_id: Option<String>,
    #[serde(rename = "ownerLoginName")]
    pub owner_login_name: String,
    #[serde(rename = "maxUsers")]
    pub max_users: i32,
    #[serde(rename = "currentUserCount")]
    pub current_user_count: i64,
}