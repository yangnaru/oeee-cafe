use crate::app_error::AppError;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{Html, IntoResponse, Json},
};
use axum_messages::Messages;
use minijinja::context;
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    models::{
        community::get_pending_invitations_with_details_for_user,
        notification::{
            delete_notification, get_notification_by_id, get_unread_count,
            list_notifications as fetch_notifications, mark_all_notifications_as_read,
            mark_notification_as_read,
        },
        user::AuthSession,
    },
    web::{
        context::CommonContext,
        handlers::ExtractFtlLang,
        responses::{
            DeleteNotificationResponse, MarkAllReadResponse, MarkNotificationReadResponse,
            NotificationItem, NotificationsListResponse, UnreadCountResponse,
        },
        state::AppState,
    },
};

pub async fn list_notifications(
    auth_session: AuthSession,
    State(state): State<AppState>,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    messages: Messages,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = auth_session
        .user
        .as_ref()
        .ok_or(AppError::Unauthorized)?
        .clone();

    // Fetch notifications using the new notification system
    let notifications = fetch_notifications(&mut tx, user.id, 50, 0).await?;

    // Fetch pending invitations with all details in a single query (no N+1)
    let invitations = get_pending_invitations_with_details_for_user(&mut tx, user.id).await?;

    let invitations_with_details: Vec<serde_json::Value> = invitations
        .into_iter()
        .map(|invitation| {
            serde_json::json!({
                "id": invitation.id,
                "community_name": invitation.community_name,
                "community_slug": invitation.community_slug,
                "inviter_login_name": invitation.inviter_login_name,
                "inviter_display_name": invitation.inviter_display_name,
                "created_at": invitation.created_at,
            })
        })
        .collect();

    // Get common context (includes unread_notification_count and draft_post_count)
    let common_ctx =
        CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    tx.commit().await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("notifications.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        messages => messages.into_iter().collect::<Vec<_>>(),
        notifications => notifications,
        invitations => invitations_with_details,
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        ftl_lang
    })?;

    Ok(Html(rendered).into_response())
}

