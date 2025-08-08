use crate::web::handlers::canvas::get_global_shutdown;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query,
    },
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use uuid::Uuid;

type RoomId = String;
type ClientId = String;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PixelUpdate {
    pub x: i32,
    pub y: i32,
    pub writer: String,
    pub timestamp: i64,
    pub color: Option<[u8; 3]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasMessage {
    pub msg_type: String,
    pub room_id: String,
    pub client_id: String,
    pub data: serde_json::Value,
    pub server_timestamp: Option<i64>, // Server-assigned timestamp for ordering
    pub sequence_number: Option<u64>,  // Server-assigned sequence number
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinRoomMessage {
    pub room_id: String,
    pub client_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasState {
    pub pixels: HashMap<String, (String, i64, Option<[u8; 3]>)>, // key: "x,y", value: (writer, timestamp, color)
}

pub struct CanvasRoom {
    pub clients: HashMap<ClientId, broadcast::Sender<CanvasMessage>>,
    pub state: CanvasState,
    pub message_sequence: u64,  // Global sequence counter for this room
    pub message_history: Vec<CanvasMessage>, // Store messages for ordering and replay
}

pub struct CanvasServer {
    pub rooms: Arc<RwLock<HashMap<RoomId, Arc<RwLock<CanvasRoom>>>>>,
}

impl CanvasServer {
    pub fn new() -> Self {
        Self {
            rooms: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn add_client(
        &self,
        room_id: RoomId,
        client_id: ClientId,
    ) -> broadcast::Receiver<CanvasMessage> {
        let mut rooms = self.rooms.write().await;
        let room = rooms.entry(room_id.clone()).or_insert_with(|| {
            Arc::new(RwLock::new(CanvasRoom {
                clients: HashMap::new(),
                state: CanvasState {
                    pixels: HashMap::new(),
                },
                message_sequence: 0,
                message_history: Vec::new(),
            }))
        });

        let mut room_guard = room.write().await;
        let (tx, rx) = broadcast::channel(1000);
        room_guard.clients.insert(client_id, tx);

        rx
    }

    pub async fn remove_client(&self, room_id: &RoomId, client_id: &ClientId) {
        let rooms = self.rooms.read().await;
        if let Some(room) = rooms.get(room_id) {
            let mut room_guard = room.write().await;
            room_guard.clients.remove(client_id);
        }
    }

    pub async fn broadcast_to_room(
        &self,
        room_id: &RoomId,
        sender_id: &ClientId,
        mut message: CanvasMessage,
    ) {
        let rooms = self.rooms.read().await;
        if let Some(room) = rooms.get(room_id) {
            let mut room_guard = room.write().await;
            
            // Add server timestamp and sequence number for ordering
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64;
            
            room_guard.message_sequence += 1;
            message.server_timestamp = Some(now);
            message.sequence_number = Some(room_guard.message_sequence);
            
            // Store message in history for proper ordering and replay
            room_guard.message_history.push(message.clone());
            
            // Keep only last 10000 messages to prevent memory bloat
            if room_guard.message_history.len() > 10000 {
                room_guard.message_history.drain(0..1000); // Remove first 1000 messages
            }
            
            // Broadcast to all clients except sender
            for (client_id, tx) in &room_guard.clients {
                if client_id != sender_id {
                    let _ = tx.send(message.clone());
                }
            }
        }
    }

    pub async fn update_pixel(&self, room_id: &RoomId, pixel: PixelUpdate) {
        let rooms = self.rooms.read().await;
        if let Some(room) = rooms.get(room_id) {
            let mut room_guard = room.write().await;
            let key = format!("{},{}", pixel.x, pixel.y);

            // CRDT: Last Write Wins with timestamp
            if let Some((_, existing_timestamp, _)) = room_guard.state.pixels.get(&key) {
                if pixel.timestamp <= *existing_timestamp {
                    return; // Ignore older writes
                }
            }

            room_guard
                .state
                .pixels
                .insert(key, (pixel.writer.clone(), pixel.timestamp, pixel.color));
        }
    }

    pub async fn get_canvas_state(&self, room_id: &RoomId) -> Option<CanvasState> {
        let rooms = self.rooms.read().await;
        if let Some(room) = rooms.get(room_id) {
            let room_guard = room.read().await;
            Some(room_guard.state.clone())
        } else {
            None
        }
    }
    
    pub async fn get_message_history(&self, room_id: &RoomId, from_sequence: Option<u64>) -> Vec<CanvasMessage> {
        let rooms = self.rooms.read().await;
        if let Some(room) = rooms.get(room_id) {
            let room_guard = room.read().await;
            if let Some(from_seq) = from_sequence {
                // Return messages after the specified sequence number
                room_guard.message_history
                    .iter()
                    .filter(|msg| msg.sequence_number.unwrap_or(0) > from_seq)
                    .cloned()
                    .collect()
            } else {
                // Return all messages for initial catch-up
                room_guard.message_history.clone()
            }
        } else {
            Vec::new()
        }
    }
}

// Global canvas server instance
static CANVAS_SERVER: tokio::sync::OnceCell<CanvasServer> = tokio::sync::OnceCell::const_new();

async fn get_canvas_server() -> &'static CanvasServer {
    CANVAS_SERVER
        .get_or_init(|| async { CanvasServer::new() })
        .await
}

#[derive(Deserialize)]
pub struct WebSocketQuery {
    room_id: Option<String>,
    client_id: Option<String>,
}

pub async fn ws_handler(ws: WebSocketUpgrade, Query(params): Query<WebSocketQuery>) -> Response {
    let room_id = params.room_id.unwrap_or_else(|| "default".to_string());
    let client_id = params
        .client_id
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    ws.on_upgrade(move |socket| handle_socket(socket, room_id, client_id))
}

async fn handle_socket(mut socket: WebSocket, room_id: String, client_id: String) {
    let server = get_canvas_server().await;
    let mut rx = server.add_client(room_id.clone(), client_id.clone()).await;

    // Subscribe to global shutdown signals
    let global_shutdown = get_global_shutdown().await;
    let mut shutdown_rx = global_shutdown.subscribe();

    // Send message history for proper catch-up with server timestamps
    let message_history = server.get_message_history(&room_id, None).await;
    
    // Send catchup_start message
    let catchup_start = CanvasMessage {
        msg_type: "catchup_start".to_string(),
        room_id: room_id.clone(),
        client_id: client_id.clone(),
        data: serde_json::json!({"total": message_history.len()}),
        server_timestamp: None,
        sequence_number: None,
    };
    
    if let Ok(msg_json) = serde_json::to_string(&catchup_start) {
        if socket.send(Message::Text(msg_json)).await.is_err() {
            server.remove_client(&room_id, &client_id).await;
            return;
        }
    }
    
    // Send all historical messages in order (they already have server timestamps)
    for (index, msg) in message_history.iter().enumerate() {
        if let Ok(msg_json) = serde_json::to_string(msg) {
            if socket.send(Message::Text(msg_json)).await.is_err() {
                server.remove_client(&room_id, &client_id).await;
                return;
            }
        }
        
        // Send progress updates for large catch-ups
        if index % 100 == 0 && index > 0 {
            let progress_msg = CanvasMessage {
                msg_type: "catchup_progress".to_string(),
                room_id: room_id.clone(),
                client_id: client_id.clone(),
                data: serde_json::json!({"current": index, "total": message_history.len()}),
                server_timestamp: None,
                sequence_number: None,
            };
            if let Ok(msg_json) = serde_json::to_string(&progress_msg) {
                let _ = socket.send(Message::Text(msg_json)).await;
            }
        }
    }
    
    // Send catchup_complete message
    let catchup_complete = CanvasMessage {
        msg_type: "catchup_complete".to_string(),
        room_id: room_id.clone(),
        client_id: client_id.clone(),
        data: serde_json::json!({}),
        server_timestamp: None,
        sequence_number: None,
    };
    
    if let Ok(msg_json) = serde_json::to_string(&catchup_complete) {
        if socket.send(Message::Text(msg_json)).await.is_err() {
            server.remove_client(&room_id, &client_id).await;
            return;
        }
    }

    let (mut sender, mut receiver) = socket.split();

    // Handle incoming messages from client
    let server_clone = server;
    let room_id_recv = room_id.clone();
    let client_id_recv = client_id.clone();

    let mut shutdown_rx_send = global_shutdown.subscribe();
    let send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg_result = rx.recv() => {
                    match msg_result {
                        Ok(msg) => {
                            if let Ok(msg_json) = serde_json::to_string(&msg) {
                                if sender.send(Message::Text(msg_json)).await.is_err() {
                                    break;
                                }
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            // Client is lagging, skip messages and continue
                            continue;
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            // Channel is closed, exit
                            break;
                        }
                    }
                }
                _ = shutdown_rx_send.recv() => {
                    // Shutdown signal received, close connection
                    let _ = sender.send(Message::Close(None)).await;
                    break;
                }
            }
        }
    });

    let recv_server = server_clone;
    let mut shutdown_rx_recv = global_shutdown.subscribe();
    let recv_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg_option = receiver.next() => {
                    match msg_option {
                        Some(Ok(msg)) => {
                            if let Message::Text(text) = msg {
                                if let Ok(canvas_msg) = serde_json::from_str::<CanvasMessage>(&text) {
                                    match canvas_msg.msg_type.as_str() {
                                        "canvas_state_compressed" => {
                                            // Forward compressed messages directly without processing
                                            // The compression/decompression is handled by the client
                                            recv_server
                                                .broadcast_to_room(&room_id_recv, &client_id_recv, canvas_msg)
                                                .await;
                                        }
                                        _ => {
                                            // Forward other message types
                                            recv_server
                                                .broadcast_to_room(&room_id_recv, &client_id_recv, canvas_msg)
                                                .await;
                                        }
                                    }
                                }
                            }
                        }
                        Some(Err(_)) => break,
                        None => break,
                    }
                }
                _ = shutdown_rx_recv.recv() => {
                    // Shutdown signal received, exit receive loop
                    break;
                }
            }
        }
    });

    // Wait for either task to finish or shutdown signal
    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
        _ = shutdown_rx.recv() => {
            // Shutdown signal received, force close connection
        },
    }

    server.remove_client(&room_id, &client_id).await;
}
