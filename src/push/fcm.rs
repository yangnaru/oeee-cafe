use fcm::{Client, ErrorReason, MessageBuilder, NotificationBuilder, Priority};
use std::collections::HashMap;
use std::sync::Arc;

use super::PushError;

#[derive(Clone)]
pub struct FcmClient {
    client: Arc<Client>,
}

impl FcmClient {
    pub fn new(_server_key: &str) -> Self {
        let client = Client::new();
        Self {
            client: Arc::new(client),
        }
    }

    pub async fn send_notification(
        &self,
        server_key: &str,
        device_token: &str,
        title: &str,
        body: &str,
        badge: Option<u32>,
        data: Option<serde_json::Value>,
    ) -> Result<(), PushError> {
        let mut notification_builder = NotificationBuilder::new();
        notification_builder.title(title);
        notification_builder.body(body);
        notification_builder.sound("default");

        let badge_string;
        if let Some(badge_count) = badge {
            badge_string = badge_count.to_string();
            notification_builder.badge(&badge_string);
        }

        let notification = notification_builder.finalize();

        let mut message_builder = MessageBuilder::new(server_key, device_token);
        message_builder.notification(notification);
        message_builder.priority(Priority::High);

        // Add custom data if provided
        if let Some(custom_data) = data {
            if let Some(obj) = custom_data.as_object() {
                let mut data_map: HashMap<String, String> = HashMap::new();
                for (key, value) in obj {
                    if let Some(str_value) = value.as_str() {
                        data_map.insert(key.clone(), str_value.to_string());
                    } else {
                        data_map.insert(key.clone(), value.to_string());
                    }
                }
                if !data_map.is_empty() {
                    message_builder.data(&data_map)
                        .map_err(|e| PushError::Other(anyhow::anyhow!("FCM data error: {:?}", e)))?;
                }
            }
        }

        let response = self.client.send(message_builder.finalize()).await
            .map_err(|e| PushError::Other(anyhow::anyhow!("FCM send error: {:?}", e)))?;

        // Check for errors in the response
        if response.error.is_some() {
            return Err(PushError::Other(anyhow::anyhow!("FCM error: {:?}", response.error)));
        }

        if response.results.is_some() {
            let results = response.results.unwrap();
            for result in results {
                if let Some(error) = result.error {
                    // Check if it's an invalid token error
                    match error {
                        ErrorReason::NotRegistered | ErrorReason::InvalidRegistration => {
                            return Err(PushError::InvalidToken);
                        }
                        _ => {
                            return Err(PushError::Other(anyhow::anyhow!("FCM result error: {:?}", error)));
                        }
                    }
                }
            }
        }

        Ok(())
    }
}
