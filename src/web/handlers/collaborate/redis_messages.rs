use axum::extract::ws::Message;
use redis::AsyncCommands;
use tracing::{debug, error};
use uuid::Uuid;

use crate::redis::RedisPool;

const MESSAGE_HISTORY_TTL: u64 = 3600; // 1 hour TTL
// v3: entries are "{seq}:{payload}" oldest-first; payloads use 1-byte session
// user ids and STROKE batches
const MESSAGE_HISTORY_PREFIX: &str = "oeee:msg_history:v3:";
const MESSAGE_SEQ_PREFIX: &str = "oeee:msg_seq:";
const MAX_REDIS_MESSAGES: usize = 50000;

/// Atomically assigns the next per-room sequence number, appends the message to
/// the history list, and publishes the envelope (with the sequence number
/// injected) to the room's Pub/Sub channel.
///
/// This is the single serialization point for drawing commands, modeled after
/// Drawpile's SessionHistory: because sequencing, storage, and broadcast happen
/// in one atomic step, the history replayed to late joiners and the live
/// Pub/Sub stream are guaranteed to present messages in the same canonical
/// order to every client.
const SEQUENCE_AND_PUBLISH_SCRIPT: &str = r#"
local seq = redis.call('INCR', KEYS[1])
redis.call('RPUSH', KEYS[2], tostring(seq) .. ':' .. ARGV[1])
redis.call('LTRIM', KEYS[2], -tonumber(ARGV[3]), -1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
redis.call('EXPIRE', KEYS[4], tonumber(ARGV[4]))
local envelope = cjson.decode(ARGV[2])
envelope['seq'] = seq
redis.call('PUBLISH', KEYS[3], cjson.encode(envelope))
return seq
"#;

pub struct RedisMessageStore {
    pool: RedisPool,
}

fn history_key(room_uuid: Uuid) -> String {
    format!("{}{}", MESSAGE_HISTORY_PREFIX, room_uuid)
}

fn seq_key(room_uuid: Uuid) -> String {
    format!("{}{}", MESSAGE_SEQ_PREFIX, room_uuid)
}

/// Splits a stored "{seq}:{payload}" entry. Returns None for malformed entries.
fn decode_entry(entry: &[u8]) -> Option<(u64, &[u8])> {
    let sep = entry.iter().position(|&b| b == b':')?;
    let seq = std::str::from_utf8(&entry[..sep]).ok()?.parse().ok()?;
    Some((seq, &entry[sep + 1..]))
}

impl RedisMessageStore {
    pub fn new(pool: RedisPool) -> Self {
        Self { pool }
    }

    pub async fn sequence_and_publish(
        &self,
        room_uuid: Uuid,
        payload: &[u8],
        envelope_json: &str,
        channel: &str,
    ) -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await.map_err(|e| {
            error!("Failed to get Redis connection: {}", e);
            e
        })?;

        let script = redis::Script::new(SEQUENCE_AND_PUBLISH_SCRIPT);
        let seq: u64 = script
            .key(seq_key(room_uuid))
            .key(history_key(room_uuid))
            .key(channel)
            .key(format!(
                "{}{}",
                super::redis_state::USER_ID_PREFIX,
                room_uuid
            ))
            .arg(payload)
            .arg(envelope_json)
            .arg(MAX_REDIS_MESSAGES)
            .arg(MESSAGE_HISTORY_TTL)
            .invoke_async(&mut *conn)
            .await
            .map_err(|e| {
                error!(
                    "Failed to sequence message for room {}: {}",
                    room_uuid, e
                );
                e
            })?;

        debug!(
            "Sequenced message {} for room {} ({} bytes)",
            seq,
            room_uuid,
            payload.len()
        );
        Ok(seq)
    }

    pub async fn get_history(
        &self,
        room_uuid: Uuid,
    ) -> Result<Vec<Message>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self
            .get_history_with_seqs(room_uuid)
            .await?
            .into_iter()
            .map(|(_, msg)| msg)
            .collect())
    }

    pub async fn get_history_with_seqs(
        &self,
        room_uuid: Uuid,
    ) -> Result<Vec<(u64, Message)>, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;

        // Entries are RPUSHed, so the list is already in chronological order
        let entries: Vec<Vec<u8>> = conn.lrange(history_key(room_uuid), 0, -1).await?;

        let mut result = Vec::with_capacity(entries.len());
        for entry in &entries {
            match decode_entry(entry) {
                Some((seq, payload)) => result.push((seq, Message::Binary(payload.to_vec()))),
                None => debug!(
                    "Skipping malformed history entry in room {} ({} bytes)",
                    room_uuid,
                    entry.len()
                ),
            }
        }

        debug!(
            "Retrieved {} messages from Redis for room {}",
            result.len(),
            room_uuid
        );
        Ok(result)
    }

    pub async fn history_len(
        &self,
        room_uuid: Uuid,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let len: usize = conn.llen(history_key(room_uuid)).await?;
        Ok(len)
    }

    /// Atomically replaces the history prefix up to and including `base_seq`
    /// with the given reset snapshot payloads (Drawpile-style session reset).
    ///
    /// The snapshots represent the canonical canvas state at history position
    /// `base_seq`, so they are stored with that sequence number and placed
    /// before all surviving entries (seq > base_seq). Late joiners then replay
    /// [snapshots, messages after base_seq] and reconstruct the exact same
    /// state as live clients, who never see the reset at all.
    pub async fn apply_reset(
        &self,
        room_uuid: Uuid,
        base_seq: u64,
        payloads: &[Vec<u8>],
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        const APPLY_RESET_SCRIPT: &str = r#"
local base = tonumber(ARGV[1])
local entries = redis.call('LRANGE', KEYS[1], 0, -1)
local kept = {}
for i = 1, #entries do
    local e = entries[i]
    local sep = string.find(e, ':', 1, true)
    if sep then
        local seq = tonumber(string.sub(e, 1, sep - 1))
        if seq and seq > base then
            kept[#kept + 1] = e
        end
    end
end
redis.call('DEL', KEYS[1])
for i = 3, #ARGV do
    redis.call('RPUSH', KEYS[1], ARGV[1] .. ':' .. ARGV[i])
end
for i = 1, #kept do
    redis.call('RPUSH', KEYS[1], kept[i])
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return #kept
"#;

        let mut conn = self.pool.get().await?;

        let script = redis::Script::new(APPLY_RESET_SCRIPT);
        let mut invocation = script.key(history_key(room_uuid));
        invocation.arg(base_seq).arg(MESSAGE_HISTORY_TTL);
        for payload in payloads {
            invocation.arg(payload.as_slice());
        }
        let kept: usize = invocation.invoke_async(&mut *conn).await?;

        debug!(
            "Applied session reset for room {} at seq {}: {} snapshots, {} newer entries kept",
            room_uuid,
            base_seq,
            payloads.len(),
            kept
        );
        Ok(())
    }

    pub async fn cleanup_room(
        &self,
        room_uuid: Uuid,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;

        let deleted: usize = conn
            .del(&[
                history_key(room_uuid),
                seq_key(room_uuid),
                format!("{}{}", super::redis_state::USER_ID_PREFIX, room_uuid),
            ])
            .await?;
        if deleted > 0 {
            debug!("Cleaned up Redis message history for room {}", room_uuid);
        }

        Ok(())
    }

    pub async fn enforce_history_limits(
        &self,
        room_uuid: Uuid,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;
        let key = history_key(room_uuid);

        // Get current message count
        let current_length: usize = conn.llen(&key).await?;

        if current_length <= MAX_REDIS_MESSAGES {
            return Ok(0);
        }

        // Keep only the newest MAX_REDIS_MESSAGES entries (oldest are on the left)
        let to_remove = current_length - MAX_REDIS_MESSAGES;
        conn.ltrim::<_, ()>(&key, -(MAX_REDIS_MESSAGES as isize), -1)
            .await?;

        debug!(
            "Enforced history limits for room {}: removed {} messages (was {}, now {})",
            room_uuid, to_remove, current_length, MAX_REDIS_MESSAGES
        );

        Ok(to_remove)
    }

    pub async fn refresh_ttl(
        &self,
        room_uuid: Uuid,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.pool.get().await?;

        conn.expire::<_, ()>(history_key(room_uuid), MESSAGE_HISTORY_TTL as i64)
            .await?;
        Ok(())
    }
}

