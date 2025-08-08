use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct CanvasSession {
    pub id: Uuid,
    pub room_id: String,
    pub title: Option<String>,
    pub max_users: Option<i32>,
    pub canvas_width: i32,
    pub canvas_height: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub owner_user_id: Option<Uuid>,
    pub is_active: bool,
    pub is_public: bool,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct CanvasMessage {
    pub id: i64,
    pub session_id: Uuid,
    pub sequence_number: i64,
    pub message_type: i16,
    pub user_id: i16,
    pub user_name: Option<String>,
    pub message_data: Vec<u8>,
    pub received_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct CanvasSessionUser {
    pub id: Uuid,
    pub session_id: Uuid,
    pub protocol_user_id: i16,
    pub user_name: String,
    pub user_id: Option<Uuid>,
    pub joined_at: DateTime<Utc>,
    pub last_activity: DateTime<Utc>,
    pub is_connected: bool,
}

impl CanvasSession {
    pub async fn create(
        pool: &PgPool,
        room_id: String,
        title: Option<String>,
        canvas_width: i32,
        canvas_height: i32,
        owner_user_id: Option<Uuid>,
        is_public: bool,
    ) -> Result<Self> {
        let session = sqlx::query_as!(
            CanvasSession,
            r#"
            INSERT INTO collaborative_sessions (room_id, title, canvas_width, canvas_height, owner_user_id, is_public)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            "#,
            room_id,
            title,
            canvas_width,
            canvas_height,
            owner_user_id,
            is_public
        )
        .fetch_one(pool)
        .await?;

        Ok(session)
    }

    pub async fn find_by_room_id(pool: &PgPool, room_id: &str) -> Result<Option<Self>> {
        let session = sqlx::query_as!(
            CanvasSession,
            "SELECT * FROM collaborative_sessions WHERE room_id = $1 AND is_active = TRUE",
            room_id
        )
        .fetch_optional(pool)
        .await?;

        Ok(session)
    }

    pub async fn get_or_create_by_room_id(
        pool: &PgPool,
        room_id: String,
        canvas_width: Option<i32>,
        canvas_height: Option<i32>,
    ) -> Result<Self> {
        if let Some(session) = Self::find_by_room_id(pool, &room_id).await? {
            return Ok(session);
        }

        Self::create(
            pool,
            room_id,
            None,
            canvas_width.unwrap_or(800),
            canvas_height.unwrap_or(600),
            None,
            false, // Default to private when joining via room ID
        )
        .await
    }

    pub async fn deactivate(&self, pool: &PgPool) -> Result<()> {
        sqlx::query!(
            "UPDATE collaborative_sessions SET is_active = FALSE, updated_at = NOW() WHERE id = $1",
            self.id
        )
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn get_active_public_sessions(
        pool: &PgPool,
        limit: Option<i64>,
    ) -> Result<Vec<(Self, i64)>> {
        let limit_val = limit.unwrap_or(10);

        let results = sqlx::query!(
            r#"
            SELECT s.*, COUNT(u.id) as user_count FROM collaborative_sessions s
            LEFT JOIN collaborative_session_users u ON s.id = u.session_id AND u.is_connected = TRUE
            WHERE s.is_active = TRUE 
              AND s.is_public = TRUE
            GROUP BY s.id, s.room_id, s.title, s.max_users, s.canvas_width, s.canvas_height, 
                     s.created_at, s.updated_at, s.owner_user_id, s.is_active, s.is_public
            ORDER BY COUNT(u.id) DESC, s.updated_at DESC
            LIMIT $1
            "#,
            limit_val
        )
        .fetch_all(pool)
        .await?;

        let sessions_with_counts = results
            .into_iter()
            .map(|row| {
                let session = CanvasSession {
                    id: row.id,
                    room_id: row.room_id,
                    title: row.title,
                    max_users: row.max_users,
                    canvas_width: row.canvas_width,
                    canvas_height: row.canvas_height,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                    owner_user_id: row.owner_user_id,
                    is_active: row.is_active,
                    is_public: row.is_public,
                };
                (session, row.user_count.unwrap_or(0))
            })
            .collect();

        Ok(sessions_with_counts)
    }
}

impl CanvasMessage {
    pub async fn add_message(
        pool: &PgPool,
        session_id: Uuid,
        message_type: i16,
        user_id: i16,
        user_name: Option<String>,
        message_data: Vec<u8>,
    ) -> Result<Self> {
        // Get the next sequence number for this session
        let sequence_number: i64 = sqlx::query_scalar!(
            "SELECT COALESCE(MAX(sequence_number), 0) + 1 FROM collaborative_messages WHERE session_id = $1",
            session_id
        )
        .fetch_one(pool)
        .await?
        .unwrap_or(1);

        let message = sqlx::query_as!(
            CanvasMessage,
            r#"
            INSERT INTO collaborative_messages (session_id, sequence_number, message_type, user_id, user_name, message_data)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            "#,
            session_id,
            sequence_number,
            message_type,
            user_id,
            user_name,
            message_data
        )
        .fetch_one(pool)
        .await?;

        Ok(message)
    }

    pub async fn get_session_messages(
        pool: &PgPool,
        session_id: Uuid,
        from_sequence: Option<i64>,
        limit: Option<i64>,
    ) -> Result<Vec<Self>> {
        let from_seq = from_sequence.unwrap_or(0);
        let limit_val = limit.unwrap_or(1000);

        let messages = sqlx::query_as!(
            CanvasMessage,
            r#"
            SELECT * FROM collaborative_messages 
            WHERE session_id = $1 AND sequence_number > $2
            ORDER BY sequence_number ASC
            LIMIT $3
            "#,
            session_id,
            from_seq,
            limit_val
        )
        .fetch_all(pool)
        .await?;

        Ok(messages)
    }

    pub async fn get_drawing_commands_only(pool: &PgPool, session_id: Uuid) -> Result<Vec<Self>> {
        let messages = sqlx::query_as!(
            CanvasMessage,
            r#"
            SELECT * FROM collaborative_messages 
            WHERE session_id = $1 AND message_type >= 64 AND message_type <= 127
            ORDER BY sequence_number ASC
            "#,
            session_id
        )
        .fetch_all(pool)
        .await?;

        Ok(messages)
    }
}

impl CanvasSessionUser {
    pub async fn add_user(
        pool: &PgPool,
        session_id: Uuid,
        protocol_user_id: i16,
        user_name: String,
        user_id: Option<Uuid>,
    ) -> Result<Self> {
        let user = sqlx::query_as!(
            CanvasSessionUser,
            r#"
            INSERT INTO collaborative_session_users (session_id, protocol_user_id, user_name, user_id)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (session_id, protocol_user_id) DO UPDATE SET
                user_name = EXCLUDED.user_name,
                user_id = EXCLUDED.user_id,
                is_connected = TRUE,
                last_activity = NOW()
            RETURNING *
            "#,
            session_id,
            protocol_user_id,
            user_name,
            user_id
        )
        .fetch_one(pool)
        .await?;

        Ok(user)
    }

    pub async fn remove_user(pool: &PgPool, session_id: Uuid, protocol_user_id: i16) -> Result<()> {
        sqlx::query!(
            "UPDATE collaborative_session_users SET is_connected = FALSE WHERE session_id = $1 AND protocol_user_id = $2",
            session_id,
            protocol_user_id
        )
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn get_connected_users(pool: &PgPool, session_id: Uuid) -> Result<Vec<Self>> {
        let users = sqlx::query_as!(
            CanvasSessionUser,
            "SELECT * FROM collaborative_session_users WHERE session_id = $1 AND is_connected = TRUE ORDER BY joined_at ASC",
            session_id
        )
        .fetch_all(pool)
        .await?;

        Ok(users)
    }

    pub async fn update_activity(
        pool: &PgPool,
        session_id: Uuid,
        protocol_user_id: i16,
    ) -> Result<()> {
        sqlx::query!(
            "UPDATE collaborative_session_users SET last_activity = NOW() WHERE session_id = $1 AND protocol_user_id = $2",
            session_id,
            protocol_user_id
        )
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn cleanup_inactive_users(
        pool: &PgPool,
        session_id: Uuid,
        inactive_minutes: i32,
    ) -> Result<u64> {
        let result = sqlx::query!(
            "UPDATE collaborative_session_users 
             SET is_connected = FALSE 
             WHERE session_id = $1 
               AND is_connected = TRUE 
               AND last_activity < NOW() - INTERVAL '1 minute' * $2",
            session_id,
            inactive_minutes as f64
        )
        .execute(pool)
        .await?;

        Ok(result.rows_affected())
    }
}
