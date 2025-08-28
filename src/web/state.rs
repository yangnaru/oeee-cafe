use minijinja::Environment;
use dashmap::DashMap;
use axum::extract::ws::Message;
use uuid::Uuid;
use std::sync::Arc;

use crate::AppConfig;

pub type CollaborationRooms = Arc<DashMap<Uuid, DashMap<String, tokio::sync::mpsc::UnboundedSender<Message>>>>;
pub type MessageHistory = Arc<DashMap<Uuid, Vec<Message>>>;

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub env: Environment<'static>,
    pub collaboration_rooms: CollaborationRooms,
    pub message_history: MessageHistory,
}
