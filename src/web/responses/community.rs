use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;

use crate::models::community::CommunityVisibility;

/// Response for active communities list
#[derive(Serialize, Debug)]
pub struct CommunityListResponse {
    pub communities: Vec<CommunityWithPosts>,
}

#[derive(Serialize, Debug)]
pub struct CommunityWithPosts {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub visibility: String,
    pub owner_login_name: String,
    pub posts_count: Option<i64>,
    pub members_count: Option<i64>,
    pub recent_posts: Vec<CommunityPostThumbnail>,
}

#[derive(Serialize, Debug, Clone)]
pub struct CommunityPostThumbnail {
    pub id: Uuid,
    pub image_url: String,
    pub image_width: i32,
    pub image_height: i32,
}

/// Response for community detail endpoint
#[derive(Serialize, Debug)]
pub struct CommunityDetailResponse {
    pub community: CommunityInfo,
    pub stats: CommunityStats,
    pub posts: Vec<CommunityPostThumbnail>,
    pub posts_offset: i64,
    pub posts_has_more: bool,
    pub comments: Vec<CommunityComment>,
}

/// Community information
#[derive(Serialize, Debug)]
pub struct CommunityInfo {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub visibility: CommunityVisibility,
    pub owner_id: Uuid,
    pub background_color: Option<String>,
    pub foreground_color: Option<String>,
}

/// Community statistics
#[derive(Serialize, Debug)]
pub struct CommunityStats {
    pub total_posts: i64,
    pub total_contributors: i64,
    pub total_comments: i64,
}

/// Community comment with post information
#[derive(Serialize, Debug)]
pub struct CommunityComment {
    pub id: Uuid,
    pub post_id: Uuid,
    pub actor_id: Uuid,
    pub content: String,
    pub content_html: Option<String>,
    pub actor_name: String,
    pub actor_handle: String,
    pub actor_login_name: Option<String>,
    pub is_local: bool,
    pub created_at: DateTime<Utc>,
    pub post_title: Option<String>,
    pub post_author_login_name: String,
    pub post_image_url: Option<String>,
    pub post_image_width: Option<i32>,
    pub post_image_height: Option<i32>,
}
