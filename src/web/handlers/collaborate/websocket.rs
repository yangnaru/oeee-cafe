use crate::app_error::AppError;
use crate::models::user::AuthSession;
use crate::web::state::AppState;
use axum::extract::{ws::Message, ws::WebSocket, Path, State, WebSocketUpgrade};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use std::time::Instant;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use super::{db, messages};

pub async fn websocket_collaborate_handler(
    Path(room_uuid): Path<Uuid>,
    auth_session: AuthSession,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    let user = auth_session
        .user
        .ok_or_else(|| anyhow::anyhow!("Authentication required"))?;
    Ok(ws.on_upgrade(move |socket| {
        handle_socket(socket, room_uuid, state, user.id, user.login_name)
    }))
}

pub async fn handle_socket(
    socket: WebSocket,
    room_uuid: Uuid,
    state: AppState,
    user_id: Uuid,
    user_login_name: String,
) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    let connection_id = Uuid::new_v4().to_string();

    info!(
        "New websocket connection {} (user {}) joining room {}",
        connection_id, user_login_name, room_uuid
    );

    let db = match state.config.connect_database().await {
        Ok(db) => db,
        Err(e) => {
            error!("Failed to connect to database: {}", e);
            return;
        }
    };

    let is_owner = match setup_connection(
        &db,
        room_uuid,
        user_id,
        &user_login_name,
        &connection_id,
        &state,
        &tx,
    )
    .await
    {
        Ok(owner_status) => owner_status,
        Err(_) => return,
    };

    info!(
        "User {} joined session {} as {}",
        user_login_name,
        room_uuid,
        if is_owner { "owner" } else { "participant" }
    );

    let connection_id_clone = connection_id.clone();
    let outgoing_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(msg).await.is_err() {
                warn!(
                    "Failed to send message to connection {}",
                    connection_id_clone
                );
                break;
            }
        }
    });

    handle_incoming_messages(
        &mut receiver,
        &connection_id,
        &user_login_name,
        user_id,
        room_uuid,
        is_owner,
        &db,
        &state,
    )
    .await;

    cleanup_connection(&connection_id, &user_login_name, user_id, room_uuid, &db, &state).await;

    outgoing_task.abort();
}

async fn setup_connection(
    db: &sqlx::Pool<sqlx::Postgres>,
    room_uuid: Uuid,
    user_id: Uuid,
    user_login_name: &str,
    connection_id: &str,
    state: &AppState,
    tx: &mpsc::UnboundedSender<Message>,
) -> Result<bool, ()> {
    let session_info = match db::get_session_info(db, room_uuid).await {
        Ok(Some(info)) => info,
        Ok(None) => {
            error!("Session {} not found", room_uuid);
            return Err(());
        }
        Err(e) => {
            error!("Failed to get session info: {}", e);
            return Err(());
        }
    };

    // Use atomic capacity check and participant tracking to prevent race conditions
    let join_success = match db::track_participant_with_capacity_check(
        db, 
        room_uuid, 
        user_id, 
        session_info.max_participants
    ).await {
        Ok(success) => success,
        Err(e) => {
            error!("Failed to track participant: {}", e);
            false
        }
    };

    if !join_success {
        info!(
            "User {} rejected from session {} (capacity check failed)",
            user_login_name, room_uuid
        );
        return Err(());
    }

    db::update_session_activity(state, room_uuid).await;

    // Atomically handle all connection management
    setup_connection_atomically(
        state, 
        room_uuid, 
        user_id, 
        connection_id, 
        user_login_name,
        tx
    );

    send_history_to_new_connection(state, room_uuid, tx, connection_id);

    Ok(session_info.owner_id == user_id)
}

