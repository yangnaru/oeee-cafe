use crate::web::state::AppState;
use axum::extract::ws::Message;
use sqlx::{Pool, Postgres};
use std::collections::HashMap;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use super::db;
use super::utils::{bytes_to_uuid, read_u64_le};

const MAX_USER_MESSAGES: usize = 100;

// History limits to prevent unbounded growth
const MAX_HISTORY_MESSAGES: usize = 5000;  // Max messages per room
const MAX_HISTORY_BYTES: usize = 50 * 1024 * 1024;  // 50MB per room
const MAX_MESSAGE_AGE_MINUTES: u64 = 60;  // Remove messages older than 1 hour

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
        
        let mut buffer = Vec::with_capacity(1 + 16 + 8 + 2 + username_bytes.len() + 2 + message_bytes.len());
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

pub async fn handle_join_message(
    data: &[u8],
    user_id: Uuid,
    user_login_name: &str,
    room_uuid: Uuid,
    db: &Pool<Postgres>,
    state: &AppState,
    tx: &mpsc::UnboundedSender<Message>,
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
        broadcast_join_response(db, room_uuid, state, tx, user_id).await;
    }

    Some(Message::Binary(join_message.serialize()))
}

async fn broadcast_join_response(
    db: &Pool<Postgres>,
    room_uuid: Uuid,
    state: &AppState,
    tx: &mpsc::UnboundedSender<Message>,
    user_id: Uuid,
) {
    match db::get_active_participants(db, room_uuid).await {
        Ok(participants) => {
            let user_ids: Vec<Uuid> = participants.iter().map(|p| p.id).collect();
            let join_response = JoinResponseMessage { user_ids };

            if let Some(room_connections) = state.collaboration_rooms.get(&room_uuid) {
                let join_response_msg = Message::Binary(join_response.serialize());
                for conn_ref in room_connections.iter() {
                    let conn_id = conn_ref.key();
                    let sender = conn_ref.value();
                    if sender.send(join_response_msg.clone()).is_err() {
                        debug!("Failed to send JOIN_RESPONSE to connection {}", conn_id);
                    }
                }
                info!(
                    "Broadcasted JOIN_RESPONSE with {} users to {} connections in room {}",
                    participants.len(),
                    room_connections.len(),
                    room_uuid
                );

                send_existing_participants_to_new_user(&participants, tx, user_id).await;
            }
        }
        Err(e) => {
            error!("Failed to query participants for JOIN_RESPONSE: {}", e);
        }
    }
}

async fn send_existing_participants_to_new_user(
    participants: &[crate::models::user::User],
    tx: &mpsc::UnboundedSender<Message>,
    user_id: Uuid,
) {
    for participant in participants {
        if participant.id != user_id {
            let current_timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;

            let join_message = JoinMessage {
                user_id: participant.id,
                timestamp: current_timestamp,
                username: participant.login_name.clone(),
            };

            let participant_join_msg = Message::Binary(join_message.serialize());
            if let Err(e) = tx.send(participant_join_msg) {
                debug!(
                    "Failed to send JOIN message for participant {} to new user: {}",
                    participant.id, e
                );
            }
        }
    }
}

