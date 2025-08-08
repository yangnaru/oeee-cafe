use crate::models::user::AuthSession;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use uuid::Uuid;

use crate::models::canvas_session::{
    CanvasMessage as DbCanvasMessage, CanvasSession, CanvasSessionUser,
};
use crate::web::state::AppState;
use anyhow::Result;

type RoomId = String;
type ClientId = String;

#[derive(Debug, Clone)]
pub struct CanvasMessage {
    pub length: u32,
    pub msg_type: u8,
    pub user_id: u16,
    pub payload: Vec<u8>,
}

impl CanvasMessage {
    pub fn parse(data: &[u8]) -> Result<Self, String> {
        if data.len() < 8 {
            return Err("Message too short for header".to_string());
        }

        let length = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
        let msg_type = data[4];
        let user_id = u16::from_be_bytes([data[6], data[7]]);

        let expected_total_len = 8 + length as usize;
        if data.len() < expected_total_len {
            return Err(format!(
                "Message incomplete: expected {}, got {}",
                expected_total_len,
                data.len()
            ));
        }

        let payload = data[8..expected_total_len].to_vec();

        Ok(CanvasMessage {
            length,
            msg_type,
            user_id,
            payload,
        })
    }

    pub fn serialize(&self) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&self.length.to_be_bytes());
        data.push(self.msg_type);
        data.push(0); // Reserved byte
        data.extend_from_slice(&self.user_id.to_be_bytes());
        data.extend_from_slice(&self.payload);
        data
    }

    pub fn is_drawing_command(&self) -> bool {
        // Command messages are in the range 64-127 in Drawpile protocol
        self.msg_type >= 64 && self.msg_type <= 127
    }

    pub fn is_meta_message(&self) -> bool {
        // Meta messages are in the range 128-191
        self.msg_type >= 128 && self.msg_type <= 191
    }

    pub fn is_chat_message(&self) -> bool {
        // Chat messages use message type 201
        self.msg_type == 201
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasUser {
    pub user_id: u16,
    pub client_id: ClientId,
    pub name: String,
}

// In-memory room management for active connections
#[derive(Debug, Clone)]
pub struct ActiveRoom {
    pub session_id: Uuid,
    pub clients: HashMap<ClientId, (CanvasUser, broadcast::Sender<CanvasMessage>)>,
    pub next_user_id: u16,
}

impl ActiveRoom {
    pub fn new(session_id: Uuid) -> Self {
        Self {
            session_id,
            clients: HashMap::new(),
            next_user_id: 1,
        }
    }

    pub fn assign_user_id(&mut self) -> u16 {
        let id = self.next_user_id;
        self.next_user_id = self.next_user_id.wrapping_add(1);
        if self.next_user_id == 0 {
            self.next_user_id = 1; // Skip 0 (server)
        }
        id
    }
}

pub struct CanvasServer {
    pub rooms: Arc<RwLock<HashMap<RoomId, Arc<RwLock<ActiveRoom>>>>>,
    pub app_state: AppState,
}

impl CanvasServer {
    pub fn new(app_state: AppState) -> Self {
        Self {
            rooms: Arc::new(RwLock::new(HashMap::new())),
            app_state,
        }
    }

    pub async fn add_client(
        &self,
        room_id: RoomId,
        client_id: ClientId,
        user_name: String,
    ) -> Result<(CanvasUser, broadcast::Receiver<CanvasMessage>)> {
        let db = self.app_state.config.connect_database().await?;

        // Get or create session in database
        let session =
            CanvasSession::get_or_create_by_room_id(&db, room_id.clone(), None, None).await?;

        let mut rooms = self.rooms.write().await;
        let room = rooms
            .entry(room_id.clone())
            .or_insert_with(|| Arc::new(RwLock::new(ActiveRoom::new(session.id))));

        let mut room_guard = room.write().await;
        let user_id = room_guard.assign_user_id();
        let user = CanvasUser {
            user_id,
            client_id: client_id.clone(),
            name: user_name.clone(),
        };

        // Add user to database
        CanvasSessionUser::add_user(
            &db,
            session.id,
            user_id as i16,
            user_name,
            None, // TODO: Link to authenticated user
        )
        .await?;

        let (tx, rx) = broadcast::channel(1000);
        room_guard.clients.insert(client_id, (user.clone(), tx));

        Ok((user, rx))
    }

    pub async fn remove_client(&self, room_id: &RoomId, client_id: &ClientId) -> Result<()> {
        let db = self.app_state.config.connect_database().await?;

        // Remove from in-memory room first to get the user_id
        let user_id = {
            let rooms = self.rooms.read().await;
            if let Some(room) = rooms.get(room_id) {
                let room_guard = room.read().await;
                room_guard
                    .clients
                    .get(client_id)
                    .map(|(user, _)| user.user_id)
            } else {
                None
            }
        };

        // Find session and mark user as disconnected in database
        if let Some(session) = CanvasSession::find_by_room_id(&db, room_id).await? {
            if let Some(protocol_user_id) = user_id {
                CanvasSessionUser::remove_user(&db, session.id, protocol_user_id as i16).await?;
            }
        }

        // Remove from in-memory room
        let rooms = self.rooms.read().await;
        if let Some(room) = rooms.get(room_id) {
            let mut room_guard = room.write().await;
            room_guard.clients.remove(client_id);
        }

        Ok(())
    }

    pub async fn broadcast_to_room(
        &self,
        room_id: &RoomId,
        sender_client_id: &ClientId,
        mut message: CanvasMessage,
    ) -> Result<()> {
        let db = self.app_state.config.connect_database().await?;

        let rooms = self.rooms.read().await;
        if let Some(room) = rooms.get(room_id) {
            let room_guard = room.write().await;

            // Set the user_id in the message based on the sender
            let sender_user_name = if let Some((user, _)) = room_guard.clients.get(sender_client_id)
            {
                message.user_id = user.user_id;
                Some(user.name.clone())
            } else {
                None
            };

            // Store message in database if it's a drawing command, meta message, or chat message
            if message.is_drawing_command()
                || message.is_meta_message()
                || message.is_chat_message()
            {
                DbCanvasMessage::add_message(
                    &db,
                    room_guard.session_id,
                    message.msg_type as i16,
                    message.user_id as i16,
                    sender_user_name,
                    message.payload.clone(),
                )
                .await?;
            }

            // Update sender's activity
            if let Some((user, _)) = room_guard.clients.get(sender_client_id) {
                CanvasSessionUser::update_activity(&db, room_guard.session_id, user.user_id as i16)
                    .await?;
            }

            // Broadcast to all clients except sender
            for (client_id, (_, tx)) in &room_guard.clients {
                if client_id != sender_client_id {
                    let _ = tx.send(message.clone());
                }
            }
        }

        Ok(())
    }

    pub async fn get_canvas_state(&self, room_id: &RoomId) -> Result<Vec<CanvasMessage>> {
        let db = self.app_state.config.connect_database().await?;

        if let Some(session) = CanvasSession::find_by_room_id(&db, room_id).await? {
            let db_messages = DbCanvasMessage::get_drawing_commands_only(&db, session.id).await?;

            let messages = db_messages
                .into_iter()
                .map(|db_msg| CanvasMessage {
                    length: db_msg.message_data.len() as u32,
                    msg_type: db_msg.message_type as u8,
                    user_id: db_msg.user_id as u16,
                    payload: db_msg.message_data,
                })
                .collect();

            Ok(messages)
        } else {
            Ok(Vec::new())
        }
    }

    pub async fn get_user_list(&self, room_id: &RoomId) -> Result<Vec<CanvasUser>> {
        let db = self.app_state.config.connect_database().await?;

        if let Some(session) = CanvasSession::find_by_room_id(&db, room_id).await? {
            let db_users = CanvasSessionUser::get_connected_users(&db, session.id).await?;

            let users = db_users
                .into_iter()
                .map(|db_user| CanvasUser {
                    user_id: db_user.protocol_user_id as u16,
                    client_id: format!("user_{}", db_user.protocol_user_id), // Generate client_id from protocol_user_id
                    name: db_user.user_name,
                })
                .collect();

            Ok(users)
        } else {
            Ok(Vec::new())
        }
    }
}

// Global shutdown mechanism
static GLOBAL_SHUTDOWN: tokio::sync::OnceCell<broadcast::Sender<()>> =
    tokio::sync::OnceCell::const_new();

// Global Canvas server instance
static CANVAS_SERVER: tokio::sync::OnceCell<CanvasServer> = tokio::sync::OnceCell::const_new();

pub async fn get_global_shutdown() -> &'static broadcast::Sender<()> {
    GLOBAL_SHUTDOWN
        .get_or_init(|| async {
            let (tx, _) = broadcast::channel(1);
            tx
        })
        .await
}