fn setup_connection_atomically(
    state: &AppState,
    room_uuid: Uuid,
    user_id: Uuid,
    connection_id: &str,
    user_login_name: &str,
    tx: &mpsc::UnboundedSender<Message>,
) {
    // Get or create room atomically
    let room_existed = state.collaboration_rooms.contains_key(&room_uuid);
    let room = state.collaboration_rooms.entry(room_uuid).or_default();
    
    if !room_existed {
        info!("Created new collaboration room {} for user {}", room_uuid, user_login_name);
    }
    
    let initial_connection_count = room.len();
    
    // Find and mark duplicate connections for removal
    let mut old_connections = Vec::new();
    for conn_ref in room.iter() {
        let (existing_conn_id, existing_tx) = conn_ref.pair();
        
        if *existing_conn_id == connection_id {
            continue;
        }
        
        if let Some(existing_user_id) = state.connection_user_mapping.get(existing_conn_id) {
            if *existing_user_id == user_id {
                info!(
                    "Disconnecting older connection {} for user {} in room {} (new connection: {})",
                    existing_conn_id, user_login_name, room_uuid, connection_id
                );
                
                let _ = existing_tx.send(Message::Close(None));
                old_connections.push(existing_conn_id.clone());
            }
        }
    }
    
    // Remove old connections from room
    for old_conn_id in &old_connections {
        room.remove(old_conn_id);
    }
    
    // Add new connection to room
    room.insert(connection_id.to_string(), tx.clone());
    
    let final_connection_count = room.len();
    
    // Drop room reference to release lock
    drop(room);
    
    // Update connection mapping after room is updated
    state.connection_user_mapping.insert(connection_id.to_string(), user_id);
    
    // Clean up old connection mappings
    for old_conn_id in &old_connections {
        state.connection_user_mapping.remove(old_conn_id);
        debug!(
            "Removed duplicate connection {} for user {} in room {}",
            old_conn_id, user_login_name, room_uuid
        );
    }
    
    info!(
        "Room {} connection setup: {} -> {} connections (added: {}, removed: {})",
        room_uuid, initial_connection_count, final_connection_count, connection_id, old_connections.len()
    );
}


fn send_history_to_new_connection(
    state: &AppState,
    room_uuid: Uuid,
    tx: &mpsc::UnboundedSender<Message>,
    connection_id: &str,
) {
    if let Some(history) = state.message_history.get(&room_uuid) {
        for stored_msg in history.iter() {
            if tx.send(stored_msg.clone()).is_err() {
                warn!(
                    "Failed to send stored message to new connection {}",
                    connection_id
                );
                break;
            }
        }
        debug!(
            "Sent {} stored messages to new connection {}",
            history.len(),
            connection_id
        );
    }
}

async fn handle_incoming_messages(
    receiver: &mut futures_util::stream::SplitStream<WebSocket>,
    connection_id: &str,
    user_login_name: &str,
    user_id: Uuid,
    room_uuid: Uuid,
    is_owner: bool,
    db: &sqlx::Pool<sqlx::Postgres>,
    state: &AppState,
) {
    while let Some(msg) = receiver.next().await {
        let mut msg = match msg {
            Ok(msg) => msg,
            Err(e) => {
                error!("Websocket error for connection {}: {}", connection_id, e);
                break;
            }
        };

        if !matches!(msg, Message::Binary(_)) {
            continue;
        }

        if let Message::Binary(data) = &msg {
            if !data.is_empty() {
                let msg_type = data[0];

                if msg_type < 0x10 {
                    msg = match process_server_message(
                        msg_type,
                        data,
                        user_id,
                        user_login_name,
                        room_uuid,
                        is_owner,
                        db,
                        state,
                        &msg,
                    )
                    .await
                    {
                        Some(processed_msg) => processed_msg,
                        None => continue,
                    };
                }
            }
        }

        process_message_for_history_and_snapshots(&msg, room_uuid, user_id, connection_id, state)
            .await;

        messages::broadcast_message(&msg, room_uuid, connection_id, state).await;
    }
}

async fn process_server_message(
    msg_type: u8,
    data: &[u8],
    user_id: Uuid,
    user_login_name: &str,
    room_uuid: Uuid,
    is_owner: bool,
    db: &sqlx::Pool<sqlx::Postgres>,
    state: &AppState,
    msg: &Message,
) -> Option<Message> {
    match msg_type {
        0x01 => {
            let tx = state
                .collaboration_rooms
                .get(&room_uuid)?
                .iter()
                .find(|conn| {
                    state
                        .connection_user_mapping
                        .get(conn.key())
                        .map(|uid| *uid == user_id)
                        .unwrap_or(false)
                })
                .map(|conn| conn.value().clone())?;
            
            messages::handle_join_message(
                data,
                user_id,
                user_login_name,
                room_uuid,
                db,
                state,
                &tx,
            )
            .await
        }
        0x02 => {
            if let Err(e) = messages::handle_snapshot_message(data, room_uuid, state) {
                error!("Error handling snapshot message: {}", e);
            }
            Some(msg.clone())
        }
        0x03 => messages::handle_chat_message(data, user_id, user_login_name),
        0x07 => {
            messages::handle_end_session_message(
                data,
                user_id,
                user_login_name,
                room_uuid,
                is_owner,
                db,
                state,
                msg,
            )
            .await;
            
            // Message is already broadcast internally, don't re-broadcast
            None
        }
        _ => {
            debug!(
                "Unknown server message type: 0x{:02x} in room {}",
                msg_type, room_uuid
            );
            Some(msg.clone())
        }
    }
}

