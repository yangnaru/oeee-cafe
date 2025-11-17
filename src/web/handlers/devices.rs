use crate::models::device::{
    delete_device_by_token, get_user_devices, register_device, Device, PlatformType,
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
pub struct RegisterDeviceRequest {
    pub device_token: String,
    pub platform: PlatformType,
}

#[derive(Debug, Serialize)]
pub struct DeviceResponse {
    pub id: String,
    pub device_token: String,
    pub platform: PlatformType,
    pub created_at: String,
}

impl From<Device> for DeviceResponse {
    fn from(device: Device) -> Self {
        Self {
            id: device.id.to_string(),
            device_token: device.device_token,
            platform: device.platform,
            created_at: device.created_at.to_rfc3339(),
        }
    }
}

/// Register a device for the authenticated user
pub async fn register_device_handler(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Json(payload): Json<RegisterDeviceRequest>,
) -> Result<Json<DeviceResponse>, StatusCode> {
    let user = auth_session.user.ok_or(StatusCode::UNAUTHORIZED)?;

    let mut tx = state
        .db_pool
        .begin()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let device = register_device(&mut tx, user.id, payload.device_token, payload.platform)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    tx.commit()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(device.into()))
}

/// Delete a device by device token (unauthenticated)
/// Device tokens are cryptographically unguessable, so possession of the token
/// is sufficient authentication
pub async fn delete_device_handler(
    State(state): State<AppState>,
    Path(device_token): Path<String>,
) -> Result<StatusCode, StatusCode> {
    let mut tx = state
        .db_pool
        .begin()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let deleted = delete_device_by_token(&mut tx, device_token)
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

/// List all devices for the authenticated user
pub async fn list_devices_handler(
    auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<Json<Vec<DeviceResponse>>, StatusCode> {
    let user = auth_session.user.ok_or(StatusCode::UNAUTHORIZED)?;

    let mut tx = state
        .db_pool
        .begin()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let devices = get_user_devices(&mut tx, user.id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    tx.commit()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let response: Vec<DeviceResponse> = devices.into_iter().map(|d| d.into()).collect();

    Ok(Json(response))
}
