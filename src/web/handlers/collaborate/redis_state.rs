use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{debug, error, info};
use uuid::Uuid;

use crate::redis::RedisPool;

// Redis key prefixes
const ACTIVITY_PREFIX: &str = "oeee:activity:";
const RESET_PENDING_PREFIX: &str = "oeee:reset_pending:";
const CONNECTION_PREFIX: &str = "oeee:connection:";
const ROOM_PREFIX: &str = "oeee:room:";
const PUBSUB_PREFIX: &str = "oeee:pubsub:";
pub(crate) const USER_ID_PREFIX: &str = "oeee:user_ids:";
const USER_ID_TTL: u64 = 3600; // matches (and is refreshed with) message history

// TTL constants
const ACTIVITY_TTL: u64 = 3600; // 1 hour
const RESET_PENDING_TTL: u64 = 120; // retry window if the reset client stalls
const CONNECTION_TTL: u64 = 30; // 30 seconds (with heartbeat)

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionInfo {
    pub connection_id: String,
    pub user_id: Uuid,
    pub room_id: Uuid,
    pub user_login_name: String,
    pub server_instance: String,
    pub connected_at: u64,
    pub last_heartbeat: u64,
}

/// What a subscriber needs off a room's Pub/Sub channel.
///
/// Everything else a publisher knows -- who they are, what they called the
/// message, when they sent it -- is never read on the other side, so it does
/// not go on the wire. What does goes as a text header and the payload's own
/// bytes:
///
/// ```text
/// 1|<from_connection>|<target_connection>|<seq>|<history_id>\n<payload>
/// ```
///
/// Redis strings are binary-safe, so the drawing payload rides untouched. The
/// JSON envelope this replaced base64'd it, which grew a twenty-byte stroke
/// past two hundred and made the sequencer's Lua decode and re-encode that
/// JSON, on Redis's single thread, once per pointer move.
///
/// The header's fields are UUIDs, decimal numbers, or the literal `system`,
/// none of which can contain the `|` and newline that delimit them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomBroadcast {
    pub from_connection: String,
    /// Set when the message goes to exactly one connection (e.g. RESET_REQUEST).
    pub target_connection: Option<String>,
    /// Canonical sequence number, for messages that are part of session
    /// history; None for ephemeral ones.
    pub seq: Option<u64>,
    /// Identity of the canonical history containing `seq`. Comparable
    /// positions must have the same identity.
    pub history_id: Option<Uuid>,
    pub payload: Vec<u8>,
}

/// Framing version. The sequencer's Lua writes this same header, so a change
/// here has to be made there too (see SEQUENCE_AND_PUBLISH_SCRIPT).
pub const BROADCAST_VERSION: &str = "1";

impl RoomBroadcast {
    pub fn encode(&self) -> Vec<u8> {
        let header = format!(
            "{}|{}|{}|{}|{}\n",
            BROADCAST_VERSION,
            self.from_connection,
            self.target_connection.as_deref().unwrap_or(""),
            self.seq.map(|seq| seq.to_string()).unwrap_or_default(),
            self.history_id.map(|id| id.to_string()).unwrap_or_default(),
        );
        let mut out = Vec::with_capacity(header.len() + self.payload.len());
        out.extend_from_slice(header.as_bytes());
        out.extend_from_slice(&self.payload);
        out
    }

    /// None for anything that is not this framing, so a stray publish is
    /// dropped rather than delivered as a corrupt drawing operation.
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        let split = bytes.iter().position(|&byte| byte == b'\n')?;
        let mut fields = std::str::from_utf8(&bytes[..split]).ok()?.split('|');
        if fields.next()? != BROADCAST_VERSION {
            return None;
        }
        let from_connection = fields.next()?.to_string();
        let target = fields.next()?;
        let seq = fields.next()?;
        let history_id = fields.next()?;
        Some(Self {
            from_connection,
            target_connection: (!target.is_empty()).then(|| target.to_string()),
            seq: if seq.is_empty() {
                None
            } else {
                Some(seq.parse().ok()?)
            },
            history_id: if history_id.is_empty() {
                None
            } else {
                Some(history_id.parse().ok()?)
            },
            payload: bytes[split + 1..].to_vec(),
        })
    }
}

