use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction, Type};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq)]
#[sqlx(type_name = "notification_type", rename_all = "lowercase")]
pub enum NotificationType {
    Comment,
    Reaction,
    Follow,
    #[sqlx(rename = "guestbook_entry")]
    GuestbookEntry,
    #[sqlx(rename = "guestbook_reply")]
    GuestbookReply,
    Mention,
    #[sqlx(rename = "post_reply")]
    PostReply,
    #[sqlx(rename = "comment_reply")]
    CommentReply,
}

#[derive(Clone, Debug, Serialize)]
pub struct Notification {
    pub id: Uuid,
    pub recipient_id: Uuid,
    pub actor_id: Uuid,
    pub notification_type: NotificationType,
    pub post_id: Option<Uuid>,
    pub comment_id: Option<Uuid>,
    pub reaction_iri: Option<String>,
    pub guestbook_entry_id: Option<Uuid>,
    pub read_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
pub struct NotificationWithActor {
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
    // Additional context data
    pub post_title: Option<String>,
    pub post_author_login_name: Option<String>,
    pub post_image_filename: Option<String>,
    pub post_image_width: Option<i32>,
    pub post_image_height: Option<i32>,
    pub comment_content: Option<String>,
    pub comment_content_html: Option<String>,
    pub guestbook_content: Option<String>,
}

pub struct CreateNotificationParams {
    pub recipient_id: Uuid,
    pub actor_id: Uuid,
    pub notification_type: NotificationType,
    pub post_id: Option<Uuid>,
    pub comment_id: Option<Uuid>,
    pub reaction_iri: Option<String>,
    pub guestbook_entry_id: Option<Uuid>,
}

/// Create a new notification
pub async fn create_notification(
    tx: &mut Transaction<'_, Postgres>,
    params: CreateNotificationParams,
) -> Result<Notification> {
    // Don't create notification if actor is notifying themselves
    // For federated actors (user_id is None), they can't be self-notifications
    if let Ok(actor_user_id) = get_user_id_from_actor(tx, params.actor_id).await {
        if params.recipient_id == actor_user_id {
            return Err(anyhow::anyhow!("Cannot notify self"));
        }
    }

    let notification = sqlx::query_as!(
        Notification,
        r#"
        INSERT INTO notifications (
            recipient_id, actor_id, notification_type,
            post_id, comment_id, reaction_iri, guestbook_entry_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING
            id, recipient_id, actor_id,
            notification_type as "notification_type: NotificationType",
            post_id, comment_id, reaction_iri, guestbook_entry_id,
            read_at, created_at
        "#,
        params.recipient_id,
        params.actor_id,
        params.notification_type as NotificationType,
        params.post_id,
        params.comment_id,
        params.reaction_iri,
        params.guestbook_entry_id
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(notification)
}

/// Helper function to get user_id from actor_id (returns None if actor has no associated user)
async fn get_user_id_from_actor(
    tx: &mut Transaction<'_, Postgres>,
    actor_id: Uuid,
) -> Result<Uuid> {
    let result = sqlx::query!(
        r#"
        SELECT user_id FROM actors WHERE id = $1
        "#,
        actor_id
    )
    .fetch_one(&mut **tx)
    .await?;

    result
        .user_id
        .ok_or_else(|| anyhow::anyhow!("Actor has no associated user"))
}

/// List notifications for a user with pagination
pub async fn list_notifications(
    tx: &mut Transaction<'_, Postgres>,
    recipient_id: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<NotificationWithActor>> {
    let notifications = sqlx::query!(
        r#"
        SELECT
            n.id,
            n.recipient_id,
            n.actor_id,
            a.name AS actor_name,
            a.handle AS actor_handle,
            n.notification_type as "notification_type: NotificationType",
            n.post_id,
            n.comment_id,
            n.reaction_iri,
            r.emoji AS "reaction_emoji?",
            n.guestbook_entry_id,
            n.read_at,
            n.created_at,
            p.title AS post_title,
            post_authors.login_name AS "post_author_login_name?",
            images.image_filename AS "post_image_filename?",
            images.width AS "post_image_width?",
            images.height AS "post_image_height?",
            c.content AS "comment_content?",
            c.content_html AS comment_content_html,
            g.content AS "guestbook_content?"
        FROM notifications n
        LEFT JOIN actors a ON n.actor_id = a.id
        LEFT JOIN posts p ON n.post_id = p.id
        LEFT JOIN users post_authors ON p.author_id = post_authors.id
        LEFT JOIN images ON p.image_id = images.id
        LEFT JOIN comments c ON n.comment_id = c.id
        LEFT JOIN reactions r ON n.reaction_iri = r.iri
        LEFT JOIN guestbook_entries g ON n.guestbook_entry_id = g.id
        WHERE n.recipient_id = $1
        ORDER BY n.created_at DESC
        LIMIT $2 OFFSET $3
        "#,
        recipient_id,
        limit,
        offset
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(notifications
        .into_iter()
        .map(|row| NotificationWithActor {
            id: row.id,
            recipient_id: row.recipient_id,
            actor_id: row.actor_id,
            actor_name: row.actor_name,
            actor_handle: row.actor_handle,
            notification_type: row.notification_type,
            post_id: row.post_id,
            comment_id: row.comment_id,
            reaction_iri: row.reaction_iri,
            reaction_emoji: row.reaction_emoji,
            guestbook_entry_id: row.guestbook_entry_id,
            read_at: row.read_at,
            created_at: row.created_at,
            post_title: row.post_title,
            post_author_login_name: row.post_author_login_name,
            post_image_filename: row.post_image_filename,
            post_image_width: row.post_image_width,
            post_image_height: row.post_image_height,
            comment_content: row.comment_content,
            comment_content_html: row.comment_content_html,
            guestbook_content: row.guestbook_content,
        })
        .collect())
}

/// Get a single notification by ID
pub async fn get_notification_by_id(
    tx: &mut Transaction<'_, Postgres>,
    notification_id: Uuid,
    recipient_id: Uuid,
) -> Result<Option<NotificationWithActor>> {
    let notification = sqlx::query!(
        r#"
        SELECT
            n.id,
            n.recipient_id,
            n.actor_id,
            a.name AS actor_name,
            a.handle AS actor_handle,
            n.notification_type as "notification_type: NotificationType",
            n.post_id,
            n.comment_id,
            n.reaction_iri,
            r.emoji AS "reaction_emoji?",
            n.guestbook_entry_id,
            n.read_at,
            n.created_at,
            p.title AS post_title,
            post_authors.login_name AS "post_author_login_name?",
            images.image_filename AS "post_image_filename?",
            images.width AS "post_image_width?",
            images.height AS "post_image_height?",
            c.content AS "comment_content?",
            c.content_html AS comment_content_html,
            g.content AS "guestbook_content?"
        FROM notifications n
        LEFT JOIN actors a ON n.actor_id = a.id
        LEFT JOIN posts p ON n.post_id = p.id
        LEFT JOIN users post_authors ON p.author_id = post_authors.id
        LEFT JOIN images ON p.image_id = images.id
        LEFT JOIN comments c ON n.comment_id = c.id
        LEFT JOIN reactions r ON n.reaction_iri = r.iri
        LEFT JOIN guestbook_entries g ON n.guestbook_entry_id = g.id
        WHERE n.id = $1 AND n.recipient_id = $2
        "#,
        notification_id,
        recipient_id
    )
    .fetch_optional(&mut **tx)
    .await?;

    Ok(notification.map(|row| NotificationWithActor {
        id: row.id,
        recipient_id: row.recipient_id,
        actor_id: row.actor_id,
        actor_name: row.actor_name,
        actor_handle: row.actor_handle,
        notification_type: row.notification_type,
        post_id: row.post_id,
        comment_id: row.comment_id,
        reaction_iri: row.reaction_iri,
        reaction_emoji: row.reaction_emoji,
        guestbook_entry_id: row.guestbook_entry_id,
        read_at: row.read_at,
        created_at: row.created_at,
        post_title: row.post_title,
        post_author_login_name: row.post_author_login_name,
        post_image_filename: row.post_image_filename,
        post_image_width: row.post_image_width,
        post_image_height: row.post_image_height,
        comment_content: row.comment_content,
        comment_content_html: row.comment_content_html,
        guestbook_content: row.guestbook_content,
    }))
}

/// Mark a notification as read
pub async fn mark_notification_as_read(
    tx: &mut Transaction<'_, Postgres>,
    notification_id: Uuid,
    recipient_id: Uuid,
) -> Result<bool> {
    let result = sqlx::query!(
        r#"
        UPDATE notifications
        SET read_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND recipient_id = $2 AND read_at IS NULL
        "#,
        notification_id,
        recipient_id
    )
    .execute(&mut **tx)
    .await?;

    Ok(result.rows_affected() > 0)
}

/// Mark all notifications as read for a user
pub async fn mark_all_notifications_as_read(
    tx: &mut Transaction<'_, Postgres>,
    recipient_id: Uuid,
) -> Result<u64> {
    let result = sqlx::query!(
        r#"
        UPDATE notifications
        SET read_at = CURRENT_TIMESTAMP
        WHERE recipient_id = $1 AND read_at IS NULL
        "#,
        recipient_id
    )
    .execute(&mut **tx)
    .await?;

    Ok(result.rows_affected())
}

/// Get unread notification count for a user
pub async fn get_unread_count(
    tx: &mut Transaction<'_, Postgres>,
    recipient_id: Uuid,
) -> Result<i64> {
    let result = sqlx::query!(
        r#"
        SELECT COUNT(*) as count
        FROM notifications
        WHERE recipient_id = $1 AND read_at IS NULL
        "#,
        recipient_id
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(result.count.unwrap_or(0))
}

/// Delete a notification
pub async fn delete_notification(
    tx: &mut Transaction<'_, Postgres>,
    notification_id: Uuid,
    recipient_id: Uuid,
) -> Result<bool> {
    let result = sqlx::query!(
        r#"
        DELETE FROM notifications
        WHERE id = $1 AND recipient_id = $2
        "#,
        notification_id,
        recipient_id
    )
    .execute(&mut **tx)
    .await?;

    Ok(result.rows_affected() > 0)
}

/// Check if a notification already exists (to prevent duplicates)
pub async fn notification_exists(
    tx: &mut Transaction<'_, Postgres>,
    recipient_id: Uuid,
    actor_id: Uuid,
    notification_type: NotificationType,
    post_id: Option<Uuid>,
    comment_id: Option<Uuid>,
    reaction_iri: Option<&str>,
    guestbook_entry_id: Option<Uuid>,
) -> Result<bool> {
    let result = sqlx::query!(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM notifications
            WHERE recipient_id = $1
            AND actor_id = $2
            AND notification_type = $3
            AND ($4::uuid IS NULL OR post_id = $4)
            AND ($5::uuid IS NULL OR comment_id = $5)
            AND ($6::text IS NULL OR reaction_iri = $6)
            AND ($7::uuid IS NULL OR guestbook_entry_id = $7)
        ) as "exists!"
        "#,
        recipient_id,
        actor_id,
        notification_type as NotificationType,
        post_id,
        comment_id,
        reaction_iri,
        guestbook_entry_id
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(result.exists)
}

/// Send push notification for a newly created notification
/// This should be called after create_notification() succeeds and the transaction is committed
pub async fn send_push_for_notification(
    push_service: &crate::push::PushService,
    notification: &NotificationWithActor,
    badge_count: Option<u32>,
) {
    // Format notification message based on type
    let (title, body) = format_notification_message(notification);

    let badge = badge_count;

    // Add custom data for deep linking
    let mut data = serde_json::Map::new();
    data.insert("notification_id".to_string(), serde_json::json!(notification.id.to_string()));
    data.insert("notification_type".to_string(), serde_json::json!(format!("{:?}", notification.notification_type)));

    if let Some(post_id) = notification.post_id {
        data.insert("post_id".to_string(), serde_json::json!(post_id.to_string()));
    }
    if let Some(comment_id) = notification.comment_id {
        data.insert("comment_id".to_string(), serde_json::json!(comment_id.to_string()));
    }

    // Send push notification (don't fail if this errors)
    if let Err(e) = push_service
        .send_notification_to_user(
            notification.recipient_id,
            &title,
            &body,
            badge,
            Some(serde_json::Value::Object(data)),
        )
        .await
    {
        tracing::warn!(
            "Failed to send push notification to user {}: {:?}",
            notification.recipient_id,
            e
        );
    }
}

/// Format a notification into a user-friendly push notification message
fn format_notification_message(notification: &NotificationWithActor) -> (String, String) {
    let actor_name = &notification.actor_name;

    match notification.notification_type {
        NotificationType::Comment => {
            let title = format!("New comment from {}", actor_name);
            let body = if let Some(content) = &notification.comment_content {
                content.clone()
            } else {
                format!("{} commented on your post", actor_name)
            };
            (title, body)
        }
        NotificationType::Reaction => {
            let emoji = notification.reaction_emoji.as_deref().unwrap_or("❤️");
            let title = format!("{} reacted to your post", actor_name);
            let body = format!("{} {}", emoji, notification.post_title.as_deref().unwrap_or("your post"));
            (title, body)
        }
        NotificationType::Follow => {
            let title = "New follower".to_string();
            let body = format!("{} started following you", actor_name);
            (title, body)
        }
        NotificationType::GuestbookEntry => {
            let title = format!("{} signed your guestbook", actor_name);
            let body = notification.guestbook_content.clone().unwrap_or_default();
            (title, body)
        }
        NotificationType::GuestbookReply => {
            let title = format!("{} replied to your guestbook entry", actor_name);
            let body = notification.guestbook_content.clone().unwrap_or_default();
            (title, body)
        }
        NotificationType::Mention => {
            let title = format!("{} mentioned you", actor_name);
            let body = if let Some(content) = &notification.comment_content {
                content.clone()
            } else {
                format!("{} mentioned you in a comment", actor_name)
            };
            (title, body)
        }
        NotificationType::PostReply => {
            let title = format!("{} replied to your post", actor_name);
            let body = notification.post_title.clone().unwrap_or_default();
            (title, body)
        }
        NotificationType::CommentReply => {
            let title = format!("{} replied to your comment", actor_name);
            let body = if let Some(content) = &notification.comment_content {
                content.clone()
            } else {
                format!("{} replied to your comment", actor_name)
            };
            (title, body)
        }
    }
}
