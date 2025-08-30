use crate::app_error::AppError;
use crate::web::state::AppState;
use axum::extract::{ws::Message, Path, State, WebSocketUpgrade};
use axum::response::Response;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

// Helper function to convert 16 bytes to UUID
fn bytes_to_uuid(bytes: &[u8]) -> Result<Uuid, &'static str> {
    if bytes.len() != 16 {
        return Err("Invalid UUID byte length");
    }
    
    let mut uuid_bytes = [0u8; 16];
    uuid_bytes.copy_from_slice(bytes);
    Ok(Uuid::from_bytes(uuid_bytes))
}

// Helper function to read little-endian u64 from bytes
fn read_u64_le(bytes: &[u8], offset: usize) -> u64 {
    if offset + 8 > bytes.len() {
        return 0;
    }
    
    u64::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7],
    ])
}

pub async fn websocket_collaborate_handler(
    Path(room_uuid): Path<Uuid>,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    Ok(ws.on_upgrade(move |socket| handle_socket(socket, room_uuid, state)))
}

async fn handle_socket(socket: axum::extract::ws::WebSocket, room_uuid: Uuid, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    
    // Generate unique connection ID
    let connection_id = Uuid::new_v4().to_string();
    
    info!("New websocket connection {} joining room {}", connection_id, room_uuid);
    
    // Add connection to room
    state.collaboration_rooms
        .entry(room_uuid)
        .or_insert_with(DashMap::new)
        .insert(connection_id.clone(), tx.clone());
    
    // Send stored messages to new client
    if let Some(history) = state.message_history.get(&room_uuid) {
        for stored_msg in history.iter() {
            if tx.send(stored_msg.clone()).is_err() {
                warn!("Failed to send stored message to new connection {}", connection_id);
                break;
            }
        }
        debug!("Sent {} stored messages to new connection {}", history.len(), connection_id);
    }
    
    // Spawn task to handle outgoing messages
    let connection_id_clone = connection_id.clone();
    let outgoing_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(msg).await.is_err() {
                warn!("Failed to send message to connection {}", connection_id_clone);
                break;
            }
        }
    });
    
    // Handle incoming messages
    while let Some(msg) = receiver.next().await {
        let msg = match msg {
            Ok(msg) => msg,
            Err(e) => {
                error!("Websocket error for connection {}: {}", connection_id, e);
                break;
            }
        };
        
        // Only process Binary messages (no more JSON support)
        if !matches!(msg, Message::Binary(_)) {
            continue;
        }
        
        // Handle server messages (< 0x10) - parse and handle specially
        if let Message::Binary(data) = &msg {
            if !data.is_empty() {
                let msg_type = data[0];
                
                // Server messages (< 0x10) need special handling
                if msg_type < 0x10 {
                    match msg_type {
                        0x01 => {
                            // JOIN message: [0x01][UUID:16][timestamp:8]
                            if data.len() >= 25 {
                                if let Ok(user_uuid) = bytes_to_uuid(&data[1..17]) {
                                    let timestamp = read_u64_le(data, 17);
                                    debug!("JOIN message from user {} at {} in room {}", 
                                           user_uuid, timestamp, room_uuid);
                                }
                            }
                        }
                        0x02 => {
                            // SNAPSHOT message: [0x02][UUID:16][layer:1][pngLength:4][pngData:variable]
                            if data.len() >= 22 {
                                if let Ok(snapshot_user) = bytes_to_uuid(&data[1..17]) {
                                    let snapshot_layer = data[17]; // 0=foreground, 1=background
                                    
                                    debug!("Processing snapshot from user {} for layer {} in room {}", 
                                           snapshot_user, snapshot_layer, room_uuid);
                                    
                                    // Filter existing history
                                    let mut history = state.message_history
                                        .entry(room_uuid)
                                        .or_insert_with(Vec::new);
                                    
                                    let initial_count = history.len();
                                    
                                    history.retain(|stored_msg| {
                                        if let Message::Binary(stored_data) = stored_msg {
                                            if stored_data.is_empty() {
                                                return true;
                                            }
                                            
                                            let stored_msg_type = stored_data[0];
                                            
                                            // Keep server messages (< 0x10) except snapshots
                                            if stored_msg_type < 0x10 {
                                                return stored_msg_type != 0x02; // Keep non-snapshot server messages
                                            }
                                            
                                            // For client messages (>= 0x10), check user and layer
                                            if stored_data.len() >= 17 {
                                                if let Ok(stored_user) = bytes_to_uuid(&stored_data[1..17]) {
                                                    // Different user - always keep
                                                    if stored_user != snapshot_user {
                                                        return true;
                                                    }
                                                    
                                                    // Same user - check message type
                                                    match stored_msg_type {
                                                        0x13 => false, // Remove POINTER_UP
                                                        0x10 | 0x11 | 0x12 => {
                                                            // DRAW_LINE (39), DRAW_POINT (31), FILL (26) - check layer
                                                            if stored_data.len() >= 18 {
                                                                let stored_layer = stored_data[17];
                                                                stored_layer != snapshot_layer // Keep if different layer
                                                            } else {
                                                                true // Keep if malformed
                                                            }
                                                        }
                                                        _ => true // Keep other client messages
                                                    }
                                                } else {
                                                    true // Keep if can't parse UUID
                                                }
                                            } else {
                                                true // Keep if too short
                                            }
                                        } else {
                                            true // Keep non-binary messages (shouldn't happen)
                                        }
                                    });
                                    
                                    let removed_count = initial_count - history.len();
                                    if removed_count > 0 {
                                        debug!("Removed {} obsolete messages from history for user {} layer {} in room {}", 
                                               removed_count, snapshot_user, snapshot_layer, room_uuid);
                                    }
                                }
                            }
                        }
                        0x03 => {
                            // CHAT message: [0x03][UUID:16][timestamp:8][msgLength:2][msgData:variable]
                            if data.len() >= 27 {
                                if let Ok(chat_user) = bytes_to_uuid(&data[1..17]) {
                                    let timestamp = read_u64_le(data, 17);
                                    let msg_length = u16::from_le_bytes([data[25], data[26]]) as usize;
                                    
                                    if data.len() >= 27 + msg_length {
                                        if let Ok(chat_text) = std::str::from_utf8(&data[27..27 + msg_length]) {
                                            debug!("Chat message from user {} at {}: {}", 
                                                   chat_user, timestamp, chat_text);
                                        }
                                    }
                                }
                            }
                        }
                        _ => {
                            debug!("Unknown server message type: 0x{:02x} in room {}", msg_type, room_uuid);
                        }
                    }
                }
                // Client messages (>= 0x10) are just broadcast, no special handling needed
            }
        }
        
        // Store message in history (skip chat messages)
        let (history_count, history_bytes) = {
            let mut history = state.message_history
                .entry(room_uuid)
                .or_insert_with(Vec::new);
            
            // Don't store chat messages in history - they're not persistent
            let should_store = if let Message::Binary(data) = &msg {
                !data.is_empty() && data[0] != 0x03 // Skip CHAT messages (0x03)
            } else {
                true // Store other message types
            };
            
            if should_store {
                history.push(msg.clone());
            }
            
            let total_bytes = history.iter().map(|m| match m {
                Message::Text(text) => text.len(),
                Message::Binary(data) => data.len(),
                _ => 0,
            }).sum::<usize>();
            
            (history.len(), total_bytes)
        };
        
        let history_mb = history_bytes as f64 / 1_048_576.0;
        debug!("Received message from connection {} in room {} (history: {} messages, {:.2} MB)", 
               connection_id, room_uuid, history_count, history_mb);
        
        // Broadcast message to all connections in the same room
        if let Some(room) = state.collaboration_rooms.get(&room_uuid) {
            let mut failed_connections = Vec::new();
            
            // Check if this is a chat message - if so, broadcast to everyone including sender
            let include_sender = if let Message::Binary(data) = &msg {
                !data.is_empty() && data[0] == 0x03 // CHAT messages (0x03) include sender
            } else {
                false
            };
            
            for entry in room.iter() {
                let (other_connection_id, other_tx) = entry.pair();
                
                // Skip sender for non-chat messages
                if !include_sender && *other_connection_id == connection_id {
                    continue;
                }
                
                // Try to send message to connection
                if other_tx.send(msg.clone()).is_err() {
                    failed_connections.push(other_connection_id.clone());
                }
            }
            
            // Clean up failed connections
            for failed_id in failed_connections {
                room.remove(&failed_id);
                debug!("Removed failed connection {} from room {}", failed_id, room_uuid);
            }
        }
    }
    
    // Clean up when connection closes
    info!("Websocket connection {} leaving room {}", connection_id, room_uuid);
    
    if let Some(room) = state.collaboration_rooms.get(&room_uuid) {
        room.remove(&connection_id);
        
        // Remove empty rooms
        if room.is_empty() {
            drop(room);
            state.collaboration_rooms.remove(&room_uuid);
            debug!("Removed empty room {}", room_uuid);
        }
    }
    
    outgoing_task.abort();
}