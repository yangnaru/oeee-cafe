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

    state
        .connection_user_mapping
        .insert(connection_id.to_string(), user_id);

    disconnect_duplicate_connections(state, room_uuid, user_id, connection_id, user_login_name);
    add_connection_to_room(state, room_uuid, connection_id, tx);
    send_history_to_new_connection(state, room_uuid, tx, connection_id);

    Ok(session_info.owner_id == user_id)
}

fn disconnect_duplicate_connections(
    state: &AppState,
    room_uuid: Uuid,
    user_id: Uuid,
    connection_id: &str,
    user_login_name: &str,
) {
    if let Some(room) = state.collaboration_rooms.get(&room_uuid) {
        let mut connections_to_remove = Vec::new();

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
                    connections_to_remove.push(existing_conn_id.clone());
                }
            }
        }

        for old_conn_id in connections_to_remove {
            room.remove(&old_conn_id);
            state.connection_user_mapping.remove(&old_conn_id);
            debug!(
                "Removed duplicate connection {} for user {} in room {}",
                old_conn_id, user_login_name, room_uuid
            );
        }
    }
}

fn add_connection_to_room(
    state: &AppState,
    room_uuid: Uuid,
    connection_id: &str,
    tx: &mpsc::UnboundedSender<Message>,
) {
    state
        .collaboration_rooms
        .entry(room_uuid)
        .or_default()
        .insert(connection_id.to_string(), tx.clone());
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

        if room.is_empty() {
            drop(room);
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

            for key in keys_to_remove {
                state.snapshot_request_tracker.remove(&key);
            }
            debug!("Removed empty room {}", room_uuid);
        }
    }
}