async fn process_message_for_history_and_snapshots(
    msg: &Message,
    room_uuid: Uuid,
    user_id: Uuid,
    connection_id: &str,
    state: &AppState,
) {
    let (history_count, history_bytes) = {
        let mut history = state.message_history.entry(room_uuid).or_default();

        if messages::should_store_message(msg) {
            history.push(msg.clone());
            state.last_activity_cache.insert(room_uuid, Instant::now());
            
            // Enforce limits after adding
            messages::enforce_history_limits(&mut history, room_uuid);
        }

        let total_bytes = history
            .iter()
            .map(|m| match m {
                Message::Text(text) => text.len(),
                Message::Binary(data) => data.len(),
                _ => 0,
            })
            .sum::<usize>();

        (history.len(), total_bytes)
    };

    let user_message_counts = messages::count_user_messages(state, room_uuid);

    let history_mb = history_bytes as f64 / 1_048_576.0;
    debug!(
        "Received message from connection {} in room {} (history: {} messages, {:.2} MB, user {}: {} messages)",
        connection_id,
        room_uuid,
        history_count,
        history_mb,
        user_id,
        user_message_counts.get(&user_id).unwrap_or(&0)
    );

    messages::handle_snapshot_requests(&user_message_counts, room_uuid, state).await;
}

async fn cleanup_connection(
    connection_id: &str,
    user_login_name: &str,
    user_id: Uuid,
    room_uuid: Uuid,
    db: &sqlx::Pool<sqlx::Postgres>,
    state: &AppState,
) {
    info!(
        "Websocket connection {} (user {}) leaving room {}",
        connection_id, user_login_name, room_uuid
    );

    messages::send_leave_message(room_uuid, connection_id, user_id, user_login_name, state).await;

    if let Err(e) = db::mark_participant_inactive(db, room_uuid, user_id).await {
        error!("Failed to update participant on disconnect: {}", e);
    }

    if let Some(room) = state.collaboration_rooms.get(&room_uuid) {
        room.remove(connection_id);
        state.connection_user_mapping.remove(connection_id);

        let room_connection_count = room.len();
        drop(room); // Release the room lock before database call

        // Only consider removing room if no connections remain
        if room_connection_count == 0 {
            // Double-check with database to see if there are still active participants
            // This prevents removing the room if participants are reconnecting
            match db::get_active_user_count(db, room_uuid).await {
                Ok(active_count) => {
                    if active_count == 0 {
                        // Safe to remove room since no active participants in database
                        info!("Removing room {} - no active participants remaining", room_uuid);
                        state.collaboration_rooms.remove(&room_uuid);
                        
                        let room_prefix = format!("{}:", room_uuid);
                        let keys_to_remove: Vec<String> = state
                            .snapshot_request_tracker
                            .iter()
                            .filter_map(|entry| {
                                let key = entry.key();
                                if key.starts_with(&room_prefix) {
                                    Some(key.clone())
                                } else {
                                    None
                                }
                            })
                            .collect();

                        let removed_count = keys_to_remove.len();
                        for key in keys_to_remove {
                            state.snapshot_request_tracker.remove(&key);
                        }
                        debug!("Cleaned up room {} and removed {} snapshot trackers", room_uuid, removed_count);
                    } else {
                        debug!("Keeping room {} - {} active participants remain in database", room_uuid, active_count);
                    }
                }
                Err(e) => {
                    error!("Failed to check active participants for room cleanup: {}", e);
                    // On database error, err on the side of caution and keep the room
                    debug!("Keeping room {} due to database error during cleanup check", room_uuid);
                }
            }
        } else {
            debug!("Room {} has {} connections remaining", room_uuid, room_connection_count);
        }
    } else {
        debug!("Room {} not found during cleanup for connection {}", room_uuid, connection_id);
    }
}