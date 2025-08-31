use crate::app_error::AppError;
use crate::models::user::AuthSession;
use crate::web::handlers::{create_base_ftl_context, get_bundle, ExtractAcceptLanguage};
use crate::web::state::AppState;
use axum::extract::{ws::Message, Path, State, WebSocketUpgrade, Query};
use axum::response::{Html, Response, Json, IntoResponse};
use axum::body::Bytes;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use hex;
use minijinja::context;
use serde::{Deserialize, Serialize};
use sha256;
use std::collections::HashMap;
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

// Helper function to encode END_SESSION message
fn encode_end_session_message(user_id_str: &str, post_url: &str) -> Vec<u8> {
    let user_uuid = Uuid::parse_str(user_id_str).unwrap_or_default();
    let post_url_bytes = post_url.as_bytes();
    let url_length = post_url_bytes.len() as u16;
    
    let mut message = Vec::with_capacity(1 + 16 + 2 + post_url_bytes.len());
    
    // Message type: 0x07 (END_SESSION)
    message.push(0x07);
    
    // UUID: 16 bytes
    message.extend_from_slice(&user_uuid.as_bytes()[..]);
    
    // URL length: 2 bytes (little-endian)
    message.extend_from_slice(&url_length.to_le_bytes());
    
    // URL: variable length
    message.extend_from_slice(post_url_bytes);
    
    message
}

// Structs for new lobby functionality
#[derive(Deserialize)]
pub struct CreateSessionRequest {
    title: Option<String>,
    width: i32,
    height: i32,
    is_public: bool,
    community_id: Uuid,
}

#[derive(Serialize)]
pub struct CreateSessionResponse {
    session_id: String,
    url: String,
}

#[derive(Serialize)]
pub struct SaveSessionResponse {
    post_id: String,
    owner_login_name: String,
    post_url: String,
}

#[derive(Serialize)]
pub struct SessionWithCounts {
    id: Uuid,
    owner_login_name: String,
    title: Option<String>,
    width: i32,
    height: i32,
    created_at: chrono::NaiveDateTime,
    participant_count: Option<i64>,
}

#[derive(Serialize)]
pub struct CommunityInfo {
    id: Uuid,
    name: String,
}

#[derive(Serialize)]
pub struct AuthInfo {
    user_id: String,
    login_name: String,
}

// Auth endpoint for getting user info
pub async fn get_auth_info(auth_session: AuthSession) -> Result<Json<AuthInfo>, AppError> {
    let user = auth_session.user.ok_or_else(|| anyhow::anyhow!("Authentication required"))?;
    
    Ok(Json(AuthInfo {
        user_id: user.id.to_string(),
        login_name: user.login_name,
    }))
}

// Collaborative lobby page handler
pub async fn collaborate_lobby(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
) -> Result<Html<String>, AppError> {
    let user = auth_session.user.ok_or_else(|| anyhow::anyhow!("Authentication required"))?;
    
    let db = state.config.connect_database().await?;
    
    // Get communities user can post to
    let communities_data = sqlx::query!(
        r#"
        SELECT id, name FROM communities 
        WHERE is_private = false OR owner_id = $1
        ORDER BY name ASC
        "#,
        user.id
    )
    .fetch_all(&db)
    .await?;

    let communities: Vec<CommunityInfo> = communities_data.into_iter().map(|row| CommunityInfo {
        id: row.id,
        name: row.name,
    }).collect();
    
    // Get active public sessions with participant counts
    let active_sessions = sqlx::query_as!(
        SessionWithCounts,
        r#"
        SELECT 
            cs.id,
            u.login_name as owner_login_name,
            cs.title,
            cs.width,
            cs.height,
            cs.created_at,
            COALESCE(COUNT(csp.id) FILTER (WHERE csp.is_active = true), 0) as participant_count
        FROM collaborative_sessions cs
        JOIN users u ON cs.owner_id = u.id
        LEFT JOIN collaborative_sessions_participants csp ON cs.id = csp.session_id 
        WHERE cs.is_public = true AND cs.is_active = true AND cs.ended_at IS NULL
        GROUP BY cs.id, u.login_name
        ORDER BY cs.last_activity DESC
        LIMIT 20
        "#
    )
    .fetch_all(&db)
    .await?;

    let template = state.env.get_template("collaborate_lobby.jinja")?;
    let user_preferred_language = user.preferred_language.clone();
    let bundle = get_bundle(&accept_language, user_preferred_language);
    
    let rendered = template.render(context! {
        current_user => user,
        active_sessions => active_sessions,
        communities => communities,
        canvas_sizes => vec![
            ("500x500", "500×500 (Square)"),
            ("800x600", "800×600 (Landscape)"),
            ("600x800", "600×800 (Portrait)"),
            ("1024x768", "1024×768 (Large)"),
            ("320x320", "320×320 (Small)"),
        ],
        ..create_base_ftl_context(&bundle)
    })?;
    
    Ok(Html(rendered))
}

