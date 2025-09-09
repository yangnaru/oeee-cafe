use crate::web::state::AppState;
use super::redis_messages;
use axum::extract::ws::Message;
use sqlx::{Pool, Postgres};
use std::collections::HashMap;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use super::db;
use super::utils::{bytes_to_uuid, read_u64_le};

// Safe timestamp helper to avoid panics from system clock issues
fn get_current_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_else(|_| std::time::Duration::from_secs(0))
        .as_millis() as u64
}

const MAX_USER_MESSAGES: usize = 100;

// Message type constants matching neo-cucumber protocol
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageType {
    Join = 0x01,
    Snapshot = 0x02,
    Chat = 0x03,
    SnapshotRequest = 0x05,
    JoinResponse = 0x06,
    EndSession = 0x07,
    SessionExpired = 0x08,
    Leave = 0x09,
}

// Message structures
#[derive(Debug, Clone)]
pub struct JoinMessage {
    pub user_id: Uuid,
    pub timestamp: u64,
    pub username: String,
}

#[derive(Debug, Clone)]
pub struct JoinResponseMessage {
    pub user_ids: Vec<Uuid>,
}

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub user_id: Uuid,
    pub timestamp: u64,
    pub username: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct SnapshotRequestMessage {
    pub user_id: Uuid,
    pub timestamp: u64,
}

#[derive(Debug, Clone)]
pub struct LeaveMessage {
    pub user_id: Uuid,
    pub timestamp: u64,
    pub username: String,
}

// Message serialization functions
impl JoinMessage {
    pub fn serialize(&self) -> Vec<u8> {
        let username_bytes = self.username.as_bytes();
        let username_len = username_bytes.len() as u16;

        let mut buffer = Vec::with_capacity(1 + 16 + 8 + 2 + username_bytes.len());
        buffer.push(MessageType::Join as u8);
        buffer.extend_from_slice(self.user_id.as_bytes());
        buffer.extend_from_slice(&self.timestamp.to_le_bytes());
        buffer.extend_from_slice(&username_len.to_le_bytes());
        buffer.extend_from_slice(username_bytes);

        buffer
    }
}

impl JoinResponseMessage {
    pub fn serialize(&self) -> Vec<u8> {
        let user_count = self.user_ids.len() as u16;
        let mut buffer = Vec::with_capacity(1 + 2 + self.user_ids.len() * 16);

        buffer.push(MessageType::JoinResponse as u8);
        buffer.extend_from_slice(&user_count.to_le_bytes());

        for user_id in &self.user_ids {
            buffer.extend_from_slice(user_id.as_bytes());
        }

        buffer
    }
}

impl ChatMessage {
    pub fn serialize(&self) -> Vec<u8> {
        let username_bytes = self.username.as_bytes();
        let username_len = username_bytes.len() as u16;
        let message_bytes = self.message.as_bytes();
        let message_len = message_bytes.len() as u16;

        let mut buffer =
            Vec::with_capacity(1 + 16 + 8 + 2 + username_bytes.len() + 2 + message_bytes.len());
        buffer.push(MessageType::Chat as u8);
        buffer.extend_from_slice(self.user_id.as_bytes());
        buffer.extend_from_slice(&self.timestamp.to_le_bytes());
        buffer.extend_from_slice(&username_len.to_le_bytes());
        buffer.extend_from_slice(username_bytes);
        buffer.extend_from_slice(&message_len.to_le_bytes());
        buffer.extend_from_slice(message_bytes);

        buffer
    }
}

impl SnapshotRequestMessage {
    pub fn serialize(&self) -> Vec<u8> {
        let mut buffer = Vec::with_capacity(1 + 16 + 8);
        buffer.push(MessageType::SnapshotRequest as u8);
        buffer.extend_from_slice(self.user_id.as_bytes());
        buffer.extend_from_slice(&self.timestamp.to_le_bytes());

        buffer
    }
}

impl LeaveMessage {
    pub fn serialize(&self) -> Vec<u8> {
        let username_bytes = self.username.as_bytes();
        let username_len = username_bytes.len() as u16;

        let mut buffer = Vec::with_capacity(1 + 16 + 8 + 2 + username_bytes.len());
        buffer.push(MessageType::Leave as u8);
        buffer.extend_from_slice(self.user_id.as_bytes());
        buffer.extend_from_slice(&self.timestamp.to_le_bytes());
        buffer.extend_from_slice(&username_len.to_le_bytes());
        buffer.extend_from_slice(username_bytes);

        buffer
    }
}

