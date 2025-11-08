use crate::app_error::AppError;
use crate::models::user::AuthSession;
use crate::web::context::CommonContext;
use crate::web::handlers::{ExtractAcceptLanguage, ExtractFtlLang};
use crate::web::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Json, Redirect, Response};
use minijinja::context;
use uuid::Uuid;

use super::db;
use super::types::*;
use super::utils::get_preferred_locale;

pub async fn get_auth_info(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
) -> impl IntoResponse {
    match auth_session.user {
        Some(user) => {
            let preferred_locale =
                get_preferred_locale(user.preferred_language.clone(), &accept_language);

            (
                StatusCode::OK,
                Json(AuthInfo {
                    user_id: user.id.to_string(),
                    login_name: user.login_name,
                    preferred_locale,
                }),
            )
                .into_response()
        }
        None => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "Authentication required"
            })),
        )
            .into_response(),
    }
}

pub async fn get_collaboration_meta(
    Path(session_uuid): Path<Uuid>,
    auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<Json<CollaborationMeta>, AppError> {
    let _user = auth_session
        .user
        .ok_or_else(|| anyhow::anyhow!("Authentication required"))?;

    let db = &state.db_pool;

    let session = sqlx::query!(
        r#"
        SELECT cs.title, cs.width, cs.height, cs.owner_id, cs.saved_post_id, cs.max_participants, u.login_name as owner_login_name
        FROM collaborative_sessions cs
        JOIN users u ON cs.owner_id = u.id
        WHERE cs.id = $1 AND cs.ended_at IS NULL
        "#,
        session_uuid
    )
    .fetch_optional(db)
    .await?
    .ok_or_else(|| anyhow::anyhow!("Session not found or not active"))?;

    let user_count = sqlx::query_scalar!(
        r#"
        SELECT COUNT(DISTINCT user_id) as "count!"
        FROM collaborative_sessions_participants
        WHERE session_id = $1 AND is_active = true
        "#,
        session_uuid
    )
    .fetch_one(db)
    .await?;

    Ok(Json(CollaborationMeta {
        title: session
            .title
            .unwrap_or_else(|| "Untitled Collaboration".to_string()),
        width: session.width,
        height: session.height,
        owner_id: session.owner_id.to_string(),
        saved_post_id: session.saved_post_id.map(|id| id.to_string()),
        owner_login_name: session.owner_login_name,
        max_users: session.max_participants,
        current_user_count: user_count,
    }))
}

pub async fn collaborate_lobby(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    let user = match auth_session.user {
        Some(user) => user,
        None => return Ok(Redirect::to("/login?next=/collaborate").into_response()),
    };

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let common_ctx = CommonContext::build(&mut tx, Some(user.id)).await?;

    let active_sessions = sqlx::query_as!(
        SessionWithCounts,
        r#"
        SELECT
            cs.id,
            u.login_name as owner_login_name,
            cs.title,
            cs.width,
            cs.height,
            cs.created_at,
            COALESCE(COUNT(DISTINCT csp.user_id) FILTER (WHERE csp.is_active = true), 0) as participant_count
        FROM collaborative_sessions cs
        JOIN users u ON cs.owner_id = u.id
        JOIN communities c ON cs.community_id = c.id
        LEFT JOIN collaborative_sessions_participants csp ON cs.id = csp.session_id
        WHERE cs.is_public = true
          AND cs.ended_at IS NULL
          AND c.visibility = 'public'
        GROUP BY cs.id, u.login_name, cs.max_participants
        HAVING COALESCE(COUNT(DISTINCT csp.user_id) FILTER (WHERE csp.is_active = true), 0) < cs.max_participants
        ORDER BY cs.last_activity DESC
        LIMIT 20
        "#
    )
    .fetch_all(&mut *tx)
    .await?;

    let template = state.env.get_template("collaborate_lobby.jinja")?;

    let rendered = template.render(context! {
        current_user => user,
        active_sessions => active_sessions,
        canvas_sizes => vec![
            ("300x300", "300×300"),
            ("1024x768", "1024×768"),
        ],
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        ftl_lang
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn create_collaborative_session(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Json(request): Json<CreateSessionRequest>,
) -> Result<Json<CreateSessionResponse>, AppError> {
    let user = auth_session
        .user
        .ok_or_else(|| anyhow::anyhow!("Authentication required"))?;

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Parse community_id if provided, otherwise None for personal collaborative sessions
    let community_id = request
        .community_id
        .as_ref()
        .and_then(|id| id.parse::<Uuid>().ok());

    let session_id = Uuid::new_v4();
    sqlx::query!(
        r#"
        INSERT INTO collaborative_sessions
        (id, owner_id, title, width, height, is_public, community_id, max_participants)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        "#,
        session_id,
        user.id,
        request.title,
        request.width,
        request.height,
        request.is_public,
        community_id,
        request.max_participants
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(CreateSessionResponse {
        session_id: session_id.to_string(),
        url: format!("/collaborate/{}", session_id),
    }))
}

pub async fn save_collaborative_session(
    Path(session_uuid): Path<Uuid>,
    auth_session: AuthSession,
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<SaveSessionResponse>, AppError> {
    let user = auth_session
        .user
        .ok_or_else(|| anyhow::anyhow!("Authentication required"))?;

    let db = &state.db_pool;

    let session = sqlx::query!(
        r#"
        SELECT owner_id, saved_post_id, u.login_name as owner_login_name 
        FROM collaborative_sessions cs
        JOIN users u ON cs.owner_id = u.id
        WHERE cs.id = $1
        "#,
        session_uuid
    )
    .fetch_optional(db)
    .await?
    .ok_or_else(|| anyhow::anyhow!("Session not found"))?;

    if session.owner_id != user.id {
        return Err(anyhow::anyhow!("Only session owner can save").into());
    }

    if session.saved_post_id.is_some() {
        return Err(anyhow::anyhow!("Session has already been saved").into());
    }

    let png_data = body.to_vec();

    let (post_id, owner_login_name) =
        db::save_session_to_post(db.clone(), session_uuid, user.id, png_data, state.clone())
            .await
            .map_err(|e| anyhow::anyhow!("Save failed: {}", e))?;

    let post_url = format!("/@{}/{}", owner_login_name, post_id);

    // Note: Session ending and participant notification will be handled by the WebSocket END_SESSION message
    // that the client sends after receiving this HTTP response. This prevents double-broadcasting.

    Ok(Json(SaveSessionResponse {
        post_id: post_id.to_string(),
        owner_login_name,
        post_url,
    }))
}

pub async fn serve_collaborative_app() -> Result<Response, AppError> {
    let html = std::fs::read_to_string("neo-cucumber/dist/index.html")
        .map_err(|_| anyhow::anyhow!("Failed to load collaborative app"))?;
    Ok(Html(html).into_response())
}

pub async fn get_active_sessions_json(
    auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<Json<Vec<SessionWithCounts>>, AppError> {
    let _user = match auth_session.user {
        Some(user) => user,
        None => return Err(anyhow::anyhow!("Authentication required").into()),
    };

    let db = &state.db_pool;

    let active_sessions = sqlx::query_as!(
        SessionWithCounts,
        r#"
        SELECT
            cs.id,
            u.login_name as owner_login_name,
            cs.title,
            cs.width,
            cs.height,
            cs.created_at,
            COALESCE(COUNT(DISTINCT csp.user_id) FILTER (WHERE csp.is_active = true), 0) as participant_count
        FROM collaborative_sessions cs
        JOIN users u ON cs.owner_id = u.id
        JOIN communities c ON cs.community_id = c.id
        LEFT JOIN collaborative_sessions_participants csp ON cs.id = csp.session_id
        WHERE cs.is_public = true
          AND cs.ended_at IS NULL
          AND c.visibility = 'public'
        GROUP BY cs.id, u.login_name, cs.max_participants
        HAVING COALESCE(COUNT(DISTINCT csp.user_id) FILTER (WHERE csp.is_active = true), 0) < cs.max_participants
        ORDER BY cs.last_activity DESC
        LIMIT 20
        "#
    )
    .fetch_all(db)
    .await?;

    Ok(Json(active_sessions))
}
