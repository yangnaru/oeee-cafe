use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{debug, info};
use uuid::Uuid;

use crate::redis::RedisPool;

// Redis key prefixes
const ACTIVITY_PREFIX: &str = "oeee:activity:";
const RESET_PENDING_PREFIX: &str = "oeee:reset_pending:";
const CONNECTION_PREFIX: &str = "oeee:connection:";
const ROOM_PREFIX: &str = "oeee:room:";
const PUBSUB_PREFIX: &str = "oeee:pubsub:";

// TTL constants
const ACTIVITY_TTL: u64 = 3600; // 1 hour
const RESET_PENDING_TTL: u64 = 120; // retry window if the reset client stalls
const CONNECTION_TTL: u64 = 30; // 30 seconds (with heartbeat)

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionInfo {
    pub connection_id: String,
    pub user_id: Uuid,
    pub room_id: Uuid,
    pub user_login_name: String,
    pub server_instance: String,
    pub connected_at: u64,
    pub last_heartbeat: u64,
}

// Serializes the binary payload as base64 (~1.33x) instead of serde_json's
// default number array (~3.7x), which matters for snapshot-sized messages on
// the pub/sub channel. Deserialization also accepts the old number-array form
// so envelopes from a previous server version still parse during a deploy.
mod base64_payload {
    use data_encoding::BASE64;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&BASE64.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum PayloadRepr {
            Base64(String),
            Raw(Vec<u8>),
        }

        match PayloadRepr::deserialize(deserializer)? {
            PayloadRepr::Base64(s) => BASE64
                .decode(s.as_bytes())
                .map_err(serde::de::Error::custom),
            PayloadRepr::Raw(bytes) => Ok(bytes),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomMessage {
    pub from_connection: String,
    pub user_id: Uuid,
    pub user_login_name: String,
    pub message_type: String, // "websocket" | "join" | "leave" | "end_session"
    #[serde(with = "base64_payload")]
    pub payload: Vec<u8>,
    pub timestamp: u64,
    // Canonical sequence number assigned by the atomic sequencer for messages
    // that are part of session history; None for ephemeral messages.
    #[serde(default)]
    pub seq: Option<u64>,
    // When set, the message is delivered only to this connection (e.g. a
    // RESET_REQUEST addressed to the client chosen to upload a session reset).
    #[serde(default)]
    pub target_connection: Option<String>,
}

#[derive(Clone)]
pub struct RedisStateManager {
    pool: RedisPool,
    server_instance_id: String,
}

impl RedisStateManager {
    pub fn new(pool: RedisPool) -> Self {
        let server_instance_id = format!("oeee-{}", Uuid::new_v4());
        Self {
            pool,
            server_instance_id,
        }
    }

    pub fn get_server_instance_id(&self) -> &str {
        &self.server_instance_id
    }

    // Activity Cache Management
    pub async fn update_room_activity(
        &self,
        room_uuid: Uuid,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", ACTIVITY_PREFIX, room_uuid);
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

        conn.set::<_, _, ()>(&key, timestamp).await?;
        conn.expire::<_, ()>(&key, ACTIVITY_TTL as i64).await?;
        debug!(
            "Updated activity cache for room {} at timestamp {}",
            room_uuid, timestamp
        );
        Ok(())
    }

    pub async fn get_room_activity(
        &self,
        room_uuid: Uuid,
    ) -> Result<Option<u64>, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", ACTIVITY_PREFIX, room_uuid);

        let timestamp = conn.get::<_, Option<u64>>(&key).await?;
        Ok(timestamp)
    }

    pub async fn cleanup_room_activity(
        &self,
        room_uuid: Uuid,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", ACTIVITY_PREFIX, room_uuid);

        let deleted: bool = conn.del(&key).await?;
        if deleted {
            debug!("Cleaned up activity cache for room {}", room_uuid);
        }
        Ok(())
    }

    // Session Reset Tracking
    //
    // At most one session reset is requested at a time per room; the flag
    // expires so a stalled or disconnected reset client only delays the next
    // attempt instead of blocking resets forever.
    pub async fn try_acquire_reset_pending(
        &self,
        room_uuid: Uuid,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", RESET_PENDING_PREFIX, room_uuid);

        let acquired: bool = redis::cmd("SET")
            .arg(&key)
            .arg(1u8)
            .arg("NX")
            .arg("EX")
            .arg(RESET_PENDING_TTL)
            .query_async::<Option<String>>(&mut *conn)
            .await?
            .is_some();

        if acquired {
            debug!("Acquired reset-pending flag for room {}", room_uuid);
        }
        Ok(acquired)
    }

    pub async fn clear_reset_pending(
        &self,
        room_uuid: Uuid,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", RESET_PENDING_PREFIX, room_uuid);
        conn.del::<_, ()>(&key).await?;
        Ok(())
    }

    // Connection Registry
    pub async fn register_connection(
        &self,
        connection_info: &ConnectionInfo,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", CONNECTION_PREFIX, connection_info.connection_id);

        let serialized = serde_json::to_string(connection_info)?;
        conn.set::<_, _, ()>(&key, &serialized).await?;
        conn.expire::<_, ()>(&key, CONNECTION_TTL as i64).await?;

        // Also track connection in room set
        let room_key = format!("{}{}:connections", ROOM_PREFIX, connection_info.room_id);
        conn.sadd::<_, _, ()>(&room_key, &connection_info.connection_id)
            .await?;
        conn.expire::<_, ()>(&room_key, CONNECTION_TTL as i64)
            .await?;

        debug!(
            "Registered connection {} for user {} in room {}",
            connection_info.connection_id, connection_info.user_id, connection_info.room_id
        );
        Ok(())
    }

    pub async fn heartbeat_connection(
        &self,
        connection_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", CONNECTION_PREFIX, connection_id);

        // Get existing connection info
        if let Some(info_str) = conn.get::<_, Option<String>>(&key).await? {
            let mut connection_info: ConnectionInfo = serde_json::from_str(&info_str)?;
            connection_info.last_heartbeat =
                SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

            let serialized = serde_json::to_string(&connection_info)?;
            conn.set::<_, _, ()>(&key, &serialized).await?;
            conn.expire::<_, ()>(&key, CONNECTION_TTL as i64).await?;

            debug!("Updated heartbeat for connection {}", connection_id);
            Ok(true)
        } else {
            debug!("Connection {} not found for heartbeat", connection_id);
            Ok(false)
        }
    }

    pub async fn get_connection_info(
        &self,
        connection_id: &str,
    ) -> Result<Option<ConnectionInfo>, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", CONNECTION_PREFIX, connection_id);

        if let Some(info_str) = conn.get::<_, Option<String>>(&key).await? {
            let connection_info: ConnectionInfo = serde_json::from_str(&info_str)?;
            Ok(Some(connection_info))
        } else {
            Ok(None)
        }
    }

