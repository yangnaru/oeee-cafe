use crate::web::state::AppState;
use axum::extract::ws::Message;
use std::time::{Duration, Instant};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

const CLEANUP_INTERVAL_MINUTES: u64 = 5;
const INACTIVE_THRESHOLD_MINUTES: u64 = 30;

pub async fn cleanup_collaborative_sessions(state: AppState) {
    let cleanup_interval = Duration::from_secs(CLEANUP_INTERVAL_MINUTES * 60);
    let inactive_threshold = Duration::from_secs(INACTIVE_THRESHOLD_MINUTES * 60);

    info!(
        "Starting collaborative session cleanup task (interval: {}min, threshold: {}min)",
        CLEANUP_INTERVAL_MINUTES, INACTIVE_THRESHOLD_MINUTES
    );

    loop {
        tokio::time::sleep(cleanup_interval).await;

        let start_time = Instant::now();
        let mut sessions_synced = 0;
        let mut ended_sessions_cleaned = 0;
        let mut inactive_sessions_cleaned = 0;

        let db = match state.config.connect_database().await {
            Ok(db) => db,
            Err(e) => {
                error!("Failed to connect to database for cleanup: {}", e);
                continue;
            }
        };

        // Step 1: Sync in-memory activity cache to database (batch update)
        if let Err(e) = sync_activity_to_database(&state, &db, &mut sessions_synced).await {
            error!("Failed to sync activity to database: {}", e);
        }

        // Step 2: Clean up ended sessions (those with ended_at set)
        if let Err(e) = cleanup_ended_sessions(&state, &db, &mut ended_sessions_cleaned).await {
            error!("Failed to clean up ended sessions: {}", e);
        }

        // Step 3: Clean up inactive sessions (no activity for threshold duration)
        if let Err(e) = cleanup_inactive_sessions(
            &state,
            &db,
            inactive_threshold,
            &mut inactive_sessions_cleaned,
        )
        .await
        {
            error!("Failed to clean up inactive sessions: {}", e);
        }

        let elapsed = start_time.elapsed();
        debug!(
            "Cleanup cycle completed in {:?}: {} sessions synced, {} ended sessions cleaned, {} inactive sessions cleaned",
            elapsed, sessions_synced, ended_sessions_cleaned, inactive_sessions_cleaned
        );
    }
}

async fn sync_activity_to_database(
    state: &AppState,
    db: &sqlx::Pool<sqlx::Postgres>,
    sessions_synced: &mut i32,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Get all entries from the activity cache
    let activity_updates: Vec<(Uuid, chrono::NaiveDateTime)> = state
        .last_activity_cache
        .iter()
        .map(|entry| {
            let session_id = *entry.key();
            let last_activity = *entry.value();

            // Convert Instant to NaiveDateTime
            // This is approximate - we use current time minus the elapsed time since the Instant
            let now = std::time::SystemTime::now();
            let elapsed = last_activity.elapsed();
            let activity_timestamp = now - elapsed;
            let timestamp = chrono::DateTime::from_timestamp(
                activity_timestamp
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs() as i64,
                0,
            )
            .unwrap_or_else(|| chrono::Utc::now())
            .naive_utc();

            (session_id, timestamp)
        })
        .collect();

    if activity_updates.is_empty() {
        return Ok(());
    }

    // Batch update all sessions with their last activity
    let mut tx = db.begin().await?;
    for (session_id, last_activity) in activity_updates {
        if let Err(e) = sqlx::query!(
            "UPDATE collaborative_sessions SET last_activity = $1 WHERE id = $2 AND ended_at IS NULL",
            last_activity,
            session_id
        )
        .execute(&mut *tx)
        .await
        {
            warn!("Failed to update last_activity for session {}: {}", session_id, e);
        } else {
            *sessions_synced += 1;
        }
    }
    tx.commit().await?;

    debug!("Synced {} session activities to database", sessions_synced);
    Ok(())
}

