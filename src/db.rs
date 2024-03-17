use sqlx::postgres::PgPoolOptions;
use sqlx::{Error, PgPool};

use crate::AppConfig;

impl AppConfig {
    pub async fn connect_database(&self) -> Result<PgPool, Error> {
        let db = PgPoolOptions::new()
            .max_connections(self.db_max_connections)
            .acquire_timeout(self.db_acquire_timeout)
            .connect(&self.db_url)
            .await?;
        Ok(db)
    }
}
