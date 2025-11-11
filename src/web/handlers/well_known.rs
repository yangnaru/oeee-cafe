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

/// Handler for Android Digital Asset Links (App Links & Credentials)
/// This endpoint is used by Android to verify the app's association with the domain
/// More info: https://developer.android.com/training/app-links/verify-android-applinks
///
/// To get the SHA256 certificate fingerprint, run:
/// For debug: keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android
/// For release: keytool -list -v -keystore /path/to/your/release.keystore
pub async fn android_assetlinks() -> impl IntoResponse {
    let assetlinks = json!([
        {
            "relation": ["delegate_permission/common.get_login_creds"],
            "target": {
                "namespace": "android_app",
                "package_name": "cafe.oeee",
                "sha256_cert_fingerprints": [
                    "35:C4:51:56:59:EB:B9:B6:08:30:0F:51:44:29:95:74:4A:2F:3C:1A:23:01:A5:C6:24:C5:0F:2E:DC:2D:72:49",
                ]
            }
        }
    ]);

    (StatusCode::OK, Json(assetlinks))
}