// Create new session handler
pub async fn create_collaborative_session(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Json(request): Json<CreateSessionRequest>,
) -> Result<Json<CreateSessionResponse>, AppError> {
    let user = auth_session.user.ok_or_else(|| anyhow::anyhow!("Authentication required"))?;
    
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    
    // Create new session
    let session_id = Uuid::new_v4();
    sqlx::query!(
        r#"
        INSERT INTO collaborative_sessions 
        (id, owner_id, title, width, height, is_public, community_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
        session_id,
        user.id,
        request.title,
        request.width,
        request.height,
        request.is_public,
        request.community_id
    )
    .execute(&mut *tx)
    .await?;
    
    tx.commit().await?;
    
    Ok(Json(CreateSessionResponse {
        session_id: session_id.to_string(),
        url: format!("/collaborate/{}", session_id),
    }))
}

// Save collaborative session handler
pub async fn save_collaborative_session(
    Path(session_uuid): Path<Uuid>,
    auth_session: AuthSession,
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<SaveSessionResponse>, AppError> {
    let user = auth_session.user.ok_or_else(|| anyhow::anyhow!("Authentication required"))?;
    
    let db = state.config.connect_database().await?;
    
    // Verify user is the session owner
    let session = sqlx::query!(
        r#"
        SELECT owner_id, u.login_name as owner_login_name FROM collaborative_sessions cs
        JOIN users u ON cs.owner_id = u.id
        WHERE cs.id = $1 AND cs.is_active = true
        "#,
        session_uuid
    )
    .fetch_optional(&db)
    .await?
    .ok_or_else(|| anyhow::anyhow!("Session not found or not active"))?;
    
    if session.owner_id != user.id {
        return Err(anyhow::anyhow!("Only session owner can save").into());
    }
    
    // Convert Bytes to Vec<u8> for handle_save_request
    let png_data = body.to_vec();
    
    // Call the existing save request handler
    let (post_id, owner_login_name) = handle_save_request(
        db,
        session_uuid,
        user.id,
        png_data,
        state,
    ).await.map_err(|e| anyhow::anyhow!("Save failed: {}", e))?;
    
    let post_url = format!("/@{}/{}", owner_login_name, post_id);
    
    Ok(Json(SaveSessionResponse {
        post_id: post_id.to_string(),
        owner_login_name,
        post_url,
    }))
}

// Serve collaborative app handler
pub async fn serve_collaborative_app(
    Path(session_uuid): Path<Uuid>,
    Query(_params): Query<HashMap<String, String>>,
    auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    // Just verify user is authenticated
    let _user = auth_session.user.ok_or_else(|| anyhow::anyhow!("Authentication required"))?;
    
    let db = state.config.connect_database().await?;
    
    // Get session - anyone with the link can access
    let _session = sqlx::query!(
        r#"
        SELECT width, height FROM collaborative_sessions
        WHERE id = $1 AND is_active = true
        "#,
        session_uuid
    )
    .fetch_optional(&db)
    .await?
    .ok_or_else(|| anyhow::anyhow!("Session not found"))?;
    
    // Serve the React app - it will parse dimensions and clean the URL
    let html = std::fs::read_to_string("neo-cucumber/dist/index.html")
        .map_err(|_| anyhow::anyhow!("Failed to load collaborative app"))?;
    Ok(Html(html).into_response())
}

pub async fn websocket_collaborate_handler(
    Path(room_uuid): Path<Uuid>,
    auth_session: AuthSession,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    let user = auth_session.user.ok_or_else(|| anyhow::anyhow!("Authentication required"))?;
    Ok(ws.on_upgrade(move |socket| handle_socket(socket, room_uuid, state, user.id, user.login_name)))
}

async fn handle_socket(
    socket: axum::extract::ws::WebSocket, 
    room_uuid: Uuid, 
    state: AppState,
    user_id: Uuid,
    user_login_name: String
) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    // Generate unique connection ID
    let connection_id = Uuid::new_v4().to_string();

    info!(
        "New websocket connection {} (user {}) joining room {}",
        connection_id, user_login_name, room_uuid
    );
    
    debug!("Starting database connection for WebSocket {}", connection_id);

    // Track participant in database
    let db = match state.config.connect_database().await {
        Ok(db) => {
            debug!("Database connection successful for WebSocket {}", connection_id);
            db
        },
        Err(e) => {
            error!("Failed to connect to database for WebSocket {}: {}", connection_id, e);
            return;
        }
    };

    // Get session info and check if user is owner
    let is_owner = match sqlx::query!(
        r#"
        SELECT owner_id, width, height, title, ended_at FROM collaborative_sessions
        WHERE id = $1 AND is_active = true
        "#,
        room_uuid
    )
    .fetch_optional(&db)
    .await
    {
        Ok(Some(session)) => {
            // Check if session has ended
            if session.ended_at.is_some() {
                info!("User {} attempted to join ended session {}", user_login_name, room_uuid);
                
                // Get the actual post URL if the session was saved
                let post_url = if let Ok(post_info) = sqlx::query!(
                    r#"
                    SELECT p.id as post_id, u.login_name
                    FROM collaborative_sessions cs
                    JOIN posts p ON cs.saved_post_id = p.id  
                    JOIN users u ON cs.owner_id = u.id
                    WHERE cs.id = $1
                    "#,
                    room_uuid
                ).fetch_optional(&db).await {
                    if let Some(info) = post_info {
                        format!("/@{}/{}", info.login_name, info.post_id)
                    } else {
                        "/collaborate".to_string() // Fallback to lobby
                    }
                } else {
                    "/collaborate".to_string() // Fallback to lobby  
                };
                
                // Send END_SESSION message to immediately redirect the user
                let end_session_data = encode_end_session_message(&user_id.to_string(), &post_url);
                if let Err(e) = sender.send(Message::Binary(end_session_data)).await {
                    error!("Failed to send END_SESSION message: {}", e);
                }
                return;
            }

            // Add/update participant in database
            if let Err(e) = sqlx::query!(
                r#"
                INSERT INTO collaborative_sessions_participants 
                (session_id, user_id, is_active)
                VALUES ($1, $2, true)
                ON CONFLICT (session_id, user_id) 
                DO UPDATE SET is_active = true, left_at = NULL
                "#,
                room_uuid,
                user_id
            )
            .execute(&db)
            .await
            {
                error!("Failed to track participant: {}", e);
            }

            // Update session activity
            if let Err(e) = sqlx::query!(
                "UPDATE collaborative_sessions SET last_activity = NOW() WHERE id = $1",
                room_uuid
            )
            .execute(&db)
            .await
            {
                error!("Failed to update session activity: {}", e);
            }

            debug!("Session {} found, user {} is owner: {}", room_uuid, user_login_name, session.owner_id == user_id);
            session.owner_id == user_id
        }
        Ok(None) => {
            error!("Session {} not found for WebSocket {}", room_uuid, connection_id);
            return;
        }
        Err(e) => {
            error!("Failed to get session info for WebSocket {}: {}", connection_id, e);
            return;
        }
    };

    info!(
        "User {} joined session {} as {}",
        user_login_name,
        room_uuid,
        if is_owner { "owner" } else { "participant" }
    );

    // Add connection to room
    debug!("Adding connection {} to room {}", connection_id, room_uuid);
    state
        .collaboration_rooms
        .entry(room_uuid)
        .or_insert_with(DashMap::new)
        .insert(connection_id.clone(), tx.clone());
    debug!("Connection {} added to room {} successfully", connection_id, room_uuid);

    // Send stored messages to new client
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

    // Spawn task to handle outgoing messages
    let connection_id_clone = connection_id.clone();
    let outgoing_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match sender.send(msg).await {
                Ok(_) => {
                    debug!("Successfully sent message to connection {}", connection_id_clone);
                }
                Err(e) => {
                    error!(
                        "Failed to send message to connection {}: {}",
                        connection_id_clone, e
                    );
                    break;
                }
            }
        }
        warn!("Outgoing message task ended for connection {}", connection_id_clone);
    });

    // Handle incoming messages
    debug!("Starting message receive loop for connection {}", connection_id);
    while let Some(msg) = receiver.next().await {
        debug!("Received message from WebSocket for connection {}", connection_id);
        let msg = match msg {
            Ok(msg) => {
                debug!("Message successfully parsed for connection {}", connection_id);
                msg
            },
            Err(e) => {
                error!("Websocket error for connection {}: {}", connection_id, e);
                break;
            }
        };

        // Only process Binary messages (no more JSON support)
        if !matches!(msg, Message::Binary(_)) {
            debug!("Received non-binary message from connection {}: {:?}", connection_id, msg);
            match msg {
                Message::Close(frame) => {
                    info!("WebSocket close frame received from connection {}: {:?}", connection_id, frame);
                    break; // Client initiated close
                }
                _ => {
                    debug!("Skipping non-binary message type from connection {}", connection_id);
                    continue;
                }
            }
        }

        // Handle server messages (< 0x10) - parse and handle specially
        if let Message::Binary(data) = &msg {
            if !data.is_empty() {
                let msg_type = data[0];
                debug!("Received binary message with type 0x{:02x} from connection {}", msg_type, connection_id);

                // Server messages (< 0x10) need special handling
                if msg_type < 0x10 {
                    match msg_type {
                        0x01 => {
                            // JOIN message: [0x01][UUID:16][timestamp:8]
                            if data.len() >= 25 {
                                if let Ok(user_uuid) = bytes_to_uuid(&data[1..17]) {
                                    let timestamp = read_u64_le(data, 17);
                                    debug!(
                                        "JOIN message from user {} at {} in room {}",
                                        user_uuid, timestamp, room_uuid
                                    );
                                    
                                    // Insert user into participants table with joined_at timestamp
                                    if let Err(e) = sqlx::query!(
                                        r#"
                                        INSERT INTO collaborative_sessions_participants 
                                        (session_id, user_id, joined_at, is_active)
                                        VALUES ($1, $2, to_timestamp($3::bigint / 1000), true)
                                        ON CONFLICT (session_id, user_id) 
                                        DO UPDATE SET is_active = true, left_at = NULL
                                        "#,
                                        room_uuid,
                                        user_uuid,
                                        timestamp as i64
                                    )
                                    .execute(&db)
                                    .await
                                    {
                                        error!("Failed to track JOIN participant: {}", e);
                                    } else {
                                        // Query session dimensions and participants
                                        match sqlx::query!(
                                            r#"
                                            SELECT cs.width, cs.height, array_agg(csp.user_id ORDER BY csp.joined_at ASC) as user_ids
                                            FROM collaborative_sessions cs
                                            LEFT JOIN collaborative_sessions_participants csp ON cs.id = csp.session_id 
                                            WHERE cs.id = $1 AND (csp.is_active = true OR csp.is_active IS NULL)
                                            GROUP BY cs.id, cs.width, cs.height
                                            "#,
                                            room_uuid
                                        )
                                        .fetch_one(&db)
                                        .await
                                        {
                                            Ok(session_data) => {
                                                let width = session_data.width as u16;
                                                let height = session_data.height as u16;
                                                let user_ids = session_data.user_ids.unwrap_or_default();
                                                let user_count = user_ids.len() as u16;
                                                
                                                // Create JOIN_RESPONSE message: [0x06][width:2][height:2][count:2][UUIDs...]
                                                let mut response_data = vec![0x06u8]; // JOIN_RESPONSE (0x06)
                                                
                                                // Write dimensions (little-endian u16)
                                                response_data.push((width & 0xff) as u8);
                                                response_data.push(((width >> 8) & 0xff) as u8);
                                                response_data.push((height & 0xff) as u8);
                                                response_data.push(((height >> 8) & 0xff) as u8);
                                                
                                                // Write user count (little-endian u16)
                                                response_data.push((user_count & 0xff) as u8);
                                                response_data.push(((user_count >> 8) & 0xff) as u8);
                                                
                                                // Write each user UUID (16 bytes each)
                                                for user_id in user_ids {
                                                    let uuid_bytes = user_id.as_bytes();
                                                    response_data.extend_from_slice(uuid_bytes);
                                                }
                                                
                                                // Broadcast JOIN_RESPONSE to all participants in the room
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
                                                        "Broadcasted JOIN_RESPONSE with {}×{} canvas and {} users to {} connections in room {}",
                                                        width, height, user_count, room_connections.len(), room_uuid
                                                    );
                                                }
                                            }
                                            Err(e) => {
                                                error!("Failed to query participants for JOIN_RESPONSE: {}", e);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        0x02 => {
                            // SNAPSHOT message: [0x02][UUID:16][layer:1][pngLength:4][pngData:variable]
                            if data.len() >= 22 {
                                if let Ok(snapshot_user) = bytes_to_uuid(&data[1..17]) {
                                    let snapshot_layer = data[17]; // 0=foreground, 1=background

                                    debug!(
                                        "Processing snapshot from user {} for layer {} in room {}",
                                        snapshot_user, snapshot_layer, room_uuid
                                    );

                                    // Filter existing history
                                    let mut history = state
                                        .message_history
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
                                                if let Ok(stored_user) =
                                                    bytes_to_uuid(&stored_data[1..17])
                                                {
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
                                                                stored_layer != snapshot_layer
                                                            // Keep if different layer
                                                            } else {
                                                                true // Keep if malformed
                                                            }
                                                        }
                                                        _ => true, // Keep other client messages
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
                                    let msg_length =
                                        u16::from_le_bytes([data[25], data[26]]) as usize;

                                    if data.len() >= 27 + msg_length {
                                        if let Ok(chat_text) =
                                            std::str::from_utf8(&data[27..27 + msg_length])
                                        {
                                            debug!(
                                                "Chat message from user {} at {}: {}",
                                                chat_user, timestamp, chat_text
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        0x04 => {
                            // SAVE message: [0x04][UUID:16][pngLength:4][pngData:variable]
                            if is_owner && data.len() >= 21 {
                                if let Ok(save_user) = bytes_to_uuid(&data[1..17]) {
                                    if save_user == user_id {
                                        let png_length = u32::from_le_bytes([
                                            data[17], data[18], data[19], data[20]
                                        ]) as usize;
                                        
                                        if data.len() >= 21 + png_length {
                                            let png_data = &data[21..21 + png_length];
                                            
                                            info!(
                                                "Processing save request from owner {} in session {}",
                                                user_login_name, room_uuid
                                            );
                                            
                                            // Handle save in background to avoid blocking WebSocket
                                            let db_clone = db.clone();
                                            let room_uuid_clone = room_uuid;
                                            let user_id_clone = user_id;
                                            let png_data_clone = png_data.to_vec();
                                            let state_clone = state.clone();
                                            
                                            tokio::spawn(async move {
                                                if let Err(e) = handle_save_request(
                                                    db_clone,
                                                    room_uuid_clone,
                                                    user_id_clone,
                                                    png_data_clone,
                                                    state_clone,
                                                ).await {
                                                    error!("Failed to save collaborative drawing: {}", e);
                                                }
                                            });
                                        }
                                    }
                                }
                            } else if !is_owner {
                                warn!(
                                    "Non-owner {} attempted to save session {}",
                                    user_login_name, room_uuid
                                );
                            }
                        }
                        0x07 => {
                            // END_SESSION message: [0x07][UUID:16][postUrlLength:2][postUrl:variable]
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
                                                        room_connections.len(), room_uuid
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
                        _ => {
                            debug!(
                                "Unknown server message type: 0x{:02x} in room {}",
                                msg_type, room_uuid
                            );
                        }
                    }
                }
                // Client messages (>= 0x10) are just broadcast, no special handling needed
            }
        }

        // Store message in history (skip chat messages)
        let (history_count, history_bytes) = {
            let mut history = state
                .message_history
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

        let history_mb = history_bytes as f64 / 1_048_576.0;
        debug!(
            "Received message from connection {} in room {} (history: {} messages, {:.2} MB)",
            connection_id, room_uuid, history_count, history_mb
        );

        // Check if history exceeds threshold and request snapshot
        const MAX_HISTORY_MESSAGES: usize = 50000;
        const MAX_HISTORY_MB: f64 = 10.0;

        if history_count > MAX_HISTORY_MESSAGES || history_mb > MAX_HISTORY_MB {
            // Find longest-connected user (first in the room)
            if let Some(room) = state.collaboration_rooms.get(&room_uuid) {
                if let Some(first_connection) = room.iter().next() {
                    let (_, tx) = first_connection.pair();

                    // Create snapshot request message: [0x05][timestamp:8]
                    let mut request_buffer = vec![0x05u8];
                    let timestamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_millis() as u64;
                    request_buffer.extend_from_slice(&timestamp.to_le_bytes());

                    if tx.send(Message::Binary(request_buffer)).is_ok() {
                        debug!(
                            "Sent snapshot request to longest-connected user in room {}",
                            room_uuid
                        );
                    }
                }
            }
        }

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
                debug!(
                    "Removed failed connection {} from room {}",
                    failed_id, room_uuid
                );
            }
        }
    }

    // Clean up when connection closes
    info!(
        "Message receive loop ended for connection {} (user {}) leaving room {} - receiver returned None",
        connection_id, user_login_name, room_uuid
    );

    // Mark participant as inactive in database
    if let Err(e) = sqlx::query!(
        r#"
        UPDATE collaborative_sessions_participants 
        SET is_active = false, left_at = NOW()
        WHERE session_id = $1 AND user_id = $2
        "#,
        room_uuid,
        user_id
    )
    .execute(&db)
    .await
    {
        error!("Failed to update participant on disconnect: {}", e);
    }

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

// Handle save request from session owner
async fn handle_save_request(
    db: sqlx::Pool<sqlx::Postgres>,
    session_id: Uuid,
    owner_id: Uuid,
    png_data: Vec<u8>,
    state: AppState,
) -> Result<(Uuid, String), Box<dyn std::error::Error + Send + Sync>> {
    // Get session details and verify ownership
    let session = sqlx::query!(
        r#"
        SELECT cs.owner_id, cs.title, cs.width, cs.height, cs.community_id, u.login_name as owner_login_name 
        FROM collaborative_sessions cs
        JOIN users u ON cs.owner_id = u.id
        WHERE cs.id = $1 AND cs.is_active = true AND cs.owner_id = $2
        "#,
        session_id,
        owner_id
    )
    .fetch_optional(&db)
    .await?
    .ok_or("Session not found or not owned by user")?;

    // Get participant list for metadata
    let participants = sqlx::query!(
        r#"
        SELECT u.login_name, csp.contribution_count
        FROM collaborative_sessions_participants csp
        JOIN users u ON csp.user_id = u.id
        WHERE csp.session_id = $1
        ORDER BY csp.contribution_count DESC, csp.joined_at ASC
        "#,
        session_id
    )
    .fetch_all(&db)
    .await?;

    // Upload image to S3 (similar to existing draw handlers)
    let image_sha256 = sha256::digest(&png_data);
    
    // Use the same S3 upload logic from draw.rs
    let credentials = aws_sdk_s3::config::Credentials::new(
        state.config.aws_access_key_id.clone(),
        state.config.aws_secret_access_key.clone(),
        None,
        None,
        "",
    );
    let credentials_provider = aws_sdk_s3::config::SharedCredentialsProvider::new(credentials);
    let s3_config = aws_sdk_s3::Config::builder()
        .endpoint_url(state.config.r2_endpoint_url.clone())
        .region(aws_sdk_s3::config::Region::new(state.config.aws_region.clone()))
        .credentials_provider(credentials_provider)
        .behavior_version_latest()
        .build();
    let s3_client = aws_sdk_s3::Client::from_conf(s3_config);

    // Upload to S3
    let s3_key = format!(
        "image/{}{}/{}.png",
        image_sha256.chars().nth(0).unwrap(),
        image_sha256.chars().nth(1).unwrap(),
        image_sha256
    );
    
    s3_client
        .put_object()
        .bucket(&state.config.aws_s3_bucket)
        .key(&s3_key)
        .checksum_sha256(&data_encoding::BASE64.encode(&hex::decode(&image_sha256)?))
        .body(aws_sdk_s3::primitives::ByteStream::from(png_data))
        .send()
        .await?;

    // Create description with participant info
    let participant_names: Vec<String> = participants
        .iter()
        .map(|p| format!("{} ({})", p.login_name, p.contribution_count.unwrap_or(0)))
        .collect();
    
    let _description = if participant_names.len() > 1 {
        format!(
            "Collaborative drawing with {} participants: {}",
            participant_names.len(),
            participant_names.join(", ")
        )
    } else {
        "Collaborative drawing".to_string()
    };

    // Use the community selected when creating the session
    let community_id = session.community_id;

    // Create image record first
    let image_id = Uuid::new_v4();
    let mut tx = db.begin().await?;
    
    sqlx::query!(
        r#"
        INSERT INTO images (id, width, height, paint_duration, stroke_count, image_filename, replay_filename, tool)
        VALUES ($1, $2, $3, INTERVAL '0 seconds', 0, $4, NULL, 'neo-cucumber'::tool)
        "#,
        image_id,
        session.width,
        session.height,
        format!("{}.png", image_sha256),
    )
    .execute(&mut *tx)
    .await?;

    // Create post
    let post_id = Uuid::new_v4();
    sqlx::query!(
        r#"
        INSERT INTO posts (id, author_id, community_id, image_id, is_sensitive, published_at)
        VALUES ($1, $2, $3, $4, false, NOW())
        "#,
        post_id,
        owner_id,
        community_id,
        image_id,
    )
    .execute(&mut *tx)
    .await?;

    // Update session with saved post reference and mark as ended
    sqlx::query!(
        "UPDATE collaborative_sessions SET saved_post_id = $1, ended_at = NOW() WHERE id = $2",
        post_id,
        session_id
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    info!(
        "Successfully saved collaborative drawing from session {} as post {}",
        session_id, post_id
    );

    Ok((post_id, session.owner_login_name))
}
