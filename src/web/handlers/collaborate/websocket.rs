use crate::app_error::AppError;
use crate::models::user::AuthSession;
use crate::web::state::AppState;
use axum::extract::{
    ws::close_code, ws::CloseFrame, ws::Message, ws::WebSocket, Path, State, WebSocketUpgrade,
};
use axum::response::Response;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use std::borrow::Cow;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use super::{db, messages, redis_messages, utils};

struct SessionContext<'a> {
    connection_id: &'a str,
    user_login_name: &'a str,
    user_id: Uuid,
    room_uuid: Uuid,
    is_owner: bool,
    owner_id: Uuid,
    db: &'a sqlx::Pool<sqlx::Postgres>,
    state: &'a AppState,
}

// Auto-reset threshold, in history messages: past this the server asks one
// client to upload a session reset that replaces the accumulated history
// (Drawpile's auto-reset). Keeps catch-up for late joiners fast.
const RESET_THRESHOLD_MESSAGES: usize = 500;

// How often a live connection refreshes its Redis registry entry. Comfortably
// inside the 30s entry TTL, so a slow beat never drops a live connection out
// of its room.
const HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);

// An in-progress session reset upload from this connection: `count` snapshot
// messages follow a RESET_BEGIN and replace all history up to `base_seq`.
struct PendingReset {
    base_seq: u64,
    remaining: u16,
    payloads: Vec<Vec<u8>>,
}

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

    // Counts this session as live until the handler returns, so a redeploy
    // waits for it to close cleanly instead of killing it mid-stroke.
    let _socket_guard = state.shutdown.track_socket();

    let connection_id = Uuid::new_v4().to_string();

    info!(
        "New websocket connection {} (user {}) joining room {}",
        connection_id, user_login_name, room_uuid
    );

    let db = &state.db_pool;

    let (is_owner, owner_id, session_user_id, connection_info) = match setup_connection(
        db,
        room_uuid,
        user_id,
        &user_login_name,
        &connection_id,
        &state,
    )
    .await
    {
        Ok(owner_info) => owner_info,
        Err(_) => {
            // The join was refused (session over, full, or out of session user
            // ids). Say so with a policy close rather than just dropping the
            // socket, so the client knows not to keep retrying.
            let _ = sender
                .send(Message::Close(Some(CloseFrame {
                    code: close_code::POLICY,
                    reason: Cow::from("cannot join session"),
                })))
                .await;
            return;
        }
    };

    // Tell the client its 1-byte session user id before any history arrives;
    // all its drawing messages will carry this id instead of a UUID
    let welcome = Message::Binary(vec![
        messages::MessageType::Welcome as u8,
        session_user_id,
    ]);
    if sender.send(welcome).await.is_err() {
        error!(
            "Failed to send welcome to connection {} in room {}",
            connection_id, room_uuid
        );
        return;
    }

    // Subscribe to the room channel BEFORE replaying history so no message can
    // fall into the gap between history replay and the live stream. Messages
    // covered by both are deduplicated below via their sequence numbers.
    let mut pubsub = match state
        .redis_state
        .create_room_subscriber(room_uuid, &state.config.redis_url)
        .await
    {
        Ok(pubsub) => pubsub,
        Err(e) => {
            error!(
                "Failed to create Redis subscriber for connection {}: {}",
                connection_id, e
            );
            return;
        }
    };

    let (redis_tx, mut redis_rx) = mpsc::unbounded_channel::<(Option<u64>, Vec<u8>)>();

    let connection_id_clone = connection_id.clone();
    let redis_task = tokio::spawn(async move {
        loop {
            match pubsub.on_message().next().await {
                Some(msg) => {
                    let payload: String = msg.get_payload().unwrap_or_default();
                    match serde_json::from_str::<super::redis_state::RoomMessage>(&payload) {
                        Ok(room_msg) => {
                            if should_forward_to_connection(&room_msg, &connection_id_clone) {
                                if redis_tx.send((room_msg.seq, room_msg.payload)).is_err() {
                                    debug!(
                                        "Redis message channel closed for connection {}",
                                        connection_id_clone
                                    );
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
                    debug!(
                        "Redis Pub/Sub stream ended for connection {}",
                        connection_id_clone
                    );
                    break;
                }
            }
        }
    });

    // Keep this connection visible in the room registry for as long as the
    // socket is open. Without it the entry lapses after CONNECTION_TTL and the
    // room looks empty to auto-reset and to the cleanup task while people are
    // still drawing. Spawned past the early returns above so no failure path
    // leaves it running.
    let heartbeat_task = tokio::spawn(heartbeat_loop(state.clone(), connection_info));

    // Send history to new connection, remembering the highest sequence number
    // it contained so the live stream can skip messages history already covered
    let max_history_seq =
        send_history_to_new_connection(&state, room_uuid, &mut sender, &connection_id).await;

    info!(
        "User {} joined session {} as {}",
        user_login_name,
        room_uuid,
        if is_owner { "owner" } else { "participant" }
    );

    // Handle outgoing messages (from Redis) in a separate task
    let outgoing_shutdown = state.shutdown.clone();
    let outgoing_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                // A redeploy: say goodbye properly. A close frame lets the
                // client start reconnecting to the new process right away
                // instead of inferring the loss from a severed socket.
                _ = outgoing_shutdown.signalled() => {
                    let _ = sender
                        .send(Message::Close(Some(CloseFrame {
                            code: close_code::AWAY,
                            reason: Cow::from("server restarting"),
                        })))
                        .await;
                    break;
                }
                next = redis_rx.recv() => {
                    let Some((seq, payload)) = next else {
                        break;
                    };
                    let msg = match seq {
                        // Skip sequenced messages already delivered via history replay
                        Some(s) if s <= max_history_seq => continue,
                        Some(s) => Message::Binary(wrap_sequenced(s, &payload)),
                        None => Message::Binary(payload),
                    };
                    if sender.send(msg).await.is_err() {
                        debug!("WebSocket send failed");
                        break;
                    }
                }
            }
        }
    });

    handle_incoming_messages(
        &mut receiver,
        SessionContext {
            connection_id: &connection_id,
            user_login_name: &user_login_name,
            user_id,
            room_uuid,
            is_owner,
            owner_id,
            db,
            state: &state,
        },
    )
    .await;

    // Stop the heartbeat before cleaning up, or a beat landing between the
    // unregister and the abort would helpfully re-register this connection.
    heartbeat_task.abort();

    cleanup_connection(
        &connection_id,
        &user_login_name,
        user_id,
        room_uuid,
        db,
        &state,
    )
    .await;

    redis_task.abort();
    outgoing_task.abort();
}

