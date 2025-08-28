use crate::app_error::AppError;
use crate::web::state::AppState;
use axum::extract::{ws::Message, Path, State, WebSocketUpgrade};
use axum::response::Response;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

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
        
        // Only process Binary and Text messages
        if !matches!(msg, Message::Text(_) | Message::Binary(_)) {
            continue;
        }
        
        debug!("Received message from connection {} in room {}", connection_id, room_uuid);
        
        // Broadcast message to all other connections in the same room
        if let Some(room) = state.collaboration_rooms.get(&room_uuid) {
            let mut failed_connections = Vec::new();
            
            for entry in room.iter() {
                let (other_connection_id, other_tx) = entry.pair();
                
                // Skip sender
                if *other_connection_id == connection_id {
                    continue;
                }
                
                // Try to send message to other connection
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