use minijinja::Environment;

use crate::redis::RedisPool;
use crate::AppConfig;
use super::handlers::collaborate::redis_state::RedisStateManager;

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub env: Environment<'static>,
    pub redis_pool: RedisPool,
    pub redis_state: RedisStateManager,
}