pub fn handle_snapshot_message(
    data: &[u8],
    room_uuid: Uuid,
    state: &AppState,
) -> Result<(), Box<dyn std::error::Error>> {
    if data.len() < 22 {
        return Ok(());
    }

    let snapshot_user = bytes_to_uuid(&data[1..17])?;
    let snapshot_layer = data[17];

    debug!(
        "Processing snapshot from user {} for layer {} in room {}",
        snapshot_user, snapshot_layer, room_uuid
    );

    let mut history = state.message_history.entry(room_uuid).or_default();
    let initial_count = history.len();

    history.retain(|stored_msg| {
        if let Message::Binary(stored_data) = stored_msg {
            if stored_data.is_empty() {
                return true;
            }

            let stored_msg_type = stored_data[0];

            if is_server_message(stored_msg_type) {
                if stored_msg_type == MessageType::Snapshot as u8 {
                    if stored_data.len() >= 18 {
                        if let Ok(stored_snapshot_user) = bytes_to_uuid(&stored_data[1..17]) {
                            let stored_snapshot_layer = stored_data[17];
                            return !(stored_snapshot_user == snapshot_user
                                && stored_snapshot_layer == snapshot_layer);
                        }
                    }
                    return true;
                }
                return true;
            }

            if stored_data.len() >= 17 {
                if let Ok(stored_user) = bytes_to_uuid(&stored_data[1..17]) {
                    if stored_user != snapshot_user {
                        return true;
                    }

                    match stored_msg_type {
                        0x13 => false, // POINTER_UP
                        0x10..=0x12 => { // DRAW_LINE, DRAW_POINT, FILL
                            if stored_data.len() >= 18 {
                                let stored_layer = stored_data[17];
                                stored_layer != snapshot_layer
                            } else {
                                true
                            }
                        }
                        _ => true,
                    }
                } else {
                    true
                }
            } else {
                true
            }
        } else {
            true
        }
    });

    let removed_count = initial_count - history.len();
    if removed_count > 0 {
        debug!(
            "Removed {} obsolete messages from history for user {} layer {} in room {}",
            removed_count, snapshot_user, snapshot_layer, room_uuid
        );
    }

    let user_snapshot_key = format!("{}:{}", room_uuid, snapshot_user);
    state.snapshot_request_tracker.insert(user_snapshot_key, false);

    Ok(())
}

pub fn handle_chat_message(
    data: &[u8],
    user_id: Uuid,
    user_login_name: &str,
) -> Option<Message> {
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

                        // Broadcast END_SESSION to all participants in the room (including sender)
                        if let Some(room_connections) = state.collaboration_rooms.get(&room_uuid) {
                            let end_session_msg = msg.clone();
                            for conn_ref in room_connections.iter() {
                                let conn_id = conn_ref.key();
                                let sender = conn_ref.value();
                                if sender.send(end_session_msg.clone()).is_err() {
                                    debug!("Failed to send END_SESSION to connection {}", conn_id);
                                }
                            }
                            info!(
                                "Broadcasted END_SESSION to {} connections in room {}",
                                room_connections.len(),
                                room_uuid
                            );
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
        !data.is_empty() 
            && data[0] != MessageType::Chat as u8 
            && data[0] != MessageType::Join as u8
    } else {
        true
    }
}

pub fn count_user_messages(
    state: &AppState,
    room_uuid: Uuid,
) -> HashMap<Uuid, usize> {
    let mut user_message_counts: HashMap<Uuid, usize> = HashMap::new();

    if let Some(history) = state.message_history.get(&room_uuid) {
        for stored_msg in history.iter() {
            if let Message::Binary(stored_data) = stored_msg {
                if stored_data.len() >= 17 {
                    let msg_type = stored_data[0];
                    if is_client_message(msg_type)
                        || (is_server_message(msg_type)
                            && msg_type != MessageType::SnapshotRequest as u8
                            && msg_type != MessageType::JoinResponse as u8
                            && msg_type != MessageType::Leave as u8)
                    {
                        if let Ok(msg_user_id) = bytes_to_uuid(&stored_data[1..17]) {
                            *user_message_counts.entry(msg_user_id).or_insert(0) += 1;
                        }
                    }
                }
            }
        }
    }

    user_message_counts
}

