use crate::models::push_token::{
    delete_push_token, get_user_tokens, register_push_token, PlatformType, PushToken,
};
use crate::models::user::AuthSession;
use crate::web::state::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct RegisterPushTokenRequest {
    pub device_token: String,
    pub platform: PlatformType,
}

#[derive(Debug, Serialize)]
pub struct PushTokenResponse {
    pub id: String,
    pub device_token: String,
    pub platform: PlatformType,
    pub created_at: String,
}

impl From<PushToken> for PushTokenResponse {
    fn from(token: PushToken) -> Self {
        Self {
            id: token.id.to_string(),
            device_token: token.device_token,
            platform: token.platform,
            created_at: token.created_at.to_rfc3339(),
        }
    }
}

/// Register a push token for the authenticated user
pub async fn register_push_token_handler(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Json(payload): Json<RegisterPushTokenRequest>,
) -> Result<Json<PushTokenResponse>, StatusCode> {
    let user = auth_session.user.ok_or(StatusCode::UNAUTHORIZED)?;

    let mut tx = state
        .db_pool
        .begin()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let token = register_push_token(
        &mut tx,
        user.id,
        payload.device_token,
        payload.platform,
    )
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    tx.commit()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(token.into()))
}

/// Delete a push token for the authenticated user
pub async fn delete_push_token_handler(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(device_token): Path<String>,
) -> Result<StatusCode, StatusCode> {
    let user = auth_session.user.ok_or(StatusCode::UNAUTHORIZED)?;

    let mut tx = state
        .db_pool
        .begin()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let deleted = delete_push_token(&mut tx, user.id, device_token)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    tx.commit()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Ok(StatusCode::NOT_FOUND)
    }
}

/// List all push tokens for the authenticated user
pub async fn list_push_tokens_handler(
    auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<Json<Vec<PushTokenResponse>>, StatusCode> {
    let user = auth_session.user.ok_or(StatusCode::UNAUTHORIZED)?;

    let mut tx = state
        .db_pool
        .begin()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let tokens = get_user_tokens(&mut tx, user.id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    tx.commit()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let response: Vec<PushTokenResponse> = tokens.into_iter().map(|t| t.into()).collect();

    Ok(Json(response))
}