pub async fn trigger_global_shutdown() {
    if let Some(shutdown_tx) = GLOBAL_SHUTDOWN.get() {
        let _ = shutdown_tx.send(());
    }
}

async fn get_canvas_server(app_state: &AppState) -> &'static CanvasServer {
    CANVAS_SERVER
        .get_or_init(|| async { CanvasServer::new(app_state.clone()) })
        .await
}

#[derive(Deserialize)]
pub struct CanvasWebSocketQuery {
    room_id: Option<String>,
    client_id: Option<String>,
}

pub async fn canvas_ws_handler(
    auth_session: AuthSession,
    ws: WebSocketUpgrade,
    State(app_state): State<AppState>,
    Query(params): Query<CanvasWebSocketQuery>,
) -> Response {
    let room_id = params
        .room_id
        .unwrap_or_else(|| "default_canvas".to_string());
    let client_id = params
        .client_id
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    // Use authenticated user's display name instead of query parameter
    let user_name = if let Some(user) = &auth_session.user {
        user.display_name.clone()
    } else {
        format!("User_{}", &client_id[..8])
    };

    ws.on_upgrade(move |socket| {
        handle_canvas_socket(socket, room_id, client_id, user_name, app_state)
    })
}

async fn handle_canvas_socket(
    mut socket: WebSocket,
    room_id: String,
    client_id: String,
    user_name: String,
    app_state: AppState,
) {
    let server = get_canvas_server(&app_state).await;

    let (_user, mut rx) = match server
        .add_client(room_id.clone(), client_id.clone(), user_name)
        .await
    {
        Ok(result) => result,
        Err(e) => {
            println!("Failed to add client: {}", e);
            return;
        }
    };

    // Subscribe to global shutdown signals
    let global_shutdown = get_global_shutdown().await;
    let mut shutdown_rx = global_shutdown.subscribe();

    // Send canvas state to new client
    match server.get_canvas_state(&room_id).await {
        Ok(canvas_state) => {
            for msg in canvas_state {
                let binary_data = msg.serialize();
                if socket.send(Message::Binary(binary_data)).await.is_err() {
                    let _ = server.remove_client(&room_id, &client_id).await;
                    return;
                }
            }
        }
        Err(e) => {
            println!("Failed to get canvas state: {}", e);
        }
    }

    // Send user list (as a custom meta message)
    match server.get_user_list(&room_id).await {
        Ok(users) => {
            let user_list_json = serde_json::to_string(&users).unwrap_or_default();
            let user_list_msg = CanvasMessage {
                length: user_list_json.len() as u32,
                msg_type: 200, // Custom meta message for user list
                user_id: 0,    // Server message
                payload: user_list_json.into_bytes(),
            };
            let binary_data = user_list_msg.serialize();
            if socket.send(Message::Binary(binary_data)).await.is_err() {
                let _ = server.remove_client(&room_id, &client_id).await;
                return;
            }
        }
        Err(e) => {
            println!("Failed to get user list: {}", e);
        }
    }

    let (mut sender, mut receiver) = socket.split();

    // Handle outgoing messages to client
    let server_clone = Arc::new(server);
    let mut shutdown_rx_send = global_shutdown.subscribe();
    let send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg_result = rx.recv() => {
                    match msg_result {
                        Ok(msg) => {
                            let binary_data = msg.serialize();
                            if sender.send(Message::Binary(binary_data)).await.is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            continue;
                        }
                        Err(broadcast::error::RecvError::Closed) => {
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

    // Handle incoming messages from client
    let recv_server = server_clone.clone();
    let room_id_recv = room_id.clone();
    let client_id_recv = client_id.clone();
    let mut shutdown_rx_recv = global_shutdown.subscribe();

    let recv_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg_option = receiver.next() => {
                    match msg_option {
                        Some(Ok(msg)) => {
                            match msg {
                                Message::Binary(data) => {
                                    match CanvasMessage::parse(&data) {
                                        Ok(canvas_msg) => {
                                            // Forward Canvas messages to room
                                            if let Err(e) = recv_server
                                                .broadcast_to_room(&room_id_recv, &client_id_recv, canvas_msg)
                                                .await
                                            {
                                                println!("Failed to broadcast message: {}", e);
                                            }
                                        }
                                        Err(e) => {
                                            println!("Failed to parse Canvas message: {} (data length: {})", e, data.len());
                                            if data.len() > 0 {
                                                println!("First 8 bytes: {:?}", &data[..std::cmp::min(8, data.len())]);
                                            }
                                        }
                                    }
                                }
                                Message::Text(_) => {
                                    // Ignore text messages in Canvas mode
                                }
                                Message::Close(_) => {
                                    break;
                                }
                                _ => {}
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

    let _ = server.remove_client(&room_id, &client_id).await;
}
