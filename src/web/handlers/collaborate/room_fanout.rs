//! One Redis subscription per room per process, shared by its connections.
//!
//! Every connection used to open its own Pub/Sub connection to Redis and
//! decode the room's whole stream for itself. Eight people in a room meant
//! Redis delivered every stroke eight times, and this process parsed the same
//! header and the same UUID eight times, to decide seven times over that the
//! message was worth forwarding.
//!
//! So the subscription belongs to the room. One task reads it, decodes each
//! broadcast once, and hands out an `Arc` of it; the connections take it from
//! a `broadcast` channel and decide for themselves what to do with it. The
//! last connection to leave takes the subscription with it.

use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};
use tokio::task::JoinHandle;
use tracing::{debug, error};
use uuid::Uuid;

use super::redis_state::RoomBroadcast;

/// How far behind a connection may fall before it is told to reconnect.
///
/// Matched to the per-connection outgoing queue: a connection that cannot keep
/// up with the fanout could not have kept up with its own socket either, and
/// both failures are answered the same way -- close, and let it resume from
/// the position it last acknowledged.
const FANOUT_QUEUE_LIMIT: usize = 1024;

struct RoomEntry {
    sender: broadcast::Sender<Arc<RoomBroadcast>>,
    /// Connections currently holding a listener. The entry goes when it hits
    /// zero; a room with nobody in it has nothing to deliver.
    listeners: usize,
    task: JoinHandle<()>,
}

/// The rooms this process is subscribed to.
#[derive(Clone)]
pub struct RoomFanout {
    rooms: Arc<Mutex<HashMap<Uuid, RoomEntry>>>,
    redis_url: Arc<str>,
}

/// One connection's view of a room's stream.
pub struct RoomListener {
    pub receiver: broadcast::Receiver<Arc<RoomBroadcast>>,
}

impl RoomFanout {
    pub fn new(redis_url: &str) -> Self {
        Self {
            rooms: Arc::new(Mutex::new(HashMap::new())),
            redis_url: Arc::from(redis_url),
        }
    }

    /// Joins a room's stream, subscribing to it first if nobody else has.
    ///
    /// The Redis `SUBSCRIBE` has completed by the time this returns, which is
    /// what lets the caller replay history afterwards without a gap: anything
    /// published from here on is already being buffered for this listener.
    pub async fn subscribe(
        &self,
        room_uuid: Uuid,
        channel: &str,
    ) -> Result<RoomListener, Box<dyn std::error::Error + Send + Sync>> {
        let mut rooms = self.rooms.lock().await;

        if let Some(entry) = rooms.get_mut(&room_uuid) {
            entry.listeners += 1;
            return Ok(RoomListener {
                receiver: entry.sender.subscribe(),
            });
        }

        let client = redis::Client::open(&*self.redis_url)?;
        let mut pubsub = client.get_async_pubsub().await?;
        pubsub.subscribe(channel).await?;

        let (sender, receiver) = broadcast::channel(FANOUT_QUEUE_LIMIT);
        let publisher = sender.clone();
        let task = tokio::spawn(async move {
            let mut stream = pubsub.on_message();
            while let Some(message) = stream.next().await {
                let payload: Vec<u8> = message.get_payload().unwrap_or_default();
                match RoomBroadcast::decode(&payload) {
                    // The error is that nobody is listening, which is the
                    // normal state between the last leave and the abort below.
                    Some(broadcast) => {
                        let _ = publisher.send(Arc::new(broadcast));
                    }
                    None => error!(
                        "Dropping unrecognised Redis broadcast ({} bytes)",
                        payload.len()
                    ),
                }
            }
        });

        debug!(
            "Subscribed to room {} on channel {} for this process",
            room_uuid, channel
        );
        rooms.insert(
            room_uuid,
            RoomEntry {
                sender,
                listeners: 1,
                task,
            },
        );
        Ok(RoomListener { receiver })
    }

    /// Gives up one connection's share of a room's subscription.
    ///
    /// Must be called once per successful `subscribe`. It is not a `Drop`
    /// because dropping cannot await, and the map is behind an async lock so
    /// that `subscribe` can complete its Redis handshake while holding it.
    pub async fn release(&self, room_uuid: Uuid) {
        let mut rooms = self.rooms.lock().await;
        let Some(entry) = rooms.get_mut(&room_uuid) else {
            return;
        };
        entry.listeners = entry.listeners.saturating_sub(1);
        if entry.listeners == 0 {
            if let Some(entry) = rooms.remove(&room_uuid) {
                entry.task.abort();
                debug!("Unsubscribed from room {}: nobody left here", room_uuid);
            }
        }
    }

    #[cfg(test)]
    pub async fn subscribed_rooms(&self) -> usize {
        self.rooms.lock().await.len()
    }

    #[cfg(test)]
    pub async fn listeners_in(&self, room_uuid: Uuid) -> usize {
        self.rooms
            .lock()
            .await
            .get(&room_uuid)
            .map_or(0, |entry| entry.listeners)
    }
}
