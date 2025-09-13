use bb8_redis::{bb8::Pool, RedisConnectionManager};

use crate::AppConfig;

pub type RedisPool = Pool<RedisConnectionManager>;

impl AppConfig {
    pub async fn connect_redis(
        &self,
    ) -> Result<RedisPool, Box<dyn std::error::Error + Send + Sync>> {
        let manager = RedisConnectionManager::new(self.redis_url.clone())?;
        let pool = Pool::builder()
            .max_size(self.redis_max_connections)
            .build(manager)
            .await?;
        Ok(pool)
    }
}