// Message parsing utilities
pub fn parse_message_type(data: &[u8]) -> Option<MessageType> {
    if data.is_empty() {
        return None;
    }

    match data[0] {
        0x01 => Some(MessageType::Join),
        0x02 => Some(MessageType::Snapshot),
        0x03 => Some(MessageType::Chat),
        0x05 => Some(MessageType::SnapshotRequest),
        0x06 => Some(MessageType::JoinResponse),
        0x07 => Some(MessageType::EndSession),
        0x08 => Some(MessageType::SessionExpired),
        0x09 => Some(MessageType::Leave),
        _ => None,
    }
}

pub fn is_server_message(msg_type: u8) -> bool {
    msg_type < 0x10
}

pub fn is_client_message(msg_type: u8) -> bool {
    msg_type >= 0x10
}

// bytes_to_uuid is already available from utils module via import

pub async fn handle_join_message(
    data: &[u8],
    user_id: Uuid,
    user_login_name: &str,
    room_uuid: Uuid,
    db: &Pool<Postgres>,
    state: &AppState,
) -> Option<Message> {
    if data.len() < 25 {
        return None;
    }

    let user_uuid = match bytes_to_uuid(&data[1..17]) {
        Ok(uuid) => uuid,
        Err(_) => return None,
    };

    let timestamp = read_u64_le(data, 17);

    if user_uuid != user_id {
        return None;
    }

    debug!(
        "JOIN message from user {} ({}) at {} in room {}",
        user_login_name, user_uuid, timestamp, room_uuid
    );

    let join_message = JoinMessage {
        user_id,
        timestamp,
        username: user_login_name.to_string(),
    };

    if let Err(e) = db::track_join_participant(db, room_uuid, user_uuid, timestamp as i64).await {
        error!("Failed to track JOIN participant: {}", e);
    } else {
        broadcast_join_response(db, room_uuid, state, user_id).await;
    }

    Some(Message::Binary(join_message.serialize()))
}

async fn broadcast_join_response(
    _db: &Pool<Postgres>,
    room_uuid: Uuid,
    state: &AppState,
    _user_id: Uuid,
) {
    match state.redis_state.get_room_users(room_uuid).await {
        Ok(participants) => {
            let user_ids: Vec<Uuid> = participants.iter().map(|(id, _)| *id).collect();
            let join_response = JoinResponseMessage { user_ids };

            // Use Redis pub/sub to send JOIN_RESPONSE to all connections in the room
            let room_message = super::redis_state::RoomMessage {
                from_connection: "system".to_string(),
                user_id: uuid::Uuid::nil(),
                user_login_name: "system".to_string(),
                message_type: "join_response".to_string(),
                payload: join_response.serialize(),
                timestamp: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(),
            };

            match state.redis_state.publish_message(room_uuid, &room_message).await {
                Ok(subscriber_count) => {
                    info!(
                        "Broadcasted JOIN_RESPONSE with {} users to {} subscribers in room {}",
                        participants.len(),
                        subscriber_count,
                        room_uuid
                    );
                }
                Err(e) => {
                    error!("Failed to publish JOIN_RESPONSE message for room {}: {}", room_uuid, e);
                }
            }

            // Note: With Redis Pub/Sub architecture, existing participant information 
            // is now sent through the normal message flow. The JOIN_RESPONSE above 
            // contains the list of all current users, and when this user's own JOIN 
            // message gets stored and broadcast through Redis, other users will see 
            // this user has joined. Historical JOIN messages are replayed through 
            // the Redis message history system.
        }
        Err(e) => {
            error!("Failed to query participants for JOIN_RESPONSE: {}", e);
        }
    }
}

// Note: send_existing_participants_to_new_user function is not needed
// JOIN and LEAVE messages are ephemeral (not stored in history)
// Current participants are communicated via JOIN_RESPONSE messages

pub async fn handle_snapshot_message(
    data: &[u8],
    room_uuid: Uuid,
    state: &AppState,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if data.len() < 22 {
        return Ok(());
    }

    let snapshot_user = bytes_to_uuid(&data[1..17])?;
    let snapshot_layer = data[17];

    debug!(
        "Processing snapshot from user {} for layer {} in room {}",
        snapshot_user, snapshot_layer, room_uuid
    );

    // Use Redis to handle the message filtering
    let redis_store = redis_messages::RedisMessageStore::new(state.redis_pool.clone());
    redis_store.remove_obsolete_messages(room_uuid, snapshot_user, snapshot_layer).await?;

    if let Err(e) = state.redis_state.set_snapshot_requested(room_uuid, snapshot_user, false).await {
        error!("Failed to clear snapshot request in Redis: {}", e);
    }

    Ok(())
}

