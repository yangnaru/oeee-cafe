use axum::extract::ws::Message;
use redis::AsyncCommands;
use tracing::{debug, error};
use uuid::Uuid;

use crate::redis::RedisPool;

const MESSAGE_HISTORY_TTL: u64 = 3600; // 1 hour TTL
const MESSAGE_HISTORY_PREFIX: &str = "oeee:msg_history:";
const MAX_REDIS_MESSAGES: usize = 50000;

pub struct RedisMessageStore {
    pool: RedisPool,
}

impl RedisMessageStore {
    pub fn new(pool: RedisPool) -> Self {
        Self { pool }
    }

    pub async fn store_message(
        &self,
        room_uuid: Uuid,
        message: &Message,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        debug!(
            "Attempting to store message in Redis for room {}",
            room_uuid
        );

        let mut conn = self.pool.get().await.map_err(|e| {
            error!("Failed to get Redis connection: {}", e);
            e
        })?;

        let key = format!("{}{}", MESSAGE_HISTORY_PREFIX, room_uuid);
        debug!("Using Redis key: {}", key);

        let message_data = match message {
            Message::Binary(data) => {
                debug!(
                    "Storing binary message of {} bytes (type: 0x{:02x})",
                    data.len(),
                    if data.is_empty() { 0x00 } else { data[0] }
                );
                data.clone()
            }
            Message::Text(text) => {
                debug!("Storing text message of {} bytes", text.len());
                text.as_bytes().to_vec()
            }
            _ => {
                debug!("Skipping non-binary/text message type");
                return Ok(()); // Skip other message types
            }
        };

        // Add message to Redis list (LPUSH for FIFO order)
        conn.lpush::<_, _, ()>(&key, &message_data)
            .await
            .map_err(|e| {
                error!("Failed to LPUSH to Redis key {}: {}", key, e);
                e
            })?;
        debug!("Successfully LPUSH message to Redis key: {}", key);

        // Set TTL on the key (refreshes TTL if key exists)
        conn.expire::<_, ()>(&key, MESSAGE_HISTORY_TTL as i64)
            .await
            .map_err(|e| {
                error!("Failed to set TTL on Redis key {}: {}", key, e);
                e
            })?;
        debug!("Successfully set TTL on Redis key: {}", key);

        // Enforce message count limit
        let current_length: usize = conn.llen(&key).await.map_err(|e| {
            error!("Failed to get length of Redis key {}: {}", key, e);
            e
        })?;
        debug!("Current Redis list length for {}: {}", key, current_length);

        if current_length > MAX_REDIS_MESSAGES {
            // Remove excess messages from the right (oldest)
            let to_remove = current_length - MAX_REDIS_MESSAGES;
            for _ in 0..to_remove {
                let _: Option<Vec<u8>> = conn.rpop(&key, None).await?;
            }
            debug!(
                "Trimmed {} old messages from room {} history (was {}, now {})",
                to_remove, room_uuid, current_length, MAX_REDIS_MESSAGES
            );
        }

        debug!(
            "Message storage completed successfully for room {}",
            room_uuid
        );
        Ok(())
    }

    pub async fn get_history(
        &self,
        room_uuid: Uuid,
    ) -> Result<Vec<Message>, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", MESSAGE_HISTORY_PREFIX, room_uuid);

        // Get all messages from Redis list (LRANGE with reverse order to maintain chronological)
        let messages: Vec<Vec<u8>> = conn.lrange(&key, 0, -1).await?;

        // Convert back to Messages and reverse (since we used LPUSH, newest is first)
        let mut result = Vec::new();
        for data in messages.into_iter().rev() {
            result.push(Message::Binary(data));
        }