#[derive(Clone)]
pub struct RedisStateManager {
    pool: RedisPool,
    server_instance_id: String,
}

impl RedisStateManager {
    pub fn new(pool: RedisPool) -> Self {
        let server_instance_id = format!("oeee-{}", Uuid::new_v4());
        Self {
            pool,
            server_instance_id,
        }
    }

    pub fn get_server_instance_id(&self) -> &str {
        &self.server_instance_id
    }

    // Activity Cache Management
    pub async fn update_room_activity(
        &self,
        room_uuid: Uuid,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", ACTIVITY_PREFIX, room_uuid);
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

        conn.set::<_, _, ()>(&key, timestamp).await?;
        conn.expire::<_, ()>(&key, ACTIVITY_TTL as i64).await?;
        debug!(
            "Updated activity cache for room {} at timestamp {}",
            room_uuid, timestamp
        );
        Ok(())
    }

    pub async fn get_room_activity(
        &self,
        room_uuid: Uuid,
    ) -> Result<Option<u64>, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", ACTIVITY_PREFIX, room_uuid);

        let timestamp = conn.get::<_, Option<u64>>(&key).await?;
        Ok(timestamp)
    }

    pub async fn cleanup_room_activity(
        &self,
        room_uuid: Uuid,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", ACTIVITY_PREFIX, room_uuid);

        let deleted: bool = conn.del(&key).await?;
        if deleted {
            debug!("Cleaned up activity cache for room {}", room_uuid);
        }
        Ok(())
    }

    // Session Reset Tracking
    //
    // At most one session reset is requested at a time per room; the flag
    // expires so a stalled or disconnected reset client only delays the next
    // attempt instead of blocking resets forever.
    pub async fn try_acquire_reset_pending(
        &self,
        room_uuid: Uuid,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", RESET_PENDING_PREFIX, room_uuid);

        let acquired: bool = redis::cmd("SET")
            .arg(&key)
            .arg(1u8)
            .arg("NX")
            .arg("EX")
            .arg(RESET_PENDING_TTL)
            .query_async::<Option<String>>(&mut *conn)
            .await?
            .is_some();

        if acquired {
            debug!("Acquired reset-pending flag for room {}", room_uuid);
        }
        Ok(acquired)
    }

    pub async fn clear_reset_pending(
        &self,
        room_uuid: Uuid,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", RESET_PENDING_PREFIX, room_uuid);
        conn.del::<_, ()>(&key).await?;
        Ok(())
    }

    pub async fn assign_reset_uploader(
        &self,
        room_uuid: Uuid,
        connection_id: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", RESET_PENDING_PREFIX, room_uuid);
        redis::cmd("SET")
            .arg(key)
            .arg(connection_id)
            .arg("XX")
            .arg("EX")
            .arg(RESET_PENDING_TTL)
            .query_async::<()>(&mut *conn)
            .await?;
        Ok(())
    }

    pub async fn is_reset_uploader(
        &self,
        room_uuid: Uuid,
        connection_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", RESET_PENDING_PREFIX, room_uuid);
        Ok(conn.get::<_, Option<String>>(key).await?.as_deref() == Some(connection_id))
    }

    // Connection Registry
    pub async fn register_connection(
        &self,
        connection_info: &ConnectionInfo,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", CONNECTION_PREFIX, connection_info.connection_id);

        let serialized = serde_json::to_string(connection_info)?;
        conn.set::<_, _, ()>(&key, &serialized).await?;
        conn.expire::<_, ()>(&key, CONNECTION_TTL as i64).await?;

        // Also track connection in room set
        let room_key = format!("{}{}:connections", ROOM_PREFIX, connection_info.room_id);
        conn.sadd::<_, _, ()>(&room_key, &connection_info.connection_id)
            .await?;
        conn.expire::<_, ()>(&room_key, CONNECTION_TTL as i64)
            .await?;

        debug!(
            "Registered connection {} for user {} in room {}",
            connection_info.connection_id, connection_info.user_id, connection_info.room_id
        );
        Ok(())
    }

    /// Refreshes a connection's registry entry and the TTL of the room set it
    /// belongs to. Both expire after `CONNECTION_TTL`, so without this running
    /// on a timer the registry empties out from under a session that is very
    /// much alive — and everything that reads it (auto-reset target selection,
    /// stale-connection cleanup, SESSION_EXPIRED delivery) sees an empty room.
    ///
    /// Returns false if the entry has already expired, which tells the caller
    /// to re-register rather than keep beating against a missing key.
    pub async fn heartbeat_connection(
        &self,
        connection_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", CONNECTION_PREFIX, connection_id);

        // Get existing connection info
        if let Some(info_str) = conn.get::<_, Option<String>>(&key).await? {
            let mut connection_info: ConnectionInfo = serde_json::from_str(&info_str)?;
            connection_info.last_heartbeat =
                SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

            let serialized = serde_json::to_string(&connection_info)?;
            conn.set::<_, _, ()>(&key, &serialized).await?;
            conn.expire::<_, ()>(&key, CONNECTION_TTL as i64).await?;

            // The room set carries its own TTL, set when a connection last
            // registered; refresh it too or the membership disappears while
            // the connections it lists are still alive.
            let room_key = format!("{}{}:connections", ROOM_PREFIX, connection_info.room_id);
            conn.sadd::<_, _, ()>(&room_key, connection_id).await?;
            conn.expire::<_, ()>(&room_key, CONNECTION_TTL as i64)
                .await?;

            debug!("Updated heartbeat for connection {}", connection_id);
            Ok(true)
        } else {
            debug!("Connection {} not found for heartbeat", connection_id);
            Ok(false)
        }
    }

    pub async fn get_connection_info(
        &self,
        connection_id: &str,
    ) -> Result<Option<ConnectionInfo>, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", CONNECTION_PREFIX, connection_id);

        if let Some(info_str) = conn.get::<_, Option<String>>(&key).await? {
            let connection_info: ConnectionInfo = serde_json::from_str(&info_str)?;
            Ok(Some(connection_info))
        } else {
            Ok(None)
        }
    }

    pub async fn unregister_connection(
        &self,
        connection_id: &str,
    ) -> Result<Option<ConnectionInfo>, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", CONNECTION_PREFIX, connection_id);

        // Get connection info before deletion
        let connection_info = if let Some(info_str) = conn.get::<_, Option<String>>(&key).await? {
            Some(serde_json::from_str::<ConnectionInfo>(&info_str)?)
        } else {
            None
        };

        // Remove from Redis
        conn.del::<_, ()>(&key).await?;

        // Remove from room set if we have the info
        if let Some(ref info) = connection_info {
            let room_key = format!("{}{}:connections", ROOM_PREFIX, info.room_id);
            conn.srem::<_, _, ()>(&room_key, connection_id).await?;
        }

        debug!("Unregistered connection {}", connection_id);
        Ok(connection_info)
    }

    pub async fn get_room_connections(
        &self,
        room_uuid: Uuid,
    ) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let room_key = format!("{}{}:connections", ROOM_PREFIX, room_uuid);

        let connections = conn.smembers::<_, Vec<String>>(&room_key).await?;
        debug!(
            "Found {} connections in room {}",
            connections.len(),
            room_uuid
        );
        Ok(connections)
    }

    // Session User Id Assignment
    //
    // Every drawing message carries a 1-byte session-scoped user id instead
    // of a 16-byte UUID (Drawpile's context id). The mapping is stable for
    // the lifetime of the session history: it lives in a Redis hash whose TTL
    // is refreshed by the message sequencer alongside the history itself.
    pub async fn assign_user_id(
        &self,
        room_uuid: Uuid,
        user_uuid: Uuid,
    ) -> Result<Option<u8>, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", USER_ID_PREFIX, room_uuid);
        let field = user_uuid.to_string();

        if let Some(existing) = conn.hget::<_, _, Option<u16>>(&key, &field).await? {
            return Ok(u8::try_from(existing).ok());
        }

        let next: i64 = conn.hincr(&key, "__next", 1).await?;
        if next > 255 {
            error!(
                "Session user id space exhausted for room {} (user {})",
                room_uuid, user_uuid
            );
            return Ok(None);
        }

        // HSETNX resolves the race between two concurrent connections of the
        // same user: the loser re-reads the winner's id (one counter slot is
        // wasted, which is fine)
        let set: bool = conn.hset_nx(&key, &field, next).await?;
        conn.expire::<_, ()>(&key, USER_ID_TTL as i64).await?;
        if set {
            Ok(u8::try_from(next).ok())
        } else {
            let existing: Option<u16> = conn.hget(&key, &field).await?;
            Ok(existing.and_then(|id| u8::try_from(id).ok()))
        }
    }

    /// Returns the uuid -> session id mapping for all known users of a room.
    pub async fn get_user_ids(
        &self,
        room_uuid: Uuid,
    ) -> Result<std::collections::HashMap<Uuid, u8>, Box<dyn std::error::Error + Send + Sync>>
    {
        let mut conn = self.pool.get().await?;
        let key = format!("{}{}", USER_ID_PREFIX, room_uuid);

        let entries: std::collections::HashMap<String, u16> = conn.hgetall(&key).await?;
        let mut result = std::collections::HashMap::new();
        for (field, id) in entries {
            if field == "__next" {
                continue;
            }
            if let (Ok(uuid), Ok(id)) = (field.parse::<Uuid>(), u8::try_from(id)) {
                result.insert(uuid, id);
            }
        }
        Ok(result)
    }

    // Pub/Sub for message broadcasting
    pub async fn publish_message(
        &self,
        room_uuid: Uuid,
        message: &RoomBroadcast,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let channel = format!("{}{}", PUBSUB_PREFIX, room_uuid);

        let subscriber_count: usize = conn.publish(&channel, message.encode()).await?;

        debug!(
            "Published message to {} subscribers in room {}",
            subscriber_count, room_uuid
        );
        Ok(subscriber_count)
    }

    // Create a dedicated Redis Pub/Sub connection for a specific room
    pub async fn create_room_subscriber(
        &self,
        room_uuid: Uuid,
        redis_url: &str,
    ) -> Result<redis::aio::PubSub, Box<dyn std::error::Error + Send + Sync>> {
        // Create a new dedicated connection for Pub/Sub (can't use pooled connections)
        let client = redis::Client::open(redis_url)?;
        let mut pubsub = client.get_async_pubsub().await?;

        let channel = self.get_room_channel(room_uuid);
        pubsub.subscribe(&channel).await?;

        debug!(
            "Created Redis subscriber for room {} on channel {}",
            room_uuid, channel
        );
        Ok(pubsub)
    }

    pub fn get_room_channel(&self, room_uuid: Uuid) -> String {
        format!("{}{}", PUBSUB_PREFIX, room_uuid)
    }

    pub async fn cleanup_room_state(
        &self,
        room_uuid: Uuid,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;

        // Clean up all room-related keys.
        //
        // Deliberately not the session user id map: it is the key to reading
        // the message history, which outlives an empty room on purpose so
        // people can come back to their drawing. Dropping the mapping while
        // keeping the history would hand the next person to rejoin an id that
        // already owns someone else's strokes — and their undo. It shares the
        // history's TTL, and `RedisMessageStore::cleanup_room` deletes both
        // together once the session is really over.
        let patterns = [
            format!("{}{}:*", ROOM_PREFIX, room_uuid),
            format!("{}{}", ACTIVITY_PREFIX, room_uuid),
            format!("{}{}", RESET_PENDING_PREFIX, room_uuid),
        ];

        let mut total_deleted = 0;
        for pattern in &patterns {
            let keys = conn.keys::<_, Vec<String>>(pattern).await?;
            if !keys.is_empty() {
                let deleted: usize = conn.del(&keys).await?;
                total_deleted += deleted;
            }
        }

        info!(
            "Cleaned up {} Redis keys for room {}",
            total_deleted, room_uuid
        );
        Ok(())
    }
}