pub fn handle_chat_message(data: &[u8], user_id: Uuid, user_login_name: &str) -> Option<Message> {
    if data.len() < 27 {
        return None;
    }

    let chat_user = match bytes_to_uuid(&data[1..17]) {
        Ok(user) => user,
        Err(_) => return None,
    };

    if chat_user != user_id {
        return None;
    }

    let timestamp = read_u64_le(data, 17);
    let msg_length = u16::from_le_bytes([data[25], data[26]]) as usize;

    if data.len() < 27 + msg_length {
        return None;
    }

    let chat_text = match std::str::from_utf8(&data[27..27 + msg_length]) {
        Ok(text) => text,
        Err(_) => return None,
    };

    debug!(
        "Chat message from user {} ({}): {}",
        user_login_name, chat_user, chat_text
    );

    let chat_message = ChatMessage {
        user_id,
        timestamp,
        username: user_login_name.to_string(),
        message: chat_text.to_string(),
    };

    Some(Message::Binary(chat_message.serialize()))
}

pub async fn handle_end_session_message(
    data: &[u8],
    user_id: Uuid,
    user_login_name: &str,
    room_uuid: Uuid,
    is_owner: bool,
    db: &Pool<Postgres>,
    state: &AppState,
    msg: &Message,
    connection_id: &str,
) {
    if is_owner && data.len() >= 19 {
        if let Ok(sender_uuid) = bytes_to_uuid(&data[1..17]) {
            if sender_uuid == user_id {
                let url_length = u16::from_le_bytes([data[17], data[18]]) as usize;

                if data.len() >= 19 + url_length {
                    if let Ok(post_url) = std::str::from_utf8(&data[19..19 + url_length]) {
                        info!(
                            "END_SESSION from owner {} in session {}, redirecting to: {}",
                            user_login_name, room_uuid, post_url
                        );

                        // Set collaborative_sessions.ended_at
                        if let Err(e) = db::end_session(db, room_uuid).await {
                            error!("Failed to update session ended_at: {}", e);
                        }

                        // Clean up Redis message history when session is explicitly ended
                        let redis_store = redis_messages::RedisMessageStore::new(state.redis_pool.clone());
                        if let Err(e) = redis_store.cleanup_room(room_uuid).await {
                            error!("Failed to cleanup Redis for ended session {}: {}", room_uuid, e);
                        } else {
                            info!("Cleaned up Redis message history for ended session {}", room_uuid);
                        }

                        // Broadcast END_SESSION to all participants in the room (including sender) via Redis pub/sub
                        let room_message = super::redis_state::RoomMessage {
                            from_connection: connection_id.to_string(),
                            user_id,
                            user_login_name: user_login_name.to_string(),
                            message_type: "websocket".to_string(),
                            payload: msg.clone().into_data(),
                            timestamp: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(),
                        };

                        match state.redis_state.publish_message(room_uuid, &room_message).await {
                            Ok(subscriber_count) => {
                                info!(
                                    "Broadcasted END_SESSION to {} subscribers in room {}",
                                    subscriber_count,
                                    room_uuid
                                );
                            }
                            Err(e) => {
                                error!("Failed to publish END_SESSION message for room {}: {}", room_uuid, e);
                            }
                        }
                    }
                }
            }
        }
    } else if !is_owner {
        warn!(
            "Non-owner {} attempted to end session {}",
            user_login_name, room_uuid
        );
    }
}

pub fn should_store_message(msg: &Message) -> bool {
    if let Message::Binary(data) = msg {
        if data.is_empty() {
            return false;
        }
        
        let msg_type = data[0];
        // Store all messages except ephemeral ones:
        // - Chat messages (ephemeral conversation)
        // - JOIN messages (current participants sent via JOIN_RESPONSE)  
        // - LEAVE messages (current participants tracked in Redis presence)
        msg_type != MessageType::Chat as u8 
            && msg_type != MessageType::Join as u8
            && msg_type != MessageType::Leave as u8
    } else {
        true
    }
}

// This function is now replaced by count_user_messages_from_redis in websocket.rs
// but kept here for reference and potential fallback use