        debug!(
            "Retrieved {} messages from Redis for room {}",
            result.len(),
            room_uuid
        );
        Ok(result)
    }

    pub async fn remove_obsolete_messages(
        &self,
        room_uuid: Uuid,
        user_id: Uuid,
        layer: u8,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", MESSAGE_HISTORY_PREFIX, room_uuid);

        // Get all messages
        let messages: Vec<Vec<u8>> = conn.lrange(&key, 0, -1).await?;

        let initial_count = messages.len();
        let mut filtered_messages = Vec::new();

        // Filter messages (same logic as the original function)
        for data in &messages {
            if data.is_empty() {
                filtered_messages.push(data.clone());
                continue;
            }

            let msg_type = data[0];

            // Keep server messages (except certain snapshot ones)
            if is_server_message(msg_type) {
                if msg_type == 0x02 {
                    // Snapshot message
                    if data.len() >= 18 {
                        if let Ok(stored_snapshot_user) = bytes_to_uuid(&data[1..17]) {
                            let stored_snapshot_layer = data[17];
                            if !(stored_snapshot_user == user_id && stored_snapshot_layer == layer)
                            {
                                filtered_messages.push(data.clone());
                            }
                        }
                    } else {
                        filtered_messages.push(data.clone());
                    }
                } else {
                    filtered_messages.push(data.clone());
                }
                continue;
            }

            // Handle client messages
            if data.len() >= 17 {
                if let Ok(stored_user) = bytes_to_uuid(&data[1..17]) {
                    if stored_user != user_id {
                        filtered_messages.push(data.clone());
                        continue;
                    }

                    match msg_type {
                        0x13 => {} // POINTER_UP - remove
                        0x10..=0x12 => {
                            // DRAW_LINE, DRAW_POINT, FILL
                            if data.len() >= 18 {
                                let stored_layer = data[17];
                                if stored_layer != layer {
                                    filtered_messages.push(data.clone());
                                }
                            } else {
                                filtered_messages.push(data.clone());
                            }
                        }
                        _ => filtered_messages.push(data.clone()),
                    }
                } else {
                    filtered_messages.push(data.clone());
                }
            } else {
                filtered_messages.push(data.clone());
            }
        }

        let removed_count = initial_count - filtered_messages.len();

        if removed_count > 0 {
            // Replace the entire list with filtered messages
            conn.del::<_, ()>(&key).await?;
            if !filtered_messages.is_empty() {
                // Add messages back in reverse order to maintain chronological order
                for data in filtered_messages.into_iter().rev() {
                    conn.lpush::<_, _, ()>(&key, &data).await?;
                }
                // Reset TTL
                conn.expire::<_, ()>(&key, MESSAGE_HISTORY_TTL as i64)
                    .await?;
            }

            debug!(
                "Removed {} obsolete messages from Redis for user {} layer {} in room {}",
                removed_count, user_id, layer, room_uuid
            );
        }

        Ok(())
    }

    pub async fn cleanup_room(
        &self,
        room_uuid: Uuid,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", MESSAGE_HISTORY_PREFIX, room_uuid);

        let deleted: bool = conn.del(&key).await?;
        if deleted {
            debug!("Cleaned up Redis message history for room {}", room_uuid);
        }

        Ok(())
    }

    pub async fn enforce_history_limits(
        &self,
        room_uuid: Uuid,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", MESSAGE_HISTORY_PREFIX, room_uuid);

        // Get current message count
        let current_length: usize = conn.llen(&key).await?;

        if current_length <= MAX_REDIS_MESSAGES {
            return Ok(0);
        }

        // Remove excess messages from the right (oldest)
        let to_remove = current_length - MAX_REDIS_MESSAGES;
        for _ in 0..to_remove {
            let _: Option<Vec<u8>> = conn.rpop(&key, None).await?;
        }

        debug!(
            "Enforced history limits for room {}: removed {} messages (was {}, now {})",
            room_uuid, to_remove, current_length, MAX_REDIS_MESSAGES
        );

        Ok(to_remove)
    }

    pub async fn refresh_ttl(
        &self,
        room_uuid: Uuid,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", MESSAGE_HISTORY_PREFIX, room_uuid);

        conn.expire::<_, ()>(&key, MESSAGE_HISTORY_TTL as i64)
            .await?;
        Ok(())
    }
}

// Helper functions (copied from original messages.rs)
fn is_server_message(msg_type: u8) -> bool {
    msg_type < 0x10
}

fn bytes_to_uuid(bytes: &[u8]) -> Result<Uuid, Box<dyn std::error::Error + Send + Sync>> {
    if bytes.len() != 16 {
        return Err(format!("Invalid UUID length: expected 16, got {}", bytes.len()).into());
    }
    let mut uuid_bytes = [0u8; 16];
    uuid_bytes.copy_from_slice(bytes);
    Ok(Uuid::from_bytes(uuid_bytes))
}
