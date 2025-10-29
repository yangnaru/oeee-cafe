use crate::app_error::AppError;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{Html, IntoResponse, Json},
};
use axum_messages::Messages;
use minijinja::context;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::{
    models::{
        community::get_pending_invitations_for_user,
        notification::{
            delete_notification, get_notification_by_id, get_unread_count,
            list_notifications as fetch_notifications, mark_all_notifications_as_read,
            mark_notification_as_read,
        },
        user::AuthSession,
    },
    web::{context::CommonContext, handlers::ExtractFtlLang, state::AppState},
};

pub async fn list_notifications(
    auth_session: AuthSession,
    State(state): State<AppState>,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    messages: Messages,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = auth_session.user.clone().unwrap();

    // Fetch notifications using the new notification system
    let notifications = fetch_notifications(&mut tx, user.id, 50, 0).await?;

    // Fetch pending invitations
    let invitations = get_pending_invitations_for_user(&mut tx, user.id).await?;

    // Fetch community details for each invitation
    let invitations_with_details: Vec<serde_json::Value> = {
        let mut result = Vec::new();
        for invitation in invitations {
            let community = sqlx::query!(
                "SELECT name, slug FROM communities WHERE id = $1",
                invitation.community_id
            )
            .fetch_one(&mut *tx)
            .await?;

            let inviter = sqlx::query!(
                "SELECT login_name, display_name FROM users WHERE id = $1",
                invitation.inviter_id
            )
            .fetch_one(&mut *tx)
            .await?;

            result.push(serde_json::json!({
                "id": invitation.id,
                "community_name": community.name,
                "community_slug": community.slug,
                "inviter_login_name": inviter.login_name,
                "inviter_display_name": inviter.display_name,
                "created_at": invitation.created_at,
            }));
        }
        result
    };

    // Get common context (includes unread_notification_count and draft_post_count)
    let common_ctx = CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    tx.commit().await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("notifications.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
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

    let user = auth_session.user.clone().unwrap();

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
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = auth_session.user.clone().unwrap();

    let count = mark_all_notifications_as_read(&mut tx, user.id).await?;

    tx.commit().await?;

    Ok(Json(json!({ "success": true, "count": count })).into_response())
}

/// Get the unread notification count for the current user
pub async fn get_unread_notification_count(
    auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = auth_session.user.clone().unwrap();

    let count = get_unread_count(&mut tx, user.id).await?;

    tx.commit().await?;

    Ok(Json(json!({ "count": count })).into_response())
}

/// Delete a specific notification
pub async fn delete_notification_handler(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(notification_id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = auth_session.user.clone().unwrap();

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

#[derive(Debug, Serialize)]
pub struct NotificationsListResponse {
    pub notifications: Vec<serde_json::Value>,
    pub total: usize,
    pub has_more: bool,
}

/// API: List notifications with pagination (JSON response)
pub async fn api_list_notifications(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Query(params): Query<NotificationQueryParams>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = auth_session.user.clone().unwrap();

    // Fetch notifications with pagination
    let notifications = fetch_notifications(&mut tx, user.id, params.limit, params.offset).await?;

    // Get total unread count to determine if there are more
    let total_count = get_unread_count(&mut tx, user.id).await?;
    let has_more = (params.offset + params.limit) < total_count;

    tx.commit().await?;

    // Convert notifications to JSON
    let r2_base_url = &state.config.r2_public_endpoint_url;
    let notifications_json: Vec<serde_json::Value> = notifications
        .into_iter()
        .map(|n| {
            // Build full image URL if filename exists
            let post_image_url = n.post_image_filename.as_ref().map(|filename| {
                format!("{}/image/{}/{}", r2_base_url, &filename[0..2], filename)
            });

            json!({
                "id": n.id,
                "recipient_id": n.recipient_id,
                "actor_id": n.actor_id,
                "actor_name": n.actor_name,
                "actor_handle": n.actor_handle,
                "notification_type": n.notification_type,
                "post_id": n.post_id,
                "comment_id": n.comment_id,
                "reaction_iri": n.reaction_iri,
                "reaction_emoji": n.reaction_emoji,
                "guestbook_entry_id": n.guestbook_entry_id,
                "read_at": n.read_at,
                "created_at": n.created_at,
                "post_title": n.post_title,
                "post_author_login_name": n.post_author_login_name,
                "post_image_filename": n.post_image_filename,
                "post_image_url": post_image_url,
                "post_image_width": n.post_image_width,
                "post_image_height": n.post_image_height,
                "comment_content": n.comment_content,
                "comment_content_html": n.comment_content_html,
                "guestbook_content": n.guestbook_content,
            })
        })
        .collect();

    let response = NotificationsListResponse {
        notifications: notifications_json,
        total: total_count as usize,
        has_more,
    };

    Ok(Json(response).into_response())
}

/// API: Mark a specific notification as read (JSON response)
pub async fn api_mark_notification_read(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(notification_id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = auth_session.user.clone().unwrap();

    let success = mark_notification_as_read(&mut tx, notification_id, user.id).await?;

    if !success {
        tx.rollback().await?;
        return Ok((
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "Notification not found" })),
        )
            .into_response());
    }

    // Fetch the updated notification
    let notification = get_notification_by_id(&mut tx, notification_id, user.id).await?;

    tx.commit().await?;

    if let Some(n) = notification {
        // Build full image URL if filename exists
        let r2_base_url = &state.config.r2_public_endpoint_url;
        let post_image_url = n.post_image_filename.as_ref().map(|filename| {
            format!("{}/image/{}/{}", r2_base_url, &filename[0..2], filename)
        });

        let notification_json = json!({
            "id": n.id,
            "recipient_id": n.recipient_id,
            "actor_id": n.actor_id,
            "actor_name": n.actor_name,
            "actor_handle": n.actor_handle,
            "notification_type": n.notification_type,
            "post_id": n.post_id,
            "comment_id": n.comment_id,
            "reaction_iri": n.reaction_iri,
            "reaction_emoji": n.reaction_emoji,
            "guestbook_entry_id": n.guestbook_entry_id,
            "read_at": n.read_at,
            "created_at": n.created_at,
            "post_title": n.post_title,
            "post_author_login_name": n.post_author_login_name,
            "post_image_filename": n.post_image_filename,
            "post_image_url": post_image_url,
            "post_image_width": n.post_image_width,
            "post_image_height": n.post_image_height,
            "comment_content": n.comment_content,
            "comment_content_html": n.comment_content_html,
            "guestbook_content": n.guestbook_content,
        });

        Ok(Json(json!({ "success": true, "notification": notification_json })).into_response())
    } else {
        Ok((
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "Notification not found" })),
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

    let user = auth_session.user.clone().unwrap();

    let success = delete_notification(&mut tx, notification_id, user.id).await?;

    tx.commit().await?;

    if success {
        Ok(Json(json!({ "success": true })).into_response())
    } else {
        Ok((
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "Notification not found" })),
        )
            .into_response())
    }
}
