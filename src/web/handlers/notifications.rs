use crate::app_error::{error_codes, AppError};
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
            ErrorResponse, MarkAllReadResponse, MarkNotificationReadResponse, NotificationItem,
            NotificationsListResponse, UnreadCountResponse,
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
            Json(ErrorResponse::new(
                error_codes::NOT_FOUND,
                "Notification not found",
            )),
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
            notification: notification_item,
        })
        .into_response())
    } else {
        Ok((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse::new(
                error_codes::NOT_FOUND,
                "Notification not found",
            )),
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
        Ok(StatusCode::NO_CONTENT.into_response())
    } else {
        Ok((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse::new(
                error_codes::NOT_FOUND,
                "Notification not found",
            )),
        )
            .into_response())
    }
}

#[cfg(test)]
mod tests {
    use crate::web::handlers::test_support;
    use minijinja::context;
    use serde_json::json;

    fn sample_notification() -> serde_json::Value {
        json!({
            "id": "00000000-0000-0000-0000-000000000001",
            "notification_type": "Follow",
            "read_at": null,
            "created_at": "2026-01-02T03:04:05Z",
            "actor_login_name": "someone",
            "actor_name": "Someone",
        })
    }

    /// A reaction to a titled post: the common case, and the one that carries a
    /// thumbnail. 55% of all notifications are reactions.
    fn sample_reaction() -> serde_json::Value {
        json!({
            "id": "00000000-0000-0000-0000-000000000003",
            "notification_type": "Reaction",
            "read_at": "2026-01-02T04:00:00Z",
            "created_at": "2026-01-02T03:04:05Z",
            "actor_login_name": "someone",
            "actor_name": "Someone",
            "reaction_emoji": "\u{1f49c}",
            "post_id": "00000000-0000-0000-0000-000000000009",
            "post_title": "A drawing",
            "post_author_login_name": "artist",
            "post_image_filename": "abcdef.png",
            "post_image_width": 300,
            "post_image_height": 300,
        })
    }

    fn sample_invitation() -> serde_json::Value {
        json!({
            "id": "00000000-0000-0000-0000-000000000002",
            "community_name": "Open Studio",
            "community_slug": "open",
            "inviter_login_name": "someone",
            "inviter_display_name": "Someone",
            "created_at": "2026-01-02T03:04:05Z",
        })
    }

    fn render(
        notifications: Vec<serde_json::Value>,
        invitations: Vec<serde_json::Value>,
    ) -> String {
        let env = test_support::env();
        let template = env
            .get_template("notifications.jinja")
            .expect("template loads");
        template
            .render(context! {
                current_user => json!({"login_name": "someone"}),
                messages => Vec::<serde_json::Value>::new(),
                notifications => notifications,
                invitations => invitations,
                draft_post_count => 0,
                unread_notification_count => 1,
                ftl_lang => "en",
            })
            .expect("notifications.jinja renders")
    }

    /// The list used to carry an <h3> holding the same string as the page's
    /// <h2>, so the page opened with its own title printed twice.
    #[test]
    fn the_page_title_is_not_repeated_over_the_list() {
        let rendered = render(vec![sample_notification()], Vec::new());
        // ftl_get_message is stubbed to echo the id, so both headings would
        // render the literal key.
        assert_eq!(
            rendered.matches(">notifications<").count(),
            1,
            "notifications heading rendered more than once"
        );
        assert!(rendered.contains("notifications-title"));
    }

    /// The invitations block keeps its heading: it is the section that is not
    /// notifications, so it is the one that needs naming.
    #[test]
    fn invitations_keep_their_own_heading() {
        let rendered = render(vec![sample_notification()], vec![sample_invitation()]);
        assert!(rendered.contains("invitations-pending"));
        assert_eq!(rendered.matches(">notifications<").count(), 1);
        assert!(rendered.contains("Open Studio"));
    }

    /// The row is one line: actor and verb in a single <p>, with the type
    /// label gone. It used to be a button bar, a type label restating the verb
    /// below it, then the actor and the action as two separate paragraphs.
    #[test]
    fn a_notification_is_one_row_not_four() {
        let rendered = render(vec![sample_reaction()], Vec::new());
        assert_eq!(rendered.matches("notification-line").count(), 1);
        // The type label ("New reaction") sat directly above the sentence that
        // already said it.
        assert!(!rendered.contains("notification-type"));
        assert!(!rendered.contains("notification-header"));
        assert!(!rendered.contains("notification-body"));
        // Actor and verb are in the same paragraph now.
        assert!(rendered.contains("notification-actor"));
        assert!(rendered.contains("notification-action"));
    }

    /// Regression: every title-bearing type wrapped its whole action line in
    /// `if post_title`, so a reaction to an untitled drawing rendered the
    /// actor's name followed by nothing at all.
    #[test]
    fn an_untitled_post_still_gets_a_verb() {
        let mut untitled = sample_reaction();
        untitled["post_title"] = json!(null);
        let rendered = render(vec![untitled], Vec::new());
        assert!(
            rendered.contains("notification-action"),
            "untitled post rendered an actor with no verb"
        );
        // Falls back to the same string the post cards use rather than a new
        // one. The stub echoes both the pattern id and the arguments, so this
        // sees the title that was actually interpolated.
        assert!(
            rendered.contains("postTitle=post-untitled"),
            "the untitled fallback did not reach the action pattern"
        );
    }

    /// 95% of notifications carry a post. The thumbnail used to be gated on a
    /// hardcoded list of six type names instead of on having an image.
    #[test]
    fn anything_with_a_post_image_gets_a_thumbnail() {
        let rendered = render(vec![sample_reaction()], Vec::new());
        assert!(rendered.contains("notification-post-image"));
        assert!(rendered.contains("/image/ab/abcdef.png"));
        // Follows have no post, so no thumbnail and no broken image.
        let follow = render(vec![sample_notification()], Vec::new());
        assert!(!follow.contains("notification-post-image"));
    }

    /// The mark-read button is the control that disappears once used; delete
    /// is always there. Both live in the row rather than on one of their own.
    #[test]
    fn read_rows_drop_the_mark_read_button() {
        let unread = render(vec![sample_notification()], Vec::new());
        assert!(unread.contains("notification-mark-read"));
        assert!(unread.contains("class=\"notification unread\""));

        let read = render(vec![sample_reaction()], Vec::new());
        assert!(!read.contains("notification-mark-read"));
        assert!(read.contains("notification-delete"));
        assert!(!read.contains("notification unread"));
    }

    /// The invitation row is built from the same pieces as a notification row,
    /// but its wording is a sentence frame the locales fill in four parts —
    /// "Invitation from" @who "to join" Community — so all four must survive.
    #[test]
    fn invitations_keep_their_sentence_frame() {
        let rendered = render(Vec::new(), vec![sample_invitation()]);
        for key in ["invitation-from", "invitation-to-community"] {
            assert!(rendered.contains(key), "{key} dropped from the invitation");
        }
        assert!(rendered.contains("@someone"));
        assert!(rendered.contains("Open Studio"));
        assert!(rendered.contains("btn-accept"));
        assert!(rendered.contains("btn-reject"));
    }

    #[test]
    fn empty_state_shows_only_when_there_is_nothing_at_all() {
        let rendered = render(Vec::new(), Vec::new());
        assert!(rendered.contains("no-notifications"));
        // An invitation is something; the empty state must not claim otherwise.
        let with_invite = render(Vec::new(), vec![sample_invitation()]);
        assert!(!with_invite.contains("no-notifications"));
    }
}
