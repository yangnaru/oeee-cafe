use crate::app_error::AppError;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{Html, IntoResponse, Json},
};
use axum_messages::Messages;
use minijinja::context;
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