pub async fn handle_snapshot_requests(
    user_message_counts: &HashMap<Uuid, usize>,
    room_uuid: Uuid,
    state: &AppState,
) {
    for (user_id_to_request, &message_count) in user_message_counts.iter() {
        if message_count > MAX_USER_MESSAGES {
            let snapshot_key = format!("{}:{}", room_uuid, user_id_to_request);
            let should_send_snapshot = !state
                .snapshot_request_tracker
                .get(&snapshot_key)
                .map(|entry| *entry.value())
                .unwrap_or(false);

            if should_send_snapshot {
                send_snapshot_request(room_uuid, state, user_id_to_request, message_count, &snapshot_key).await;
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
    snapshot_key: &str,
) {
    if let Some(room) = state.collaboration_rooms.get(&room_uuid) {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let snapshot_request = SnapshotRequestMessage {
            user_id: *user_id_to_request,
            timestamp,
        };

        let snapshot_request_msg = Message::Binary(snapshot_request.serialize());
        let mut sent_count = 0;

        for conn_ref in room.iter() {
            let (connection_id, sender) = conn_ref.pair();
            if let Some(conn_user_id) = state.connection_user_mapping.get(connection_id) {
                if *conn_user_id == *user_id_to_request
                    && sender.send(snapshot_request_msg.clone()).is_ok()
                {
                    sent_count += 1;
                }
            }
        }

        if sent_count > 0 {
            state.snapshot_request_tracker.insert(snapshot_key.to_string(), true);
            debug!(
                "Sent snapshot request to {} connections targeting user {} with {} messages in room {}",
                sent_count, user_id_to_request, message_count, room_uuid
            );
        }
    }
}

pub async fn broadcast_message(
    msg: &Message,
    room_uuid: Uuid,
    connection_id: &str,
    state: &AppState,
) {
    if let Some(room) = state.collaboration_rooms.get(&room_uuid) {
        let mut failed_connections = Vec::new();

        let include_sender = if let Message::Binary(data) = msg {
            !data.is_empty() && data[0] == MessageType::Chat as u8
        } else {
            false
        };

        for entry in room.iter() {
            let (other_connection_id, other_tx) = entry.pair();

            if !include_sender && *other_connection_id == connection_id {
                continue;
            }

            if other_tx.send(msg.clone()).is_err() {
                failed_connections.push(other_connection_id.clone());
            }
        }

        for failed_id in failed_connections {
            room.remove(&failed_id);
            state.connection_user_mapping.remove(&failed_id);
            debug!(
                "Removed failed connection {} from room {}",
                failed_id, room_uuid
            );
        }
    }
}

pub fn enforce_history_limits(
    history: &mut Vec<Message>,
    room_uuid: Uuid,
) {
    let initial_count = history.len();
    let mut total_bytes = 0;
    let current_time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    
    // First pass: calculate total size and identify old messages
    let mut messages_to_keep = Vec::new();
    
    for msg in history.iter().rev() {  // Process newest first
        let msg_size = match msg {
            Message::Binary(data) => data.len(),
            Message::Text(text) => text.len(),
            _ => 0,
        };
        
        // Check if we've exceeded limits
        if messages_to_keep.len() >= MAX_HISTORY_MESSAGES {
            break;  // Too many messages
        }
        
        if total_bytes + msg_size > MAX_HISTORY_BYTES {
            break;  // Too much data
        }
        
        // Check message age for timestamped messages
        if let Message::Binary(data) = msg {
            if data.len() >= 25 && is_timestamped_message(data[0]) {
                let msg_timestamp = read_u64_le(data, 17);
                let age_ms = current_time.saturating_sub(msg_timestamp);
                if age_ms > MAX_MESSAGE_AGE_MINUTES * 60 * 1000 {
                    continue;  // Message too old
                }
            }
        }
        
        total_bytes += msg_size;
        messages_to_keep.push(msg.clone());
    }
    
    // Reverse to maintain chronological order
    messages_to_keep.reverse();
    
    if messages_to_keep.len() < initial_count {
        let removed = initial_count - messages_to_keep.len();
        debug!(
            "Enforced history limits for room {}: removed {} messages (was {} messages, now {})",
            room_uuid, removed, initial_count, messages_to_keep.len()
        );
        *history = messages_to_keep;
    }
}

fn is_timestamped_message(msg_type: u8) -> bool {
    matches!(msg_type, 0x01 | 0x03 | 0x05 | 0x09)  // JOIN, CHAT, SNAPSHOT_REQUEST, LEAVE
}

pub async fn send_leave_message(
    room_uuid: Uuid,
    connection_id: &str,
    user_id: Uuid,
    user_login_name: &str,
    state: &AppState,
) {
    if let Some(room) = state.collaboration_rooms.get(&room_uuid) {
        if room.len() <= 1 {
            return;
        }

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let leave_message = LeaveMessage {
            user_id,
            timestamp,
            username: user_login_name.to_string(),
        };

        let leave_msg = Message::Binary(leave_message.serialize());
        let mut notified_connections = 0;

        for conn_ref in room.iter() {
            let (other_conn_id, sender) = conn_ref.pair();
            if *other_conn_id != connection_id && sender.send(leave_msg.clone()).is_ok() {
                notified_connections += 1;
            }
        }

        if notified_connections > 0 {
            info!(
                "Sent LEAVE notification for user {} to {} other participants in room {}",
                user_login_name, notified_connections, room_uuid
            );
        }
    }
}