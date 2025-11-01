use google_fcm1::api::{AndroidConfig, AndroidNotification, Message, Notification};
use google_fcm1::hyper_rustls;
use google_fcm1::FirebaseCloudMessaging;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use std::sync::Arc;
use yup_oauth2::ServiceAccountAuthenticator;

use super::PushError;

#[derive(Clone)]
pub struct FcmClient {
    hub: Arc<FirebaseCloudMessaging<hyper_rustls::HttpsConnector<HttpConnector>>>,
    project_id: String,
}

impl FcmClient {
    pub async fn new(service_account_path: &str, project_id: &str) -> Result<Self, anyhow::Error> {
        // Read the service account key
        let service_account_key = yup_oauth2::read_service_account_key(service_account_path).await?;

        // Create an authenticator
        let auth = ServiceAccountAuthenticator::builder(service_account_key)
            .build()
            .await?;

        // Create the HTTP client with Hyper 1.0
        let https = hyper_rustls::HttpsConnectorBuilder::new()
            .with_native_roots()?
            .https_or_http()
            .enable_http1()
            .enable_http2()
            .build();

        let client = hyper_util::client::legacy::Client::builder(TokioExecutor::new())
            .build(https);

        // Create the FCM hub
        let hub = FirebaseCloudMessaging::new(client, auth);

        Ok(Self {
            hub: Arc::new(hub),
            project_id: project_id.to_string(),
        })
    }

    pub async fn send_notification(
        &self,
        device_token: &str,
        title: &str,
        body: &str,
        badge: Option<u32>,
        data: Option<serde_json::Value>,
    ) -> Result<(), PushError> {
        // Build the notification
        let notification = Notification {
            title: Some(title.to_string()),
            body: Some(body.to_string()),
            ..Default::default()
        };

        // Build Android-specific configuration
        let mut android_notification = AndroidNotification {
            sound: Some("default".to_string()),
            ..Default::default()
        };

        // Add badge count if provided
        if let Some(badge_count) = badge {
            android_notification.notification_count = Some(badge_count as i32);
        }

        let android_config = AndroidConfig {
            priority: Some("high".to_string()),
            notification: Some(android_notification),
            ..Default::default()
        };

        // Convert custom data to HashMap<String, String>
        let mut data_map = None;
        if let Some(custom_data) = data {
            if let Some(obj) = custom_data.as_object() {
                let mut map = std::collections::HashMap::new();
                for (key, value) in obj {
                    // FCM V1 API requires all data values to be strings
                    if let Some(str_value) = value.as_str() {
                        map.insert(key.clone(), str_value.to_string());
                    } else {
                        map.insert(key.clone(), value.to_string());
                    }
                }
                if !map.is_empty() {
                    data_map = Some(map);
                }
            }
        }

        // Build the message
        let message = Message {
            token: Some(device_token.to_string()),
            notification: Some(notification),
            android: Some(android_config),
            data: data_map,
            ..Default::default()
        };

        // Create the send request
        let parent = format!("projects/{}", self.project_id);
        let req = google_fcm1::api::SendMessageRequest {
            message: Some(message),
            validate_only: Some(false),
        };

        // Send the message
        let result = self.hub
            .projects()
            .messages_send(req, &parent)
            .doit()
            .await;

        match result {
            Ok(_) => Ok(()),
            Err(e) => {
                let error_string = format!("{:?}", e);

                // Check for invalid registration errors
                if error_string.contains("UNREGISTERED")
                    || error_string.contains("INVALID_ARGUMENT")
                    || error_string.contains("NOT_FOUND")
                    || error_string.contains("InvalidRegistration")
                {
                    return Err(PushError::InvalidToken);
                }

                Err(PushError::Other(anyhow::anyhow!(
                    "FCM error: {:?}",
                    e
                )))
            }
        }
    }
}
