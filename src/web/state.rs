use std::sync::Arc;

use minijinja_autoreload::AutoReloader;

use crate::AppConfig;

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub reloader: Arc<AutoReloader>,
}
