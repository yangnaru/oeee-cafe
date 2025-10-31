use serde::Serialize;
use uuid::Uuid;

use super::PaginationMeta;

/// Response for profile endpoint
#[derive(Serialize, Debug)]
pub struct ProfileResponse {
    pub user: ProfileUser,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner: Option<ProfileBanner>,
    pub posts: Vec<ProfilePost>,
    pub pagination: PaginationMeta,
    pub followings: Vec<ProfileFollowing>,
    pub total_followings: i64,
    pub links: Vec<ProfileLink>,
}

/// Profile user information
#[derive(Serialize, Debug)]
pub struct ProfileUser {
    pub id: Uuid,
    pub login_name: String,
    pub display_name: String,
}

/// Profile banner information
#[derive(Serialize, Debug)]
pub struct ProfileBanner {
    pub id: Uuid,
    pub image_filename: String,
    pub image_url: String,
}

/// Profile post thumbnail
#[derive(Serialize, Debug)]
pub struct ProfilePost {
    pub id: Uuid,
    pub image_url: String,
    pub image_width: i32,
    pub image_height: i32,
}

/// Profile following user
#[derive(Serialize, Debug)]
pub struct ProfileFollowing {
    pub id: Uuid,
    pub login_name: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner_image_url: Option<String>,
    pub banner_image_width: Option<i32>,
    pub banner_image_height: Option<i32>,
}

/// Profile link
#[derive(Serialize, Debug)]
pub struct ProfileLink {
    pub id: Uuid,
    pub url: String,
    pub description: String,
}

/// Response for profile followings list endpoint
#[derive(Serialize, Debug)]
pub struct ProfileFollowingsListResponse {
    pub followings: Vec<ProfileFollowing>,
    pub pagination: PaginationMeta,
}
