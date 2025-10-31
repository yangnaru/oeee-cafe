pub mod apns;
pub mod fcm;

use crate::models::push_token::{delete_invalid_token, get_user_tokens_by_platform, PlatformType};
use crate::AppConfig;
use anyhow::Result;
use apns::ApnsClient;
use fcm::FcmClient;
use sqlx::PgPool;

#[derive(Debug)]
pub enum PushError {
    InvalidToken,
    Other(anyhow::Error),
}

impl From<anyhow::Error> for PushError {
    fn from(err: anyhow::Error) -> Self {
        PushError::Other(err)
    }
}

#[derive(Clone)]
pub struct PushService {
    apns_client: Option<ApnsClient>,
    fcm_client: Option<FcmClient>,
    fcm_server_key: String,
    db_pool: PgPool,
}

impl PushService {
    pub fn new(config: &AppConfig, db_pool: PgPool) -> Result<Self> {
        let apns_client = if !config.apns_key_path.is_empty() {
            match ApnsClient::new(
                &config.apns_key_path,
                &config.apns_key_id,
                &config.apns_team_id,
                &config.apns_environment,
            ) {
                Ok(client) => {
                    tracing::info!("APNs client initialized successfully");
                    Some(client)
                }
                Err(e) => {
                    tracing::warn!("Failed to initialize APNs client: {:?}", e);
                    None
                }
            }
        } else {
            tracing::warn!("APNs configuration not provided, push notifications for iOS will not work");
            None
        };

        let fcm_client = if !config.fcm_server_key.is_empty() {
            tracing::info!("FCM client initialized successfully");
            Some(FcmClient::new(&config.fcm_server_key))
        } else {
            tracing::warn!("FCM configuration not provided, push notifications for Android will not work");
            None
        };

        Ok(Self {
            apns_client,
            fcm_client,
            fcm_server_key: config.fcm_server_key.clone(),
            db_pool,
        })
    }

    pub async fn send_notification_to_user(
        &self,
        user_id: uuid::Uuid,
        title: &str,
        body: &str,
        badge: Option<u32>,
        data: Option<serde_json::Value>,
    ) -> Result<()> {
        // Get user's tokens from database
        let mut tx = self.db_pool.begin().await?;

        // Send to iOS devices
        if self.apns_client.is_some() {
            let ios_tokens = get_user_tokens_by_platform(&mut tx, user_id, PlatformType::Ios).await?;
            for token in ios_tokens {
                match self
                    .send_to_apns(&token.device_token, title, body, badge, data.clone())
                    .await
                {
                    Ok(_) => {}
                    Err(PushError::InvalidToken) => {
                        tracing::info!(
                            "Removing invalid APNs token: {}",
                            token.device_token
                        );
                        let _ = delete_invalid_token(&mut tx, token.device_token.clone(), PlatformType::Ios).await;
                    }
                    Err(PushError::Other(e)) => {
                        tracing::warn!(
                            "Failed to send APNs notification to token {}: {:?}",
                            token.device_token,
                            e
                        );
                    }
                }
            }
        }

        // Send to Android devices
        if self.fcm_client.is_some() {
            let android_tokens =
                get_user_tokens_by_platform(&mut tx, user_id, PlatformType::Android).await?;
            for token in android_tokens {
                match self
                    .send_to_fcm(&token.device_token, title, body, badge, data.clone())
                    .await
                {
                    Ok(_) => {}
                    Err(PushError::InvalidToken) => {
                        tracing::info!(
                            "Removing invalid FCM token: {}",
                            token.device_token
                        );
                        let _ = delete_invalid_token(&mut tx, token.device_token.clone(), PlatformType::Android).await;
                    }
                    Err(PushError::Other(e)) => {
                        tracing::warn!(
                            "Failed to send FCM notification to token {}: {:?}",
                            token.device_token,
                            e
                        );
                    }
                }
            }
        }

        tx.commit().await?;
        Ok(())
    }

    async fn send_to_apns(
        &self,
        device_token: &str,
        title: &str,
        body: &str,
        badge: Option<u32>,
        data: Option<serde_json::Value>,
    ) -> Result<(), PushError> {
        if let Some(client) = &self.apns_client {
            client
                .send_notification(device_token, title, body, badge, data)
                .await?;
        }
        Ok(())
    }

    async fn send_to_fcm(
        &self,
        device_token: &str,
        title: &str,
        body: &str,
        badge: Option<u32>,
        data: Option<serde_json::Value>,
    ) -> Result<(), PushError> {
        if let Some(client) = &self.fcm_client {
            client
                .send_notification(&self.fcm_server_key, device_token, title, body, badge, data)
                .await?;
        }
        Ok(())
    }
}
