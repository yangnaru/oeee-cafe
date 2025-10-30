use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;

use crate::models::notification::NotificationType;

/// Response for comments list
#[derive(Serialize, Debug)]
pub struct CommentListResponse {
    pub comments: Vec<CommentWithPost>,
}

/// Response for notifications list
#[derive(Serialize, Debug)]
pub struct NotificationsListResponse {
    pub notifications: Vec<NotificationItem>,
    pub total: usize,
    pub has_more: bool,
}

/// Individual notification item
#[derive(Serialize, Debug)]
pub struct NotificationItem {
    pub id: Uuid,
    pub recipient_id: Uuid,
    pub actor_id: Uuid,
    pub actor_name: String,
    pub actor_handle: String,
    pub notification_type: NotificationType,
    pub post_id: Option<Uuid>,
    pub comment_id: Option<Uuid>,
    pub reaction_iri: Option<String>,
    pub reaction_emoji: Option<String>,
    pub guestbook_entry_id: Option<Uuid>,
    pub read_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub post_title: Option<String>,
    pub post_author_login_name: Option<String>,
    pub post_image_filename: Option<String>,
    pub post_image_url: Option<String>,
    pub post_image_width: Option<i32>,
    pub post_image_height: Option<i32>,
    pub comment_content: Option<String>,
    pub comment_content_html: Option<String>,
    pub guestbook_content: Option<String>,
}

/// Response for marking notification as read
#[derive(Serialize, Debug)]
pub struct MarkNotificationReadResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notification: Option<NotificationItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Response for deleting notification
#[derive(Serialize, Debug)]
pub struct DeleteNotificationResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Response for marking all notifications as read
#[derive(Serialize, Debug)]
pub struct MarkAllReadResponse {
    pub success: bool,
    pub count: i64,
}

/// Response for unread notification count
#[derive(Serialize, Debug)]
pub struct UnreadCountResponse {
    pub count: i64,
}

#[derive(Serialize, Debug)]
pub struct CommentWithPost {
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