#[cfg(test)]
mod broadcast_framing_tests {
    use super::{RoomBroadcast, BROADCAST_VERSION};
    use uuid::Uuid;

    fn round_trip(message: &RoomBroadcast) {
        let encoded = message.encode();
        assert_eq!(RoomBroadcast::decode(&encoded).as_ref(), Some(message));
    }

    #[test]
    fn round_trips_a_sequenced_drawing_message() {
        round_trip(&RoomBroadcast {
            from_connection: Uuid::new_v4().to_string(),
            target_connection: None,
            seq: Some(4_294_967_296),
            history_id: Some(Uuid::new_v4()),
            payload: vec![0x16, 0x01, 0x00, 0xff],
        });
    }

    #[test]
    fn round_trips_an_ephemeral_targeted_message() {
        round_trip(&RoomBroadcast {
            from_connection: "system".to_string(),
            target_connection: Some(Uuid::new_v4().to_string()),
            seq: None,
            history_id: None,
            payload: vec![0x1d],
        });
    }

    #[test]
    fn carries_a_payload_that_looks_like_the_header() {
        // The payload is arbitrary bytes -- a stroke's coordinates land on
        // whatever `|` and newline happen to be. Only the first newline
        // delimits, so the rest belongs to the drawing.
        round_trip(&RoomBroadcast {
            from_connection: Uuid::new_v4().to_string(),
            target_connection: None,
            seq: Some(7),
            history_id: Some(Uuid::nil()),
            payload: b"1|deadbeef||9|\n|not a header\n".to_vec(),
        });
    }

