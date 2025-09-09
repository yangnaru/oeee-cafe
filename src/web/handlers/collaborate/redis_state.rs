use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{debug, info};
use uuid::Uuid;

use crate::redis::RedisPool;

// Redis key prefixes
const ACTIVITY_PREFIX: &str = "oeee:activity:";
const SNAPSHOT_REQ_PREFIX: &str = "oeee:snapshot_req:";
const CONNECTION_PREFIX: &str = "oeee:connection:";
const ROOM_PREFIX: &str = "oeee:room:";
const PUBSUB_PREFIX: &str = "oeee:pubsub:";

// TTL constants
const ACTIVITY_TTL: u64 = 3600; // 1 hour
const SNAPSHOT_REQ_TTL: u64 = 300; // 5 minutes
const CONNECTION_TTL: u64 = 30; // 30 seconds (with heartbeat)
const ROOM_PRESENCE_TTL: u64 = 60; // 1 minute

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomMessage {
    pub from_connection: String,
    pub user_id: Uuid,
    pub user_login_name: String,
    pub message_type: String, // "websocket" | "join" | "leave" | "end_session"
    pub payload: Vec<u8>,
    pub timestamp: u64,
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
    pub async fn update_room_activity(&self, room_uuid: Uuid) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", ACTIVITY_PREFIX, room_uuid);
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        
        conn.set::<_, _, ()>(&key, timestamp).await?;
        conn.expire::<_, ()>(&key, ACTIVITY_TTL as i64).await?;
        debug!("Updated activity cache for room {} at timestamp {}", room_uuid, timestamp);
        Ok(())
    }

    pub async fn get_room_activity(&self, room_uuid: Uuid) -> Result<Option<u64>, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", ACTIVITY_PREFIX, room_uuid);
        
        let timestamp = conn.get::<_, Option<u64>>(&key).await?;
        Ok(timestamp)
    }

    pub async fn cleanup_room_activity(&self, room_uuid: Uuid) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", ACTIVITY_PREFIX, room_uuid);
        
        let deleted: bool = conn.del(&key).await?;
        if deleted {
            debug!("Cleaned up activity cache for room {}", room_uuid);
        }
        Ok(())
    }

    // Snapshot Request Tracking
    pub async fn set_snapshot_requested(&self, room_uuid: Uuid, user_id: Uuid, requested: bool) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}:{}", SNAPSHOT_REQ_PREFIX, room_uuid, user_id);
        
        if requested {
            conn.set::<_, _, ()>(&key, 1u8).await?;
        } else {
            conn.set::<_, _, ()>(&key, 0u8).await?;
        }
        conn.expire::<_, ()>(&key, SNAPSHOT_REQ_TTL as i64).await?;
        
        debug!("Set snapshot request for user {} in room {} to {}", user_id, room_uuid, requested);
        Ok(())
    }

    pub async fn is_snapshot_requested(&self, room_uuid: Uuid, user_id: Uuid) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}:{}", SNAPSHOT_REQ_PREFIX, room_uuid, user_id);
        
        let value = conn.get::<_, Option<u8>>(&key).await?;
        Ok(value.unwrap_or(0) != 0)
    }

    pub async fn cleanup_snapshot_requests(&self, room_uuid: Uuid) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let pattern = format!("{}{}:*", SNAPSHOT_REQ_PREFIX, room_uuid);
        
        let keys = conn.keys::<_, Vec<String>>(&pattern).await?;
        let count = keys.len();
        
        if count > 0 {
            let deleted: usize = conn.del(&keys).await?;
            debug!("Cleaned up {} snapshot request trackers for room {}", deleted, room_uuid);
        }
        
        Ok(count)
    }

    // Connection Registry
    pub async fn register_connection(&self, connection_info: &ConnectionInfo) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", CONNECTION_PREFIX, connection_info.connection_id);
        
        let serialized = serde_json::to_string(connection_info)?;
        conn.set::<_, _, ()>(&key, &serialized).await?;
        conn.expire::<_, ()>(&key, CONNECTION_TTL as i64).await?;
        
        // Also track connection in room set
        let room_key = format!("{}{}:connections", ROOM_PREFIX, connection_info.room_id);
        conn.sadd::<_, _, ()>(&room_key, &connection_info.connection_id).await?;
        conn.expire::<_, ()>(&room_key, ROOM_PRESENCE_TTL as i64).await?;
        
        debug!("Registered connection {} for user {} in room {}", 
               connection_info.connection_id, connection_info.user_id, connection_info.room_id);
        Ok(())
    }

    pub async fn heartbeat_connection(&self, connection_id: &str) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", CONNECTION_PREFIX, connection_id);
        
        // Get existing connection info
        if let Some(info_str) = conn.get::<_, Option<String>>(&key).await? {
            let mut connection_info: ConnectionInfo = serde_json::from_str(&info_str)?;
            connection_info.last_heartbeat = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
            
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

    pub async fn get_connection_info(&self, connection_id: &str) -> Result<Option<ConnectionInfo>, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", CONNECTION_PREFIX, connection_id);
        
        if let Some(info_str) = conn.get::<_, Option<String>>(&key).await? {
            let connection_info: ConnectionInfo = serde_json::from_str(&info_str)?;
            Ok(Some(connection_info))
        } else {
            Ok(None)
        }
    }

    pub async fn unregister_connection(&self, connection_id: &str) -> Result<Option<ConnectionInfo>, Box<dyn std::error::Error + Send + Sync>> {
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

    pub async fn get_room_connections(&self, room_uuid: Uuid) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let room_key = format!("{}{}:connections", ROOM_PREFIX, room_uuid);
        
        let connections = conn.smembers::<_, Vec<String>>(&room_key).await?;
        debug!("Found {} connections in room {}", connections.len(), room_uuid);
        Ok(connections)
    }

    // Pub/Sub for message broadcasting
    pub async fn publish_message(&self, room_uuid: Uuid, message: &RoomMessage) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let channel = format!("{}{}", PUBSUB_PREFIX, room_uuid);
        
        let serialized = serde_json::to_string(message)?;
        let subscriber_count: usize = conn.publish(&channel, &serialized).await?;
        
        debug!("Published message to {} subscribers in room {}", subscriber_count, room_uuid);
        Ok(subscriber_count)
    }

    // Create a dedicated Redis Pub/Sub connection for a specific room
    pub async fn create_room_subscriber(&self, room_uuid: Uuid) -> Result<redis::aio::PubSub, Box<dyn std::error::Error + Send + Sync>> {
        // Create a new dedicated connection for Pub/Sub (can't use pooled connections)
        let client = redis::Client::open(self.get_redis_url().await?)?;
        let mut pubsub = client.get_async_pubsub().await?;
        
        let channel = self.get_room_channel(room_uuid);
        pubsub.subscribe(&channel).await?;
        
        debug!("Created Redis subscriber for room {} on channel {}", room_uuid, channel);
        Ok(pubsub)
    }

    pub fn get_room_channel(&self, room_uuid: Uuid) -> String {
        format!("{}{}", PUBSUB_PREFIX, room_uuid)
    }

    pub async fn get_redis_url(&self) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        // We need to get the Redis URL from the pool configuration
        // For now, we'll hardcode it, but this should be configurable
        Ok("redis://localhost:6379".to_string())
    }

    // Room presence management
    pub async fn add_user_to_room(&self, room_uuid: Uuid, user_id: Uuid, user_login_name: &str, join_timestamp: i64) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let room_key = format!("{}{}:users", ROOM_PREFIX, room_uuid);
        let user_info = format!("{}:{}:{}", user_id, user_login_name, join_timestamp);
        
        conn.sadd::<_, _, ()>(&room_key, &user_info).await?;
        conn.expire::<_, ()>(&room_key, ROOM_PRESENCE_TTL as i64).await?;
        
        debug!("Added user {} to room {} presence with join time {}", user_login_name, room_uuid, join_timestamp);
        Ok(())
    }

    pub async fn remove_user_from_room(&self, room_uuid: Uuid, user_id: Uuid) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let room_key = format!("{}{}:users", ROOM_PREFIX, room_uuid);
        
        // Get all users and remove ones matching the user_id
        let users = conn.smembers::<_, Vec<String>>(&room_key).await?;
        for user_info in users {
            if user_info.starts_with(&format!("{}:", user_id)) {
                conn.srem::<_, _, ()>(&room_key, &user_info).await?;
                debug!("Removed user {} from room {} presence", user_id, room_uuid);
                break;
            }
        }
        
        Ok(())
    }

    pub async fn get_room_users(&self, room_uuid: Uuid) -> Result<Vec<(Uuid, String, i64)>, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let room_key = format!("{}{}:users", ROOM_PREFIX, room_uuid);
        
        let users = conn.smembers::<_, Vec<String>>(&room_key).await?;
        let mut result = Vec::new();
        
        for user_info in users {
            let parts: Vec<&str> = user_info.split(':').collect();
            if parts.len() >= 3 {
                if let Ok(user_id) = parts[0].parse::<Uuid>() {
                    if let Ok(join_timestamp) = parts[2].parse::<i64>() {
                        let user_login_name = parts[1].to_string();
                        result.push((user_id, user_login_name, join_timestamp));
                    }
                }
            } else if parts.len() == 2 {
                // Handle legacy format without timestamp (fallback for existing users)
                if let Ok(user_id) = parts[0].parse::<Uuid>() {
                    let user_login_name = parts[1].to_string();
                    result.push((user_id, user_login_name, 0)); // Use 0 as fallback timestamp
                }
            }
        }
        
        // Sort by join timestamp (ascending - first to join appears first)
        result.sort_by_key(|(_, _, timestamp)| *timestamp);
        
        debug!("Found {} users in room {} (sorted by join time)", result.len(), room_uuid);
        Ok(result)
    }

    pub async fn cleanup_room_state(&self, room_uuid: Uuid) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        
        // Clean up all room-related keys
        let patterns = [
            format!("{}{}:*", ROOM_PREFIX, room_uuid),
            format!("{}{}", ACTIVITY_PREFIX, room_uuid),
            format!("{}{}:*", SNAPSHOT_REQ_PREFIX, room_uuid),
        ];
        
        let mut total_deleted = 0;
        for pattern in &patterns {
            let keys = conn.keys::<_, Vec<String>>(pattern).await?;
            if !keys.is_empty() {
                let deleted: usize = conn.del(&keys).await?;
                total_deleted += deleted;
            }
        }
        
        info!("Cleaned up {} Redis keys for room {}", total_deleted, room_uuid);
        Ok(())
    }
}