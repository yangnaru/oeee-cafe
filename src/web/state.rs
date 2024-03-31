use minijinja::Environment;

use crate::AppConfig;

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub env: Environment<'static>,
}
