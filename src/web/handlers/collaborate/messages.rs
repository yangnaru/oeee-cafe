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

    let username_bytes = user_login_name.as_bytes();
    let username_len = username_bytes.len() as u16;

    let mut new_join_msg = Vec::new();
    new_join_msg.push(0x01u8);
    new_join_msg.extend_from_slice(user_id.as_bytes());
    new_join_msg.extend_from_slice(&timestamp.to_le_bytes());
    new_join_msg.extend_from_slice(&username_len.to_le_bytes());
    new_join_msg.extend_from_slice(username_bytes);

    if let Err(e) = db::track_join_participant(db, room_uuid, user_uuid, timestamp as i64).await {
        error!("Failed to track JOIN participant: {}", e);
    } else {
        broadcast_join_response(db, room_uuid, state, tx, user_id).await;
    }

    Some(Message::Binary(new_join_msg))
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
            let user_count = participants.len() as u16;
            let mut response_data = vec![0x06u8];

            response_data.push((user_count & 0xff) as u8);
            response_data.push(((user_count >> 8) & 0xff) as u8);

            for participant in &participants {
                let uuid_bytes = participant.id.as_bytes();
                response_data.extend_from_slice(uuid_bytes);
            }

            if let Some(room_connections) = state.collaboration_rooms.get(&room_uuid) {
                let join_response_msg = Message::Binary(response_data);
                for conn_ref in room_connections.iter() {
                    let conn_id = conn_ref.key();
                    let sender = conn_ref.value();
                    if sender.send(join_response_msg.clone()).is_err() {
                        debug!("Failed to send JOIN_RESPONSE to connection {}", conn_id);
                    }
                }
                info!(
                    "Broadcasted JOIN_RESPONSE with {} users to {} connections in room {}",
                    user_count,
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

            let participant_name = participant.login_name.clone();
            let username_bytes = participant_name.as_bytes();
            let username_len = username_bytes.len() as u16;

            let mut join_msg = Vec::new();
            join_msg.push(0x01u8);
            join_msg.extend_from_slice(participant.id.as_bytes());
            join_msg.extend_from_slice(&current_timestamp.to_le_bytes());
            join_msg.extend_from_slice(&username_len.to_le_bytes());
            join_msg.extend_from_slice(username_bytes);

            let participant_join_msg = Message::Binary(join_msg);
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

            if stored_msg_type < 0x10 {
                if stored_msg_type == 0x02 {
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
                        0x13 => false,
                        0x10..=0x12 => {
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

    let username_bytes = user_login_name.as_bytes();
    let username_len = username_bytes.len() as u16;
    let msg_len = chat_text.len() as u16;

    let mut new_chat_msg = Vec::new();
    new_chat_msg.push(0x03u8);
    new_chat_msg.extend_from_slice(user_id.as_bytes());
    new_chat_msg.extend_from_slice(&timestamp.to_le_bytes());
    new_chat_msg.extend_from_slice(&username_len.to_le_bytes());
    new_chat_msg.extend_from_slice(username_bytes);
    new_chat_msg.extend_from_slice(&msg_len.to_le_bytes());
    new_chat_msg.extend_from_slice(chat_text.as_bytes());

    Some(Message::Binary(new_chat_msg))
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
) -> bool {
    if !is_owner || data.len() < 19 {
        if !is_owner {
            warn!(
                "Non-owner {} attempted to end session {}",
                user_login_name, room_uuid
            );
        }
        return false;
    }

    let sender_uuid = match bytes_to_uuid(&data[1..17]) {
        Ok(uuid) => uuid,
        Err(_) => return false,
    };

    if sender_uuid != user_id {
        return false;
    }

    let url_length = u16::from_le_bytes([data[17], data[18]]) as usize;

    if data.len() < 19 + url_length {
        return false;
    }

    let post_url = match std::str::from_utf8(&data[19..19 + url_length]) {
        Ok(url) => url,
        Err(_) => return false,
    };

    info!(
        "END_SESSION from owner {} in session {}, redirecting to: {}",
        user_login_name, room_uuid, post_url
    );

    if let Err(e) = db::end_session(db, room_uuid).await {
        error!("Failed to update session ended_at: {}", e);
    }

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

    true
}

pub fn should_store_message(msg: &Message) -> bool {
    if let Message::Binary(data) = msg {
        !data.is_empty() && data[0] != 0x03 && data[0] != 0x01
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
                    if msg_type >= 0x10
                        || (msg_type < 0x10
                            && msg_type != 0x05
                            && msg_type != 0x06
                            && msg_type != 0x09)
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
        let mut request_buffer = vec![0x05u8];
        request_buffer.extend_from_slice(user_id_to_request.as_bytes());
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        request_buffer.extend_from_slice(&timestamp.to_le_bytes());

        let snapshot_request_msg = Message::Binary(request_buffer);
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
            !data.is_empty() && data[0] == 0x03
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
            debug!(
                "Removed failed connection {} from room {}",
                failed_id, room_uuid
            );
        }
    }
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

        let mut leave_msg = vec![0x09u8];
        leave_msg.extend_from_slice(user_id.as_bytes());

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        leave_msg.extend_from_slice(&timestamp.to_le_bytes());

        let username_bytes = user_login_name.as_bytes();
        let username_len = username_bytes.len() as u16;
        leave_msg.extend_from_slice(&username_len.to_le_bytes());
        leave_msg.extend_from_slice(username_bytes);

        let leave_message = Message::Binary(leave_msg);
        let mut notified_connections = 0;

        for conn_ref in room.iter() {
            let (other_conn_id, sender) = conn_ref.pair();
            if *other_conn_id != connection_id && sender.send(leave_message.clone()).is_ok() {
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