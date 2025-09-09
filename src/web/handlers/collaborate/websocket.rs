use crate::app_error::AppError;
use crate::models::user::AuthSession;
use crate::web::state::AppState;
use axum::extract::{ws::Message, ws::WebSocket, Path, State, WebSocketUpgrade};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use futures_util::stream::SplitSink;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use super::{db, messages, redis_messages, utils};

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
    )
    .await
    {
        Ok(owner_status) => owner_status,
        Err(_) => return,
    };

    // Send history to new connection
    send_history_to_new_connection(&state, room_uuid, &mut sender, &connection_id).await;

    info!(
        "User {} joined session {} as {}",
        user_login_name,
        room_uuid,
        if is_owner { "owner" } else { "participant" }
    );

    // Create Redis Pub/Sub subscriber for this connection
    let connection_id_clone = connection_id.clone();
    let state_clone = state.clone();
    
    // Create separate Redis subscriber task that will handle incoming Redis messages
    // and send them through a channel to the main WebSocket sending loop
    let (redis_tx, mut redis_rx) = mpsc::unbounded_channel::<Message>();
    
    let redis_task = tokio::spawn(async move {
        match state_clone.redis_state.create_room_subscriber(room_uuid).await {
            Ok(mut pubsub) => {
                loop {
                    match pubsub.on_message().next().await {
                        Some(msg) => {
                            let payload: String = msg.get_payload().unwrap_or_default();
                            match serde_json::from_str::<super::redis_state::RoomMessage>(&payload) {
                                Ok(room_msg) => {
                                    // Don't send messages back to the sender (avoid echo)
                                    if room_msg.from_connection != connection_id_clone {
                                        let ws_message = Message::Binary(room_msg.payload);
                                        if redis_tx.send(ws_message).is_err() {
                                            debug!("Redis message channel closed for connection {}", connection_id_clone);
                                            break;
                                        }
                                    }
                                }
                                Err(e) => {
                                    error!("Failed to deserialize Redis message: {}", e);
                                }
                            }
                        }
                        None => {
                            debug!("Redis Pub/Sub stream ended for connection {}", connection_id_clone);
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                error!("Failed to create Redis subscriber for connection {}: {}", connection_id_clone, e);
            }
        }
    });

    // Handle outgoing messages (from Redis) in a separate task
    let outgoing_task = tokio::spawn(async move {
        while let Some(msg) = redis_rx.recv().await {
            if sender.send(msg).await.is_err() {
                debug!("WebSocket send failed");
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

    redis_task.abort();
    outgoing_task.abort();
}

async fn setup_connection(
    db: &sqlx::Pool<sqlx::Postgres>,
    room_uuid: Uuid,
    user_id: Uuid,
    user_login_name: &str,
    connection_id: &str,
    state: &AppState,
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
        user_login_name
    ).await;

    Ok(session_info.owner_id == user_id)
}

async fn setup_connection_atomically(
    state: &AppState,
    room_uuid: Uuid,
    user_id: Uuid,
    connection_id: &str,
    user_login_name: &str,
) {
    // With pure Redis Pub/Sub, we don't need local room tracking
    // Each connection is independent with its own Redis subscriber
    
    info!("Setting up Redis Pub/Sub connection for user {} in room {}", user_login_name, room_uuid);
    
    // Register connection in Redis
    let connection_info = super::redis_state::ConnectionInfo {
        connection_id: connection_id.to_string(),
        user_id,
        room_id: room_uuid,
        user_login_name: user_login_name.to_string(),
        server_instance: state.redis_state.get_server_instance_id().to_string(),
        connected_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(),
        last_heartbeat: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(),
    };
    
    if let Err(e) = state.redis_state.register_connection(&connection_info).await {
        error!("Failed to register connection in Redis: {}", e);
    }
    
    // Add user to room presence with current timestamp
    let join_timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    if let Err(e) = state.redis_state.add_user_to_room(room_uuid, user_id, user_login_name, join_timestamp).await {
        error!("Failed to add user to room presence in Redis: {}", e);
    }
    
    info!(
        "Completed Redis Pub/Sub setup for connection {} in room {}",
        connection_id, room_uuid
    );
}


async fn send_history_to_new_connection(
    state: &AppState,
    room_uuid: Uuid,
    sender: &mut SplitSink<WebSocket, Message>,
    connection_id: &str,
) {
    let redis_store = redis_messages::RedisMessageStore::new(state.redis_pool.clone());
    
    match redis_store.get_history(room_uuid).await {
        Ok(history) => {
            for stored_msg in history.iter() {
                if sender.send(stored_msg.clone()).await.is_err() {
                    warn!(
                        "Failed to send stored message to new connection {}",
                        connection_id
                    );
                    break;
                }
            }
            debug!(
                "Sent {} stored messages from Redis to new connection {}",
                history.len(),
                connection_id
            );
        }
        Err(e) => {
            error!(
                "Failed to retrieve message history from Redis for connection {}: {}",
                connection_id, e
            );
        }
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
                        connection_id,
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
    connection_id: &str,
) -> Option<Message> {
    match msg_type {
        0x01 => {
            // For JOIN messages with Redis Pub/Sub architecture:
            // 1. Process the join (sends JOIN_RESPONSE via Redis to all participants)
            // 2. Return the original message to be broadcast (but not stored - JOIN messages are ephemeral)
            // 3. Current participants are communicated via JOIN_RESPONSE, not history replay
            
            messages::handle_join_message(
                data,
                user_id,
                user_login_name,
                room_uuid,
                db,
                state,
            )
            .await;
            
            // Return the JOIN message to be stored and broadcast via Redis
            Some(msg.clone())
        }
        0x02 => {
            if let Err(e) = messages::handle_snapshot_message(data, room_uuid, state).await {
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
                &connection_id,
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
    let redis_store = redis_messages::RedisMessageStore::new(state.redis_pool.clone());
    
    if messages::should_store_message(msg) {
        debug!(
            "Storing message to Redis for room {} (connection {}): message type = 0x{:02x}",
            room_uuid, connection_id,
            if let Message::Binary(data) = msg { 
                if data.is_empty() { 0x00 } else { data[0] } 
            } else { 0xFF }
        );
        
        // Store message in Redis
        if let Err(e) = redis_store.store_message(room_uuid, msg).await {
            error!("Failed to store message in Redis for room {}: {}", room_uuid, e);
        } else {
            debug!("Successfully stored message in Redis for room {}", room_uuid);
            
            // Update last activity cache in Redis
            if let Err(e) = state.redis_state.update_room_activity(room_uuid).await {
                error!("Failed to update room activity in Redis: {}", e);
            }
            
            // Refresh TTL for the room
            if let Err(e) = redis_store.refresh_ttl(room_uuid).await {
                error!("Failed to refresh TTL in Redis: {}", e);
            }
        }
    } else {
        debug!(
            "Skipping message storage for room {} (connection {}): message type = 0x{:02x} (filtered out)",
            room_uuid, connection_id,
            if let Message::Binary(data) = msg { 
                if data.is_empty() { 0x00 } else { data[0] } 
            } else { 0xFF }
        );
    }

    // Get current history from Redis to count messages
    let (history_count, history_bytes) = match redis_store.get_history(room_uuid).await {
        Ok(history) => {
            let total_bytes = history
                .iter()
                .map(|m| match m {
                    Message::Text(text) => text.len(),
                    Message::Binary(data) => data.len(),
                    _ => 0,
                })
                .sum::<usize>();
            (history.len(), total_bytes)
        }
        Err(e) => {
            error!("Failed to get history from Redis: {}", e);
            (0, 0)
        }
    };

    // Count user messages from Redis history
    let user_message_counts = match count_user_messages_from_redis(&redis_store, room_uuid).await {
        Ok(counts) => counts,
        Err(e) => {
            error!("Failed to count user messages from Redis: {}", e);
            std::collections::HashMap::new()
        }
    };

    let history_mb = history_bytes as f64 / 1_048_576.0;
    debug!(
        "Received message from connection {} in room {} (Redis history: {} messages, {:.2} MB, user {}: {} messages)",
        connection_id,
        room_uuid,
        history_count,
        history_mb,
        user_id,
        user_message_counts.get(&user_id).unwrap_or(&0)
    );

    messages::handle_snapshot_requests(&user_message_counts, room_uuid, state).await;
}

async fn count_user_messages_from_redis(
    redis_store: &redis_messages::RedisMessageStore,
    room_uuid: Uuid,
) -> Result<std::collections::HashMap<Uuid, usize>, Box<dyn std::error::Error + Send + Sync>> {
    use std::collections::HashMap;
    
    let history = redis_store.get_history(room_uuid).await?;
    let mut user_message_counts: HashMap<Uuid, usize> = HashMap::new();

    for stored_msg in history.iter() {
        if let Message::Binary(stored_data) = stored_msg {
            if stored_data.len() >= 17 {
                let msg_type = stored_data[0];
                
                // Count user messages for snapshot logic (exclude ephemeral and system messages)
                if messages::is_client_message(msg_type)
                    || (messages::is_server_message(msg_type)
                        && msg_type != 0x01 // Join (ephemeral)
                        && msg_type != 0x05 // SnapshotRequest
                        && msg_type != 0x06 // Layers  
                        && msg_type != 0x09) // Leave (ephemeral)
                {
                    if let Ok(msg_user_id) = utils::bytes_to_uuid(&stored_data[1..17]) {
                        *user_message_counts.entry(msg_user_id).or_insert(0) += 1;
                    }
                }
            }
        }
    }

    Ok(user_message_counts)
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

    // Unregister connection from Redis
    if let Err(e) = state.redis_state.unregister_connection(connection_id).await {
        error!("Failed to unregister connection {} from Redis: {}", connection_id, e);
    }

    // Check if user has any other connections in this room
    let room_connections = state.redis_state.get_room_connections(room_uuid).await.unwrap_or_default();
    let user_has_other_connections = {
        let mut has_other = false;
        for conn_id in &room_connections {
            if conn_id != connection_id {
                if let Ok(Some(conn_info)) = state.redis_state.get_connection_info(conn_id).await {
                    if conn_info.user_id == user_id {
                        has_other = true;
                        break;
                    }
                }
            }
        }
        has_other
    };
        
    // Remove from room presence only if no other connections for this user
    if !user_has_other_connections {
        if let Err(e) = state.redis_state.remove_user_from_room(room_uuid, user_id).await {
            error!("Failed to remove user from room presence in Redis: {}", e);
        }
    }

    let room_connection_count = room_connections.len();

    // Only consider removing room if no connections remain
    if room_connection_count == 0 {
        // Double-check with database to see if there are still active participants
        // This prevents removing the room if participants are reconnecting
        match db::get_active_user_count(db, room_uuid).await {
            Ok(active_count) => {
                if active_count == 0 {
                        // Safe to remove room since no active participants in database
                        info!("Removing room {} - no active participants remaining", room_uuid);
                        // Room cleanup is now handled entirely by Redis state
                        
                        // NOTE: We do NOT clean up Redis message history here!
                        // Redis history should persist even when no one is connected,
                        // so users can rejoin and see the previous drawing history.
                        // Redis cleanup only happens when:
                        // 1. Session is explicitly ended (END_SESSION)
                        // 2. Session is inactive for extended period (cleanup task)
                        // 3. Messages expire via TTL
                        
                        // Clean up Redis snapshot request trackers for this room
                        match state.redis_state.cleanup_snapshot_requests(room_uuid).await {
                            Ok(removed_count) => {
                                debug!("Cleaned up room {} and removed {} snapshot trackers from Redis", room_uuid, removed_count);
                            }
                            Err(e) => {
                                error!("Failed to cleanup snapshot requests for room {}: {}", room_uuid, e);
                            }
                        }
                        
                        // Clean up room presence and activity
                        if let Err(e) = state.redis_state.cleanup_room_state(room_uuid).await {
                            error!("Failed to cleanup room state for room {}: {}", room_uuid, e);
                        }
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
}