async fn cleanup_ended_sessions(
    state: &AppState,
    db: &sqlx::Pool<sqlx::Postgres>,
    ended_sessions_cleaned: &mut i32,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Find all sessions that have been ended (ended_at is not null)
    let ended_sessions =
        sqlx::query!("SELECT id FROM collaborative_sessions WHERE ended_at IS NOT NULL")
            .fetch_all(db)
            .await?;

    for session in ended_sessions {
        let session_id = session.id;

        // If there are still active connections to ended sessions, disconnect them
        if let Some(room) = state.collaboration_rooms.get(&session_id) {
            if !room.is_empty() {
                info!(
                    "Ended session {} still has {} connections - sending SESSION_EXPIRED",
                    session_id,
                    room.len()
                );

                // Create SESSION_EXPIRED message for ended session: [0x08][UUID:16]
                let mut session_expired_msg = vec![0x08u8]; // SESSION_EXPIRED
                session_expired_msg.extend_from_slice(session_id.as_bytes()); // 16 bytes

                // Broadcast to all connections
                for conn_ref in room.iter() {
                    let sender = conn_ref.value();
                    let _ = sender.send(Message::Binary(session_expired_msg.clone()));
                }

                // Give connections a moment to disconnect
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }

        // Remove from in-memory structures
        let mut removed_items = Vec::new();

        if state.collaboration_rooms.remove(&session_id).is_some() {
            removed_items.push("collaboration_room");
        }

        if state.message_history.remove(&session_id).is_some() {
            removed_items.push("message_history");
        }

        if state.last_activity_cache.remove(&session_id).is_some() {
            removed_items.push("activity_cache");
        }

        if !removed_items.is_empty() {
            debug!(
                "Cleaned up ended session {}: removed {}",
                session_id,
                removed_items.join(", ")
            );
            *ended_sessions_cleaned += 1;
        }
    }

    if *ended_sessions_cleaned > 0 {
        info!(
            "Cleaned up {} ended sessions from memory",
            ended_sessions_cleaned
        );
    }

    Ok(())
}

async fn cleanup_inactive_sessions(
    state: &AppState,
    db: &sqlx::Pool<sqlx::Postgres>,
    inactive_threshold: Duration,
    inactive_sessions_cleaned: &mut i32,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Find sessions that have been inactive for more than the threshold
    let inactive_cutoff =
        chrono::Utc::now().naive_utc() - chrono::Duration::from_std(inactive_threshold).unwrap();

    let inactive_sessions = sqlx::query!(
        r#"
        SELECT id FROM collaborative_sessions 
        WHERE ended_at IS NULL 
        AND last_activity < $1
        "#,
        inactive_cutoff
    )
    .fetch_all(db)
    .await?;

    if inactive_sessions.is_empty() {
        return Ok(());
    }

    let mut tx = db.begin().await?;

    for session in inactive_sessions {
        let session_id = session.id;

        // If there are active connections, send SESSION_EXPIRED message before cleanup
        if let Some(room) = state.collaboration_rooms.get(&session_id) {
            if !room.is_empty() {
                info!(
                    "Session {} has been inactive for >{}min but still has {} connections - sending SESSION_EXPIRED",
                    session_id, INACTIVE_THRESHOLD_MINUTES, room.len()
                );

                // Create SESSION_EXPIRED message: [0x08][UUID:16]
                let mut session_expired_msg = vec![0x08u8]; // SESSION_EXPIRED
                session_expired_msg.extend_from_slice(session_id.as_bytes()); // 16 bytes

                // Broadcast to all connections
                let mut disconnected_connections = 0;
                for conn_ref in room.iter() {
                    let conn_id = conn_ref.key();
                    let sender = conn_ref.value();
                    if sender
                        .send(Message::Binary(session_expired_msg.clone()))
                        .is_err()
                    {
                        debug!("Failed to send SESSION_EXPIRED to connection {}", conn_id);
                    } else {
                        disconnected_connections += 1;
                    }
                }

                info!(
                    "Sent SESSION_EXPIRED to {} connections in session {}",
                    disconnected_connections, session_id
                );

                // Give connections a moment to process the message and disconnect
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }

        // Mark session as ended in database
        if let Err(e) = sqlx::query!(
            "UPDATE collaborative_sessions SET ended_at = NOW() WHERE id = $1",
            session_id
        )
        .execute(&mut *tx)
        .await
        {
            error!("Failed to mark session {} as ended: {}", session_id, e);
            continue;
        }

        // Mark all participants as inactive
        if let Err(e) = sqlx::query!(
            r#"
            UPDATE collaborative_sessions_participants 
            SET is_active = false, left_at = NOW()
            WHERE session_id = $1 AND is_active = true
            "#,
            session_id
        )
        .execute(&mut *tx)
        .await
        {
            warn!(
                "Failed to mark participants as inactive for session {}: {}",
                session_id, e
            );
        }

        // Remove from in-memory structures
        let mut removed_items = Vec::new();

        if state.collaboration_rooms.remove(&session_id).is_some() {
            removed_items.push("collaboration_room");
        }

        if state.message_history.remove(&session_id).is_some() {
            removed_items.push("message_history");
        }

        if state.last_activity_cache.remove(&session_id).is_some() {
            removed_items.push("activity_cache");
        }

        info!(
            "Cleaned up inactive session {} (inactive for >{}min): removed {} from database and memory",
            session_id,
            INACTIVE_THRESHOLD_MINUTES,
            removed_items.join(", ")
        );
        *inactive_sessions_cleaned += 1;
    }

    tx.commit().await?;

    if *inactive_sessions_cleaned > 0 {
        info!(
            "Cleaned up {} inactive sessions from database and memory",
            inactive_sessions_cleaned
        );
    }

    Ok(())
}