/// Refreshes this connection's Redis registry entry until the socket closes.
async fn heartbeat_loop(state: AppState, mut info: super::redis_state::ConnectionInfo) {
    let mut ticker = tokio::time::interval(HEARTBEAT_INTERVAL);
    // The first tick completes immediately; the entry was just written.
    ticker.tick().await;

    loop {
        ticker.tick().await;

        match state
            .redis_state
            .heartbeat_connection(&info.connection_id)
            .await
        {
            Ok(true) => {}
            Ok(false) => {
                // The entry lapsed anyway (a Redis restart, or a beat that
                // could not be delivered in time). Re-register rather than
                // keep beating against a key that is no longer there.
                info.last_heartbeat = now_secs();
                match state.redis_state.register_connection(&info).await {
                    Ok(()) => warn!(
                        "Re-registered lapsed connection {} in room {}",
                        info.connection_id, info.room_id
                    ),
                    Err(e) => error!(
                        "Failed to re-register connection {}: {}",
                        info.connection_id, e
                    ),
                }
            }
            Err(e) => error!(
                "Heartbeat failed for connection {}: {}",
                info.connection_id, e
            ),
        }
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("System time is before UNIX_EPOCH")
        .as_secs()
}

async fn setup_connection(
    db: &sqlx::Pool<sqlx::Postgres>,
    room_uuid: Uuid,
    user_id: Uuid,
    user_login_name: &str,
    connection_id: &str,
    state: &AppState,
) -> Result<(bool, Uuid, u8, super::redis_state::ConnectionInfo), ()> {
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
        session_info.max_participants,
    )
    .await
    {
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
    let connection_info =
        setup_connection_atomically(state, room_uuid, user_id, connection_id, user_login_name)
            .await;

    let session_user_id = match state.redis_state.assign_user_id(room_uuid, user_id).await {
        Ok(Some(id)) => id,
        Ok(None) => {
            error!(
                "No session user id available for user {} in room {}",
                user_login_name, room_uuid
            );
            return Err(());
        }
        Err(e) => {
            error!("Failed to assign session user id: {}", e);
            return Err(());
        }
    };

    Ok((
        session_info.owner_id == user_id,
        session_info.owner_id,
        session_user_id,
        connection_info,
    ))
}

async fn setup_connection_atomically(
    state: &AppState,
    room_uuid: Uuid,
    user_id: Uuid,
    connection_id: &str,
    user_login_name: &str,
) -> super::redis_state::ConnectionInfo {
    // With pure Redis Pub/Sub, we don't need local room tracking
    // Each connection is independent with its own Redis subscriber

    info!(
        "Setting up Redis Pub/Sub connection for user {} in room {}",
        user_login_name, room_uuid
    );

    // Register connection in Redis
    let connection_info = super::redis_state::ConnectionInfo {
        connection_id: connection_id.to_string(),
        user_id,
        room_id: room_uuid,
        user_login_name: user_login_name.to_string(),
        server_instance: state.redis_state.get_server_instance_id().to_string(),
        connected_at: now_secs(),
        last_heartbeat: now_secs(),
    };

    if let Err(e) = state
        .redis_state
        .register_connection(&connection_info)
        .await
    {
        error!("Failed to register connection in Redis: {}", e);
    }

    // Note: Previously added user to Redis room presence, but now using database
    // for canonical participant ordering via collaborative_sessions_participants table

    info!(
        "Completed Redis Pub/Sub setup for connection {} in room {}",
        connection_id, room_uuid
    );

    connection_info
}

// Wraps a history message in the [0x0A][seq: 8 bytes LE][payload] envelope so
// clients can track their position in the canonical history.
fn wrap_sequenced(seq: u64, payload: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(9 + payload.len());
    buf.push(messages::MessageType::Sequenced as u8);
    buf.extend_from_slice(&seq.to_le_bytes());
    buf.extend_from_slice(payload);
    buf
}

fn should_forward_to_connection(
    room_msg: &super::redis_state::RoomMessage,
    connection_id: &str,
) -> bool {
    // Targeted messages (e.g. RESET_REQUEST) go to exactly one connection
    if let Some(target) = &room_msg.target_connection {
        return target == connection_id;
    }
    if room_msg.from_connection != connection_id {
        return true;
    }
    // Echo every stored client drawing message back to its sender in canonical
    // server order so the client can confirm its optimistic fork. Keeping an
    // explicit list here lost newer operations (LINE was the first visible
    // casualty) whenever the protocol grew. POINTER_UP is the sole ephemeral
    // client message and must not enter reconciliation. Snapshot is a stored
    // server-range message; chat is echoed as delivery confirmation.
    match room_msg.payload.first().copied() {
        Some(0x02) | Some(0x03) => true,
        Some(msg_type) if messages::is_client_message(msg_type) => msg_type != 0x13,
        _ => false,
    }
}

#[cfg(test)]
mod forwarding_tests {
    use super::should_forward_to_connection;
    use crate::web::handlers::collaborate::redis_state::RoomMessage;
    use uuid::Uuid;

    fn message(from: &str, msg_type: u8) -> RoomMessage {
        RoomMessage {
            from_connection: from.to_string(),
            user_id: Uuid::nil(),
            user_login_name: "tester".to_string(),
            message_type: "websocket".to_string(),
            payload: vec![msg_type],
            timestamp: 0,
            seq: Some(1),
            target_connection: None,
        }
    }

    #[test]
    fn echoes_every_drawing_operation_to_its_sender() {
        for msg_type in [
            0x02, // snapshot
            0x12, // fill
            0x14, // undo point
            0x15, // undo
            0x16, // freehand stroke
            0x17, // region
            0x18, // line
            0x19, // bezier
            0x1a, // erase all
            0x1b, // text
        ] {
            assert!(
                should_forward_to_connection(&message("same", msg_type), "same"),
                "message 0x{msg_type:02x} was not echoed"
            );
        }
    }

    #[test]
    fn does_not_echo_ephemeral_pointer_updates_to_the_sender() {
        assert!(!should_forward_to_connection(
            &message("same", 0x13),
            "same"
        ));
    }

    #[test]
    fn forwards_messages_from_other_connections() {
        assert!(should_forward_to_connection(
            &message("other", 0x13),
            "same"
        ));
    }
}

// Returns the highest sequence number contained in the replayed history,
// or 0 if the history is empty or could not be retrieved.
async fn send_history_to_new_connection(
    state: &AppState,
    room_uuid: Uuid,
    sender: &mut SplitSink<WebSocket, Message>,
    connection_id: &str,
) -> u64 {
    let redis_store = redis_messages::RedisMessageStore::new(state.redis_pool.clone());

    let mut max_seq = 0;
    match redis_store.get_history_with_seqs(room_uuid).await {
        Ok(history) => {
            for (seq, stored_msg) in history.iter() {
                let payload = match stored_msg {
                    Message::Binary(data) => data.as_slice(),
                    _ => continue,
                };
                let wrapped = Message::Binary(wrap_sequenced(*seq, payload));
                if sender.send(wrapped).await.is_err() {
                    warn!(
                        "Failed to send stored message to new connection {}",
                        connection_id
                    );
                    break;
                }
                max_seq = max_seq.max(*seq);
            }
            debug!(
                "Sent {} stored messages from Redis to new connection {} (max seq {})",
                history.len(),
                connection_id,
                max_seq
            );
        }
        Err(e) => {
            error!(
                "Failed to retrieve message history from Redis for connection {}: {}",
                connection_id, e
            );
        }
    }
    max_seq
}

async fn handle_incoming_messages(
    receiver: &mut futures_util::stream::SplitStream<WebSocket>,
    ctx: SessionContext<'_>,
) {
    let mut pending_reset: Option<PendingReset> = None;

    loop {
        let msg = tokio::select! {
            biased;
            // Stop reading on a redeploy so the caller's cleanup runs: without
            // it the task is dropped where it stands and nobody in the room
            // ever hears that this user left.
            _ = ctx.state.shutdown.signalled() => {
                info!(
                    "Server shutting down, closing connection {} in room {}",
                    ctx.connection_id, ctx.room_uuid
                );
                break;
            }
            msg = receiver.next() => match msg {
                Some(msg) => msg,
                None => break,
            },
        };

        let mut msg = match msg {
            Ok(msg) => msg,
            Err(e) => {
                error!(
                    "Websocket error for connection {}: {}",
                    ctx.connection_id, e
                );
                break;
            }
        };

        if !matches!(msg, Message::Binary(_)) {
            continue;
        }

        if let Message::Binary(data) = &msg {
            // Session reset upload: RESET_BEGIN announces the snapshots, then
            // the snapshots are captured here — they replace history instead
            // of being sequenced or broadcast (live clients already have this
            // state; only late joiners replay the reset)
            if let Some(reset) = pending_reset.as_mut() {
                if data.first() == Some(&(messages::MessageType::Snapshot as u8)) {
                    reset.payloads.push(data.clone());
                    reset.remaining -= 1;
                    if reset.remaining == 0 {
                        let reset = pending_reset.take().expect("pending reset exists");
                        finish_reset(&ctx, reset).await;
                    }
                    continue;
                }
            }
            if data.first() == Some(&(messages::MessageType::ResetBegin as u8)) {
                pending_reset = parse_reset_begin(data, &ctx);
                continue;
            }

            if !data.is_empty() {
                let msg_type = data[0];

                if msg_type < 0x10 {
                    msg = match process_server_message(msg_type, data, &msg, &ctx).await {
                        Some(processed_msg) => processed_msg,
                        None => continue,
                    };
                }
            }
        }

        if messages::should_store_message(&msg) {
            // History messages go through the atomic sequencer, which stores
            // and broadcasts them in one step so every client observes the
            // same canonical order (Drawpile-style server-side serialization)
            if let Err(e) =
                messages::sequence_and_broadcast(&msg, ctx.room_uuid, ctx.connection_id, ctx.state)
                    .await
            {
                error!(
                    "Failed to sequence message for room {}: {}",
                    ctx.room_uuid, e
                );
                continue;
            }

            if let Err(e) = ctx.state.redis_state.update_room_activity(ctx.room_uuid).await {
                error!("Failed to update room activity in Redis: {}", e);
            }

            maybe_request_reset(&ctx).await;
        } else {
            // Ephemeral messages (chat, join, leave) bypass the sequencer
            messages::broadcast_message(&msg, ctx.room_uuid, ctx.connection_id, ctx.state).await;
        }
    }

    // If this connection was mid-reset, release the flag so another client
    // can be asked without waiting for the TTL
    if pending_reset.is_some() {
        if let Err(e) = ctx.state.redis_state.clear_reset_pending(ctx.room_uuid).await {
            error!(
                "Failed to clear reset-pending flag for room {}: {}",
                ctx.room_uuid, e
            );
        }
    }
}

fn parse_reset_begin(data: &[u8], ctx: &SessionContext<'_>) -> Option<PendingReset> {
    if data.len() < 11 {
        warn!(
            "Malformed RESET_BEGIN from connection {} in room {}",
            ctx.connection_id, ctx.room_uuid
        );
        return None;
    }
    let base_seq = utils::read_u64_le(data, 1);
    let count = u16::from_le_bytes([data[9], data[10]]);
    // 2 layers per participant; anything larger than this is malformed
    if count == 0 || count > 64 {
        warn!(
            "Rejecting RESET_BEGIN with snapshot count {} from connection {} in room {}",
            count, ctx.connection_id, ctx.room_uuid
        );
        return None;
    }
    info!(
        "Session reset upload started for room {} at seq {} ({} snapshots)",
        ctx.room_uuid, base_seq, count
    );
    Some(PendingReset {
        base_seq,
        remaining: count,
        payloads: Vec::with_capacity(count as usize),
    })
}

async fn finish_reset(ctx: &SessionContext<'_>, reset: PendingReset) {
    let redis_store = redis_messages::RedisMessageStore::new(ctx.state.redis_pool.clone());
    match redis_store
        .apply_reset(ctx.room_uuid, reset.base_seq, &reset.payloads)
        .await
    {
        Ok(()) => {
            info!(
                "Session reset applied for room {} at seq {} ({} snapshots)",
                ctx.room_uuid,
                reset.base_seq,
                reset.payloads.len()
            );

            // Tell all clients (and future late joiners, via history) that
            // everything at or below base_seq is squashed into the reset
            // snapshots, so they can freeze undo state and reclaim memory
            let mut reset_point = vec![messages::MessageType::ResetPoint as u8];
            reset_point.extend_from_slice(&reset.base_seq.to_le_bytes());
            if let Err(e) = messages::sequence_and_broadcast(
                &Message::Binary(reset_point),
                ctx.room_uuid,
                "system",
                ctx.state,
            )
            .await
            {
                error!(
                    "Failed to broadcast reset point for room {}: {}",
                    ctx.room_uuid, e
                );
            }
        }
        Err(e) => {
            error!(
                "Failed to apply session reset for room {}: {}",
                ctx.room_uuid, e
            );
        }
    }

    if let Err(e) = ctx.state.redis_state.clear_reset_pending(ctx.room_uuid).await {
        error!(
            "Failed to clear reset-pending flag for room {}: {}",
            ctx.room_uuid, e
        );
    }
}

async fn maybe_request_reset(ctx: &SessionContext<'_>) {
    let redis_store = redis_messages::RedisMessageStore::new(ctx.state.redis_pool.clone());
    let history_len = match redis_store.history_len(ctx.room_uuid).await {
        Ok(len) => len,
        Err(e) => {
            error!(
                "Failed to get history length for room {}: {}",
                ctx.room_uuid, e
            );
            return;
        }
    };
    if history_len < RESET_THRESHOLD_MESSAGES {
        return;
    }

    match ctx
        .state
        .redis_state
        .try_acquire_reset_pending(ctx.room_uuid)
        .await
    {
        Ok(true) => {}
        Ok(false) => return, // a reset is already in flight
        Err(e) => {
            error!(
                "Failed to acquire reset-pending flag for room {}: {}",
                ctx.room_uuid, e
            );
            return;
        }
    }

    // Choose the reset client: prefer the session owner's connection, falling
    // back to the earliest-connected one (Drawpile prefers operators)
    let connections = ctx
        .state
        .redis_state
        .get_room_connections(ctx.room_uuid)
        .await
        .unwrap_or_default();
    let mut target: Option<String> = None;
    let mut earliest: Option<(u64, String)> = None;
    for conn_id in connections {
        if let Ok(Some(info)) = ctx.state.redis_state.get_connection_info(&conn_id).await {
            if info.user_id == ctx.owner_id {
                target = Some(conn_id);
                break;
            }
            if earliest
                .as_ref()
                .map_or(true, |(t, _)| info.connected_at < *t)
            {
                earliest = Some((info.connected_at, conn_id));
            }
        }
    }
    let target = target.or_else(|| earliest.map(|(_, conn_id)| conn_id));

    match target {
        Some(conn_id) => {
            info!(
                "History for room {} reached {} messages - requesting session reset",
                ctx.room_uuid, history_len
            );
            messages::send_reset_request(ctx.room_uuid, &conn_id, ctx.state).await;
        }
        None => {
            // No live connection can serve the reset; release the flag
            if let Err(e) = ctx.state.redis_state.clear_reset_pending(ctx.room_uuid).await {
                error!(
                    "Failed to clear reset-pending flag for room {}: {}",
                    ctx.room_uuid, e
                );
            }
        }
    }
}

async fn process_server_message(
    msg_type: u8,
    data: &[u8],
    msg: &Message,
    ctx: &SessionContext<'_>,
) -> Option<Message> {
    match msg_type {
        0x01 => {
            // For JOIN messages with Redis Pub/Sub architecture:
            // 1. Process the join (sends JOIN_RESPONSE via Redis to all participants)
            // 2. Return the original message to be broadcast (but not stored - JOIN messages are ephemeral)
            // 3. Current participants are communicated via JOIN_RESPONSE, not history replay

            messages::handle_join_message(
                data,
                ctx.user_id,
                ctx.user_login_name,
                ctx.room_uuid,
                ctx.db,
                ctx.state,
            )
            .await;

            // Return the JOIN message to be stored and broadcast via Redis
            Some(msg.clone())
        }
        0x02 => {
            // Snapshot (undo/redo sync): no server-side processing needed,
            // it is sequenced and broadcast like any other history message
            Some(msg.clone())
        }
        0x03 => messages::handle_chat_message(data, ctx.user_id, ctx.user_login_name),
        0x07 => {
            messages::handle_end_session_message(
                data,
                messages::EndSessionContext {
                    user_id: ctx.user_id,
                    user_login_name: ctx.user_login_name,
                    room_uuid: ctx.room_uuid,
                    is_owner: ctx.is_owner,
                    db: ctx.db,
                    state: ctx.state,
                    msg,
                    connection_id: ctx.connection_id,
                },
            )
            .await;

            // Message is already broadcast internally, don't re-broadcast
            None
        }
        _ => {
            debug!(
                "Unknown server message type: 0x{:02x} in room {}",
                msg_type, ctx.room_uuid
            );
            Some(msg.clone())
        }
    }
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
        error!(
            "Failed to unregister connection {} from Redis: {}",
            connection_id, e
        );
    }

    // On a redeploy the room is emptying because the server is going away, not
    // because everyone left: these same people are already reconnecting. Leave
    // the room's Redis state exactly as it is for them to come back to.
    if state.shutdown.is_signalled() {
        debug!(
            "Shutting down - leaving room {} state intact for reconnecting clients",
            room_uuid
        );
        return;
    }

    // Check if user has any other connections in this room
    let room_connections = state
        .redis_state
        .get_room_connections(room_uuid)
        .await
        .unwrap_or_default();
    let _user_has_other_connections = {
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

    // Note: Previously removed user from Redis room presence, but now using database
    // for canonical participant ordering. User remains in collaborative_sessions_participants
    // until they explicitly leave or session ends.

    let room_connection_count = room_connections.len();

    // Only consider removing room if no connections remain
    if room_connection_count == 0 {
        // Double-check with database to see if there are still active participants
        // This prevents removing the room if participants are reconnecting
        match db::get_active_user_count(db, room_uuid).await {
            Ok(active_count) => {
                if active_count == 0 {
                    // Safe to remove room since no active participants in database
                    info!(
                        "Removing room {} - no active participants remaining",
                        room_uuid
                    );
                    // Room cleanup is now handled entirely by Redis state

                    // NOTE: We do NOT clean up Redis message history here!
                    // Redis history should persist even when no one is connected,
                    // so users can rejoin and see the previous drawing history.
                    // Redis cleanup only happens when:
                    // 1. Session is explicitly ended (END_SESSION)
                    // 2. Session is inactive for extended period (cleanup task)
                    // 3. Messages expire via TTL

                    // Clean up room presence and activity
                    if let Err(e) = state.redis_state.cleanup_room_state(room_uuid).await {
                        error!("Failed to cleanup room state for room {}: {}", room_uuid, e);
                    }
                } else {
                    debug!(
                        "Keeping room {} - {} active participants remain in database",
                        room_uuid, active_count
                    );
                }
            }
            Err(e) => {
                error!(
                    "Failed to check active participants for room cleanup: {}",
                    e
                );
                // On database error, err on the side of caution and keep the room
                debug!(
                    "Keeping room {} due to database error during cleanup check",
                    room_uuid
                );
            }
        }
    } else {
        debug!(
            "Room {} has {} connections remaining",
            room_uuid, room_connection_count
        );
    }
}
