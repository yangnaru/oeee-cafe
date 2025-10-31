use a2::{
    Client, ClientConfig, DefaultNotificationBuilder, Endpoint, ErrorReason, NotificationBuilder,
    NotificationOptions,
};
use std::fs::File;
use std::sync::Arc;

use super::PushError;

#[derive(Clone)]
pub struct ApnsClient {
    client: Arc<Client>,
}

impl ApnsClient {
    pub fn new(key_path: &str, key_id: &str, team_id: &str, environment: &str) -> Result<Self, anyhow::Error> {
        let mut key_file = File::open(key_path)?;

        let endpoint = match environment {
            "production" => Endpoint::Production,
            _ => Endpoint::Sandbox,
        };

        let config = ClientConfig::new(endpoint);
        let client = Client::token(&mut key_file, key_id, team_id, config)?;

        Ok(Self {
            client: Arc::new(client),
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
        let mut builder = DefaultNotificationBuilder::new()
            .set_title(title)
            .set_body(body)
            .set_sound("default");

        if let Some(badge_count) = badge {
            builder = builder.set_badge(badge_count);
        }

        // Build the notification payload
        let mut payload = builder.build(device_token, NotificationOptions::default());

        // Add custom data if provided
        if let Some(ref custom_data) = data {
            if let Some(data_obj) = custom_data.as_object() {
                for (key, value) in data_obj {
                    payload.add_custom_data(key, value)
                        .map_err(|e| PushError::Other(anyhow::anyhow!("Failed to add custom data: {:?}", e)))?;
                }
            }
        }

        let response = self.client.send(payload).await
            .map_err(|e| PushError::Other(anyhow::anyhow!("APNs send error: {:?}", e)))?;

        // Check for errors in the response indicating invalid token
        if let Some(error) = response.error {
            match error.reason {
                ErrorReason::Unregistered
                | ErrorReason::BadDeviceToken
                | ErrorReason::DeviceTokenNotForTopic => {
                    return Err(PushError::InvalidToken);
                }
                _ => {
                    return Err(PushError::Other(anyhow::anyhow!("APNs error: {:?}", error)));
                }
            }
        }

        Ok(())
    }
}
