use std::time::Duration;

use config::{Config, ConfigError, Environment, File};
use serde::{Deserialize, Serialize};
use serde_with::{serde_as, DurationSeconds};

#[serde_as]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AppConfig {
    pub env: String,
    pub base_url: String,
    pub domain: String,
    pub port: u16,

    pub db_url: String,
    pub db_max_connections: u32,
    #[serde_as(as = "DurationSeconds<u64>")]
    pub db_acquire_timeout: Duration,

    pub redis_url: String,
    pub redis_max_connections: u32,
    #[serde_as(as = "DurationSeconds<u64>")]
    pub redis_acquire_timeout: Duration,

    pub official_account_login_name: String,

    pub aws_access_key_id: String,
    pub aws_secret_access_key: String,
    pub aws_region: String,
    pub aws_s3_bucket: String,
    pub r2_endpoint_url: String,
    pub r2_public_endpoint_url: String,

    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_user: String,
    pub smtp_password: String,

    // APNs configuration
    pub apns_key_id: String,
    pub apns_team_id: String,
    pub apns_key_path: String,
    pub apns_environment: String, // "production" or "sandbox"
    pub apns_topic: String,       // App bundle ID

    // FCM configuration (V1 API)
    pub fcm_service_account_path: String,
    pub fcm_project_id: String,
}

impl AppConfig {
    pub fn new_from_file_and_env(path: &str) -> Result<Self, ConfigError> {
        Config::builder()
            .add_source(File::with_name(path))
            .add_source(Environment::with_prefix("oeee"))
            .build()
            .and_then(|cfg| cfg.try_deserialize::<Self>())
    }

    /// Determines whether to use ActivityPub message queueing.
    /// Returns true in production for reliability (automatic retries on failure),
    /// false in development for easier debugging (immediate sending).
    pub fn use_activitypub_queue(&self) -> bool {
        self.env == "production"
    }
}