/// Mark a specific notification as read
pub async fn mark_notification_read(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path(notification_id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = auth_session
        .user
        .as_ref()
        .ok_or(AppError::Unauthorized)?
        .clone();

    let success = mark_notification_as_read(&mut tx, notification_id, user.id).await?;

    if !success {
        tx.rollback().await?;
        return Ok((StatusCode::NOT_FOUND, Html("".to_string())).into_response());
    }

    // Fetch the updated notification
    let notification = get_notification_by_id(&mut tx, notification_id, user.id).await?;

    tx.commit().await?;

    if let Some(notification) = notification {
        // Render the notification using the notification_item template
        let template = state.env.get_template("notification_item.jinja")?;
        let rendered = template.render(context! {
            notification,
            ftl_lang,
        })?;

        Ok(Html(rendered).into_response())
    } else {
        Ok((StatusCode::NOT_FOUND, Html("".to_string())).into_response())
    }
}

/// Mark all notifications as read for the current user
pub async fn mark_all_notifications_read(
    auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<Json<MarkAllReadResponse>, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = auth_session
        .user
        .as_ref()
        .ok_or(AppError::Unauthorized)?
        .clone();

    let count = mark_all_notifications_as_read(&mut tx, user.id).await?;

    tx.commit().await?;

    Ok(Json(MarkAllReadResponse {
        success: true,
        count: count as i64,
    }))
}

/// Get the unread notification count for the current user
pub async fn get_unread_notification_count(
    auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<Json<UnreadCountResponse>, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = auth_session
        .user
        .as_ref()
        .ok_or(AppError::Unauthorized)?
        .clone();

    let count = get_unread_count(&mut tx, user.id).await?;

    tx.commit().await?;

    Ok(Json(UnreadCountResponse { count }))
}

/// Delete a specific notification
pub async fn delete_notification_handler(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(notification_id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = auth_session
        .user
        .as_ref()
        .ok_or(AppError::Unauthorized)?
        .clone();

    let success = delete_notification(&mut tx, notification_id, user.id).await?;

    tx.commit().await?;

    if success {
        // Return empty response to remove the notification from DOM
        Ok(Html("".to_string()).into_response())
    } else {
        Ok((StatusCode::NOT_FOUND, Html("".to_string())).into_response())
    }
}

// ============================================================================
// JSON API Handlers for mobile/API consumption
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct NotificationQueryParams {
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
}

fn default_limit() -> i64 {
    50
}

/// API: List notifications with pagination (JSON response)
pub async fn api_list_notifications(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Query(params): Query<NotificationQueryParams>,
) -> Result<Json<NotificationsListResponse>, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = auth_session
        .user
        .as_ref()
        .ok_or(AppError::Unauthorized)?
        .clone();

    // Fetch notifications with pagination
    let notifications = fetch_notifications(&mut tx, user.id, params.limit, params.offset).await?;

    // Get total unread count to determine if there are more
    let total_count = get_unread_count(&mut tx, user.id).await?;
    let has_more = (params.offset + params.limit) < total_count;

    tx.commit().await?;

    // Convert notifications to typed structs
    let r2_base_url = &state.config.r2_public_endpoint_url;
    let notifications_typed: Vec<NotificationItem> = notifications
        .into_iter()
        .map(|n| {
            // Build full image URL if filename exists
            let post_image_url = n
                .post_image_filename
                .as_ref()
                .map(|filename| format!("{}/image/{}/{}", r2_base_url, &filename[0..2], filename));

            NotificationItem {
                id: n.id,
                recipient_id: n.recipient_id,
                actor_id: n.actor_id,
                actor_name: n.actor_name,
                actor_handle: n.actor_handle,
                actor_login_name: n.actor_login_name,
                notification_type: n.notification_type,
                post_id: n.post_id,
                comment_id: n.comment_id,
                reaction_iri: n.reaction_iri,
                reaction_emoji: n.reaction_emoji,
                guestbook_entry_id: n.guestbook_entry_id,
                read_at: n.read_at,
                created_at: n.created_at,
                post_title: n.post_title,
                post_author_login_name: n.post_author_login_name,
                post_image_filename: n.post_image_filename,
                post_image_url,
                post_image_width: n.post_image_width,
                post_image_height: n.post_image_height,
                comment_content: n.comment_content,
                comment_content_html: n.comment_content_html,
                guestbook_content: n.guestbook_content,
            }
        })
        .collect();

    Ok(Json(NotificationsListResponse {
        notifications: notifications_typed,
        total: total_count as usize,
        has_more,
    }))
}

/// API: Mark a specific notification as read (JSON response)
pub async fn api_mark_notification_read(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(notification_id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = auth_session
        .user
        .as_ref()
        .ok_or(AppError::Unauthorized)?
        .clone();

    let success = mark_notification_as_read(&mut tx, notification_id, user.id).await?;

    if !success {
        tx.rollback().await?;
        return Ok((
            StatusCode::NOT_FOUND,
            Json(MarkNotificationReadResponse {
                success: false,
                notification: None,
                error: Some("Notification not found".to_string()),
            }),
        )
            .into_response());
    }

    // Fetch the updated notification
    let notification = get_notification_by_id(&mut tx, notification_id, user.id).await?;

    tx.commit().await?;

    if let Some(n) = notification {
        // Build full image URL if filename exists
        let r2_base_url = &state.config.r2_public_endpoint_url;
        let post_image_url = n
            .post_image_filename
            .as_ref()
            .map(|filename| format!("{}/image/{}/{}", r2_base_url, &filename[0..2], filename));

        let notification_item = NotificationItem {
            id: n.id,
            recipient_id: n.recipient_id,
            actor_id: n.actor_id,
            actor_name: n.actor_name,
            actor_handle: n.actor_handle,
            actor_login_name: n.actor_login_name,
            notification_type: n.notification_type,
            post_id: n.post_id,
            comment_id: n.comment_id,
            reaction_iri: n.reaction_iri,
            reaction_emoji: n.reaction_emoji,
            guestbook_entry_id: n.guestbook_entry_id,
            read_at: n.read_at,
            created_at: n.created_at,
            post_title: n.post_title,
            post_author_login_name: n.post_author_login_name,
            post_image_filename: n.post_image_filename,
            post_image_url,
            post_image_width: n.post_image_width,
            post_image_height: n.post_image_height,
            comment_content: n.comment_content,
            comment_content_html: n.comment_content_html,
            guestbook_content: n.guestbook_content,
        };

        Ok(Json(MarkNotificationReadResponse {
            success: true,
            notification: Some(notification_item),
            error: None,
        })
        .into_response())
    } else {
        Ok((
            StatusCode::NOT_FOUND,
            Json(MarkNotificationReadResponse {
                success: false,
                notification: None,
                error: Some("Notification not found".to_string()),
            }),
        )
            .into_response())
    }
}

/// API: Delete a specific notification (JSON response)
pub async fn api_delete_notification(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(notification_id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = auth_session
        .user
        .as_ref()
        .ok_or(AppError::Unauthorized)?
        .clone();

    let success = delete_notification(&mut tx, notification_id, user.id).await?;

    tx.commit().await?;

    if success {
        Ok(Json(DeleteNotificationResponse {
            success: true,
            error: None,
        })
        .into_response())
    } else {
        Ok((
            StatusCode::NOT_FOUND,
            Json(DeleteNotificationResponse {
                success: false,
                error: Some("Notification not found".to_string()),
            }),
        )
            .into_response())
    }
}
