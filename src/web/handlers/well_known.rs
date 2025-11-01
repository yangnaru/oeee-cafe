use axum::{http::StatusCode, response::IntoResponse, Json};
use serde_json::json;

/// Handler for Apple App Site Association (Universal Links)
/// This endpoint is used by iOS to verify the app's association with the domain
/// More info: https://developer.apple.com/documentation/xcode/supporting-associated-domains
pub async fn apple_app_site_association() -> impl IntoResponse {
    let association = json!({
        "webcredentials": {
            "apps": ["K4CQ85R27U.cafe.oeee"]
        }
    });

    (StatusCode::OK, Json(association))
}
