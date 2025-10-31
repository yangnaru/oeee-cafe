use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;

use super::PaginationMeta;

/// Thumbnail representation of a post for list views
#[derive(Serialize, Debug)]
pub struct PostThumbnail {
    pub id: Uuid,
    pub image_url: String,
    pub image_width: i32,
    pub image_height: i32,
    pub is_sensitive: bool,
}

/// Response for post list endpoints
#[derive(Serialize, Debug)]
pub struct PostListResponse {
    pub posts: Vec<PostThumbnail>,
    pub pagination: PaginationMeta,
}

/// Detailed post information
#[derive(Serialize, Debug)]
pub struct PostDetailResponse {
    pub post: PostDetail,
    pub child_posts: Vec<ChildPostResponse>,
    pub reactions: Vec<ReactionCount>,
}

#[derive(Serialize, Debug)]
pub struct PostDetail {
    pub id: Uuid,
    pub title: Option<String>,
    pub content: Option<String>,
    pub author_id: Uuid,
    pub login_name: String,
    pub display_name: String,
    pub paint_duration: String,
    pub viewer_count: i32,
    pub image_filename: String,
    pub image_width: i32,
    pub image_height: i32,
    pub is_sensitive: bool,
    pub published_at_utc: Option<String>,
    pub community_id: Uuid,
    pub community_name: String,
    pub community_slug: String,
}

#[derive(Serialize, Debug)]
pub struct CommentResponse {
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
    pub updated_at: DateTime<Utc>,
}

#[derive(Serialize, Debug)]
pub struct ChildPostResponse {
    pub id: Uuid,
    pub title: Option<String>,
    pub content: Option<String>,
    pub author_id: Uuid,
    pub user_login_name: String,
    pub user_display_name: String,
    pub user_actor_handle: String,
    pub image_url: String,
    pub image_width: i32,
    pub image_height: i32,
    pub published_at: Option<DateTime<Utc>>,
    pub comments_count: i64,
}

#[derive(Serialize, Debug)]
pub struct ReactionCount {
    pub emoji: String,
    pub count: i64,
    pub reacted_by_user: bool,
}

/// Response for reactions detail endpoint
#[derive(Serialize, Debug)]
pub struct ReactionsDetailResponse {
    pub reactions: Vec<Reactor>,
}

#[derive(Serialize, Debug)]
pub struct Reactor {
    pub iri: String,
    pub post_id: Uuid,
    pub actor_id: Uuid,
    pub emoji: String,
    pub created_at: DateTime<Utc>,
    pub actor_name: String,
    pub actor_handle: String,
}

/// Threaded comment with recursive children
#[derive(Serialize, Debug)]
pub struct ThreadedCommentResponse {
    pub id: Uuid,
    pub post_id: Uuid,
    pub parent_comment_id: Option<Uuid>,
    pub actor_id: Uuid,
    pub content: String,
    pub content_html: Option<String>,
    pub actor_name: String,
    pub actor_handle: String,
    pub actor_login_name: Option<String>,
    pub is_local: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub children: Vec<ThreadedCommentResponse>,
}

/// Response for paginated comments list endpoint
#[derive(Serialize, Debug)]
pub struct CommentsListResponse {
    pub comments: Vec<ThreadedCommentResponse>,
    pub pagination: PaginationMeta,
}