pub async fn handle_snapshot_requests(
    user_message_counts: &HashMap<Uuid, usize>,
    room_uuid: Uuid,
    state: &AppState,
) {
    for (user_id_to_request, &message_count) in user_message_counts.iter() {
        if message_count > MAX_USER_MESSAGES {
            let should_send_snapshot = !state.redis_state.is_snapshot_requested(room_uuid, *user_id_to_request).await.unwrap_or(false);

            if should_send_snapshot {
                send_snapshot_request(
                    room_uuid,
                    state,
                    user_id_to_request,
                    message_count,
                )
                .await;
                break;
            }
        }
    }
}

async fn send_snapshot_request(
    room_uuid: Uuid,
    state: &AppState,
    user_id_to_request: &Uuid,
    message_count: usize,
) {
    let timestamp = get_current_timestamp_ms();

    let snapshot_request = SnapshotRequestMessage {
        user_id: *user_id_to_request,
        timestamp,
    };

    // Use Redis pub/sub to send snapshot request to all connections
    // Only the connections owned by user_id_to_request will respond
    let room_message = super::redis_state::RoomMessage {
        from_connection: "system".to_string(),
        user_id: *user_id_to_request,
        user_login_name: "system".to_string(),
        message_type: "snapshot_request".to_string(),
        payload: snapshot_request.serialize(),
        timestamp: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(),
    };

    match state.redis_state.publish_message(room_uuid, &room_message).await {
        Ok(subscriber_count) => {
            if let Err(e) = state.redis_state.set_snapshot_requested(room_uuid, *user_id_to_request, true).await {
                error!("Failed to set snapshot request in Redis: {}", e);
            }
            debug!(
                "Sent snapshot request to {} subscribers targeting user {} with {} messages in room {}",
                subscriber_count, user_id_to_request, message_count, room_uuid
            );
        }
        Err(e) => {
            error!("Failed to publish snapshot request for room {}: {}", room_uuid, e);
        }
    }
}

pub async fn broadcast_message(
    msg: &Message,
    room_uuid: Uuid,
    connection_id: &str,
    state: &AppState,
) {
    // Convert WebSocket message to Redis room message
    let room_message = super::redis_state::RoomMessage {
        from_connection: connection_id.to_string(),
        user_id: Uuid::nil(), // We'll get this from Redis connection info if needed
        user_login_name: String::new(), // We'll get this from Redis connection info if needed
        message_type: "websocket".to_string(),
        payload: match msg {
            Message::Binary(data) => data.clone(),
            Message::Text(text) => text.as_bytes().to_vec(),
            _ => vec![],
        },
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    };

    // Publish to Redis Pub/Sub - this will reach all server instances
    match state.redis_state.publish_message(room_uuid, &room_message).await {
        Ok(subscriber_count) => {
            debug!("Published message to Redis for room {} - {} subscribers", room_uuid, subscriber_count);
        }
        Err(e) => {
            error!("Failed to publish message to Redis for room {}: {}", room_uuid, e);
        }
    }
}

// This function is now handled by Redis automatic limits and TTL
// The RedisMessageStore enforces limits during store_message operations

pub async fn send_leave_message(
    room_uuid: Uuid,
    connection_id: &str,
    user_id: Uuid,
    user_login_name: &str,
    state: &AppState,
) {
    // Check how many connections are in the room via Redis
    let redis_connections = match state.redis_state.get_room_connections(room_uuid).await {
        Ok(connections) => connections,
        Err(e) => {
            error!("Failed to get Redis connections for leave message in room {}: {}", room_uuid, e);
            return;
        }
    };

    if redis_connections.len() <= 1 {
        debug!("Not sending LEAVE message for user {} in room {} - only 1 or fewer connections", user_login_name, room_uuid);
        return;
    }

    let timestamp = get_current_timestamp_ms();

    let leave_message = LeaveMessage {
        user_id,
        timestamp,
        username: user_login_name.to_string(),
    };

    // Use Redis pub/sub to send LEAVE message to all connections except the one leaving
    let room_message = super::redis_state::RoomMessage {
        from_connection: connection_id.to_string(),
        user_id,
        user_login_name: user_login_name.to_string(),
        message_type: "leave".to_string(),
        payload: leave_message.serialize(),
        timestamp: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(),
    };

    match state.redis_state.publish_message(room_uuid, &room_message).await {
        Ok(subscriber_count) => {
            info!(
                "Sent LEAVE notification for user {} to {} subscribers in room {}",
                user_login_name, subscriber_count, room_uuid
            );
        }
        Err(e) => {
            error!("Failed to publish LEAVE message for user {} in room {}: {}", user_login_name, room_uuid, e);
        }
    }
}
