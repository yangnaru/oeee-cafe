use serde::Serialize;
use uuid::Uuid;

/// Response for search endpoint
#[derive(Serialize, Debug)]
pub struct SearchResponse {
    pub users: Vec<SearchUserResult>,
    pub posts: Vec<SearchPostResult>,
}

/// User search result
#[derive(Serialize, Debug)]
pub struct SearchUserResult {
    pub id: Uuid,
    pub login_name: String,
    pub display_name: String,
}

/// Post search result (thumbnail format)
#[derive(Serialize, Debug)]
pub struct SearchPostResult {
    pub id: Uuid,
    pub image_url: String,
    pub image_width: Option<i32>,
    pub image_height: Option<i32>,
    pub is_sensitive: bool,
}