    pub async fn unregister_connection(
        &self,
        connection_id: &str,
    ) -> Result<Option<ConnectionInfo>, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", CONNECTION_PREFIX, connection_id);

        // Get connection info before deletion
        let connection_info = if let Some(info_str) = conn.get::<_, Option<String>>(&key).await? {
            Some(serde_json::from_str::<ConnectionInfo>(&info_str)?)
        } else {
            None
        };

        // Remove from Redis
        conn.del::<_, ()>(&key).await?;

        // Remove from room set if we have the info
        if let Some(ref info) = connection_info {
            let room_key = format!("{}{}:connections", ROOM_PREFIX, info.room_id);
            conn.srem::<_, _, ()>(&room_key, connection_id).await?;
        }

        debug!("Unregistered connection {}", connection_id);
        Ok(connection_info)
    }

    pub async fn get_room_connections(
        &self,
        room_uuid: Uuid,
    ) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let room_key = format!("{}{}:connections", ROOM_PREFIX, room_uuid);

        let connections = conn.smembers::<_, Vec<String>>(&room_key).await?;
        debug!(
            "Found {} connections in room {}",
            connections.len(),
            room_uuid
        );
        Ok(connections)
    }

    // Pub/Sub for message broadcasting
    pub async fn publish_message(
        &self,
        room_uuid: Uuid,
        message: &RoomMessage,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let channel = format!("{}{}", PUBSUB_PREFIX, room_uuid);

        let serialized = serde_json::to_string(message)?;
        let subscriber_count: usize = conn.publish(&channel, &serialized).await?;

        debug!(
            "Published message to {} subscribers in room {}",
            subscriber_count, room_uuid
        );
        Ok(subscriber_count)
    }

    // Create a dedicated Redis Pub/Sub connection for a specific room
    pub async fn create_room_subscriber(
        &self,
        room_uuid: Uuid,
        redis_url: &str,
    ) -> Result<redis::aio::PubSub, Box<dyn std::error::Error + Send + Sync>> {
        // Create a new dedicated connection for Pub/Sub (can't use pooled connections)
        let client = redis::Client::open(redis_url)?;
        let mut pubsub = client.get_async_pubsub().await?;

        let channel = self.get_room_channel(room_uuid);
        pubsub.subscribe(&channel).await?;

        debug!(
            "Created Redis subscriber for room {} on channel {}",
            room_uuid, channel
        );
        Ok(pubsub)
    }

    pub fn get_room_channel(&self, room_uuid: Uuid) -> String {
        format!("{}{}", PUBSUB_PREFIX, room_uuid)
    }

    pub async fn cleanup_room_state(
        &self,
        room_uuid: Uuid,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;

        // Clean up all room-related keys
        let patterns = [
            format!("{}{}:*", ROOM_PREFIX, room_uuid),
            format!("{}{}", ACTIVITY_PREFIX, room_uuid),
            format!("{}{}", RESET_PENDING_PREFIX, room_uuid),
        ];

        let mut total_deleted = 0;
        for pattern in &patterns {
            let keys = conn.keys::<_, Vec<String>>(pattern).await?;
            if !keys.is_empty() {
                let deleted: usize = conn.del(&keys).await?;
                total_deleted += deleted;
            }
        }

        info!(
            "Cleaned up {} Redis keys for room {}",
            total_deleted, room_uuid
        );
        Ok(())
    }
}
