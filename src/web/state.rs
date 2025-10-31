use minijinja::Environment;
use sqlx::PgPool;
use std::sync::Arc;

use super::handlers::collaborate::redis_state::RedisStateManager;
use crate::push::PushService;
use crate::redis::RedisPool;
use crate::AppConfig;

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub env: Environment<'static>,
    pub db_pool: PgPool,
    pub redis_pool: RedisPool,
    pub redis_state: RedisStateManager,
    pub push_service: Arc<PushService>,
}
