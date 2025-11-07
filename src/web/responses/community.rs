use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;

use super::PaginationMeta;
use crate::models::community::CommunityVisibility;

/// Response for active communities list (home page - public only)
#[derive(Serialize, Debug)]
pub struct CommunityListResponse {
    pub communities: Vec<CommunityWithPosts>,
}

/// Response for my communities only
#[derive(Serialize, Debug)]
pub struct MyCommunitiesResponse {
    pub communities: Vec<CommunityWithPosts>,
}

/// Response for paginated public communities
#[derive(Serialize, Debug)]
pub struct PublicCommunitiesResponse {
    pub communities: Vec<CommunityWithPosts>,
    pub pagination: PaginationMeta,
}

#[derive(Serialize, Debug)]
pub struct CommunityWithPosts {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub visibility: CommunityVisibility,
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
    pub is_sensitive: bool,
}

/// Response for community detail endpoint
#[derive(Serialize, Debug)]
pub struct CommunityDetailResponse {
    pub community: CommunityInfo,
    pub stats: CommunityStats,
    pub posts: Vec<CommunityPostThumbnail>,
    pub pagination: PaginationMeta,
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

/// Response for community members list
#[derive(Serialize, Debug)]
pub struct CommunityMembersListResponse {
    pub members: Vec<CommunityMemberResponse>,
}

/// Community member with role information
#[derive(Serialize, Debug)]
pub struct CommunityMemberResponse {
    pub id: Uuid,
    pub user_id: Uuid,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub role: String, // "owner", "moderator", "member"
    pub joined_at: DateTime<Utc>,
    pub invited_by_username: Option<String>,
}

/// Response for community's pending invitations list
#[derive(Serialize, Debug)]
pub struct CommunityInvitationsListResponse {
    pub invitations: Vec<CommunityInvitationResponse>,
}

/// Community invitation with invitee details
#[derive(Serialize, Debug)]
pub struct CommunityInvitationResponse {
    pub id: Uuid,
    pub community_id: Uuid,
    pub invitee: InvitationUserInfo,
    pub inviter: InvitationUserInfo,
    pub created_at: DateTime<Utc>,
}

/// User information for invitations
#[derive(Serialize, Debug)]
pub struct InvitationUserInfo {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

/// Response for user's received invitations list
#[derive(Serialize, Debug)]
pub struct UserInvitationsListResponse {
    pub invitations: Vec<UserInvitationResponse>,
}

/// User's invitation with full community details
#[derive(Serialize, Debug)]
pub struct UserInvitationResponse {
    pub id: Uuid,
    pub community: InvitationCommunityInfo,
    pub inviter: InvitationUserInfo,
    pub created_at: DateTime<Utc>,
}

/// Community information for invitations
#[derive(Serialize, Debug)]
pub struct InvitationCommunityInfo {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub visibility: CommunityVisibility,
}

/// Response after creating a community
#[derive(Serialize, Debug)]
pub struct CreateCommunityResponse {
    pub community: CommunityInfo,
}