    #[test]
    fn round_trips_an_empty_payload() {
        round_trip(&RoomBroadcast {
            from_connection: "system".to_string(),
            target_connection: None,
            seq: None,
            history_id: None,
            payload: Vec::new(),
        });
    }

    #[test]
    fn rejects_anything_that_is_not_this_framing() {
        assert!(RoomBroadcast::decode(b"").is_none());
        assert!(RoomBroadcast::decode(b"no newline here").is_none());
        // The JSON envelope this replaced
        assert!(RoomBroadcast::decode(br#"{"from_connection":"x"}"#).is_none());
        // A future framing version
        assert!(RoomBroadcast::decode(b"2|x||1|\n").is_none());
        // Truncated header
        assert!(RoomBroadcast::decode(b"1|x|\n").is_none());
        // Unparseable position
        assert!(RoomBroadcast::decode(b"1|x||notanumber|\n").is_none());
    }

    #[test]
    fn matches_the_header_the_sequencer_lua_writes() {
        // The Lua in SEQUENCE_AND_PUBLISH_SCRIPT builds this by hand, so the
        // two have to agree byte for byte.
        let history_id = Uuid::nil();
        let from = "c0ffee";
        let lua_written = format!("{BROADCAST_VERSION}|{from}||12|{history_id}\n");
        let encoded = RoomBroadcast {
            from_connection: from.to_string(),
            target_connection: None,
            seq: Some(12),
            history_id: Some(history_id),
            payload: b"payload".to_vec(),
        }
        .encode();
        assert_eq!(&encoded[..lua_written.len()], lua_written.as_bytes());
        assert_eq!(&encoded[lua_written.len()..], b"payload");
    }
}
