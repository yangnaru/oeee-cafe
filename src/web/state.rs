use axum::extract::ws::Message;
use dashmap::DashMap;
use minijinja::Environment;
use std::sync::Arc;
use std::time::Instant;
use uuid::Uuid;

use crate::redis::RedisPool;
use crate::AppConfig;

pub type CollaborationRooms =
    Arc<DashMap<Uuid, DashMap<String, tokio::sync::mpsc::UnboundedSender<Message>>>>;
pub type LastActivityCache = Arc<DashMap<Uuid, Instant>>;
pub type SnapshotRequestTracker = Arc<DashMap<String, bool>>;
pub type ConnectionUserMapping = Arc<DashMap<String, Uuid>>;

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub env: Environment<'static>,
    pub collaboration_rooms: CollaborationRooms,
    pub last_activity_cache: LastActivityCache,
    pub snapshot_request_tracker: SnapshotRequestTracker,
    pub connection_user_mapping: ConnectionUserMapping,
    pub redis_pool: RedisPool,
}
