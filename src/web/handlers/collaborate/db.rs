use crate::web::state::AppState;
use anyhow::Result;
use aws_sdk_s3;
use data_encoding;
use hex;
use sha256;
use sqlx::{Pool, Postgres};
use uuid::Uuid;

pub struct SessionInfo {
    pub owner_id: Uuid,
    pub width: i32,
    pub height: i32,
    pub title: Option<String>,
    pub max_participants: i32,
}

pub async fn get_session_info(
    db: &Pool<Postgres>,
    room_uuid: Uuid,
) -> Result<Option<SessionInfo>, sqlx::Error> {
    let session = sqlx::query!(
        r#"
        SELECT owner_id, width, height, title, max_participants FROM collaborative_sessions
        WHERE id = $1 AND ended_at IS NULL
        "#,
        room_uuid
    )
    .fetch_optional(db)
    .await?;

    Ok(session.map(|s| SessionInfo {
        owner_id: s.owner_id,
        width: s.width,
        height: s.height,
        title: s.title,
        max_participants: s.max_participants,
    }))
}

pub async fn check_existing_participant(
    db: &Pool<Postgres>,
    room_uuid: Uuid,
    user_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let existing_participant = sqlx::query_scalar!(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM collaborative_sessions_participants 
            WHERE session_id = $1 AND user_id = $2
        )
        "#,
        room_uuid,
        user_id
    )
    .fetch_one(db)
    .await?
    .unwrap_or(false); // Only unwrap the Option<bool>, not the Result

    Ok(existing_participant)
}

pub async fn get_active_user_count(
    db: &Pool<Postgres>,
    room_uuid: Uuid,
) -> Result<i64, sqlx::Error> {
    let active_user_count = sqlx::query_scalar!(
        r#"
        SELECT COUNT(DISTINCT user_id) as "count!"
        FROM collaborative_sessions_participants
        WHERE session_id = $1 AND is_active = true
        "#,
        room_uuid
    )
    .fetch_one(db)
    .await?; // Propagate database errors instead of returning 0

    Ok(active_user_count)
}

pub async fn track_participant(
    db: &Pool<Postgres>,
    room_uuid: Uuid,
    user_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"
        INSERT INTO collaborative_sessions_participants 
        (session_id, user_id, is_active)
        VALUES ($1, $2, true)
        ON CONFLICT (session_id, user_id) 
        DO UPDATE SET is_active = true, left_at = NULL
        "#,
        room_uuid,
        user_id
    )
    .execute(db)
    .await?;

    Ok(())
}

pub async fn track_participant_with_capacity_check(
    db: &Pool<Postgres>,
    room_uuid: Uuid,
    user_id: Uuid,
    max_participants: i32,
) -> Result<bool, sqlx::Error> {
    let mut tx = db.begin().await?;

    // First, lock the session row to prevent concurrent modifications
    let _session = sqlx::query!(
        r#"
        SELECT max_participants
        FROM collaborative_sessions
        WHERE id = $1 AND ended_at IS NULL
        FOR UPDATE
        "#,
        room_uuid
    )
    .fetch_optional(&mut *tx)
    .await?;

    // If session doesn't exist or has ended, fail
    if _session.is_none() {
        tx.rollback().await?;
        return Ok(false);
    }

    // Check if user is already a participant (existing participants can always rejoin)
    let existing_participant = sqlx::query_scalar!(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM collaborative_sessions_participants 
            WHERE session_id = $1 AND user_id = $2
        )
        "#,
        room_uuid,
        user_id
    )
    .fetch_one(&mut *tx)
    .await?
    .unwrap_or(false); // Only unwrap the Option<bool>, not the Result

    if !existing_participant {
        // For new participants, check capacity
        let active_user_count = sqlx::query_scalar!(
            r#"
            SELECT COUNT(DISTINCT user_id) as "count!"
            FROM collaborative_sessions_participants
            WHERE session_id = $1 AND is_active = true
            "#,
            room_uuid
        )
        .fetch_one(&mut *tx)
        .await?;

        if active_user_count >= max_participants as i64 {
            tx.rollback().await?;
            return Ok(false);
        }
    }

    // Add or reactivate the participant
    sqlx::query!(
        r#"
        INSERT INTO collaborative_sessions_participants 
        (session_id, user_id, is_active)
        VALUES ($1, $2, true)
        ON CONFLICT (session_id, user_id) 
        DO UPDATE SET is_active = true, left_at = NULL
        "#,
        room_uuid,
        user_id
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(true)
}

pub async fn update_session_activity(state: &AppState, room_uuid: Uuid) {
    if let Err(e) = state.redis_state.update_room_activity(room_uuid).await {
        tracing::error!("Failed to update room activity in Redis: {}", e);
    }
}

pub async fn track_join_participant(
    db: &Pool<Postgres>,
    room_uuid: Uuid,
    user_uuid: Uuid,
    timestamp: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"
        INSERT INTO collaborative_sessions_participants 
        (session_id, user_id, joined_at, is_active)
        VALUES ($1, $2, to_timestamp($3::bigint / 1000), true)
        ON CONFLICT (session_id, user_id) 
        DO UPDATE SET is_active = true, left_at = NULL
        "#,
        room_uuid,
        user_uuid,
        timestamp
    )
    .execute(db)
    .await?;

    Ok(())
}

pub async fn get_active_participants(
    db: &Pool<Postgres>,
    room_uuid: Uuid,
) -> Result<Vec<crate::models::user::User>, sqlx::Error> {
    let participants = sqlx::query!(
        r#"
        SELECT csp.user_id, u.login_name FROM collaborative_sessions_participants csp
        JOIN users u ON csp.user_id = u.id
        WHERE csp.session_id = $1 AND csp.is_active = true
        ORDER BY csp.joined_at ASC
        "#,
        room_uuid
    )
    .fetch_all(db)
    .await?;

    Ok(participants
        .into_iter()
        .map(|p| crate::models::user::User {
            id: p.user_id,
            login_name: p.login_name,
            password_hash: String::new(),
            display_name: String::new(),
            email: None,
            email_verified_at: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            banner_id: None,
            preferred_language: None,
            deleted_at: None,
        })
        .collect())
}

pub async fn end_session(db: &Pool<Postgres>, room_uuid: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "UPDATE collaborative_sessions SET ended_at = NOW() WHERE id = $1",
        room_uuid
    )
    .execute(db)
    .await?;

    Ok(())
}

pub async fn mark_participant_inactive(
    db: &Pool<Postgres>,
    room_uuid: Uuid,
    user_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"
        UPDATE collaborative_sessions_participants 
        SET is_active = false, left_at = NOW()
        WHERE session_id = $1 AND user_id = $2
        "#,
        room_uuid,
        user_id
    )
    .execute(db)
    .await?;

    Ok(())
}

pub async fn save_session_to_post(
    db: Pool<Postgres>,
    session_id: Uuid,
    owner_id: Uuid,
    png_data: Vec<u8>,
    state: AppState,
) -> Result<(Uuid, String), Box<dyn std::error::Error + Send + Sync>> {
    let mut tx = db.begin().await?;

    // Lock the session row and check if it's already saved atomically
    let session = sqlx::query!(
        r#"
        SELECT cs.owner_id, cs.title, cs.width, cs.height, cs.community_id, 
               cs.created_at, cs.ended_at, cs.saved_post_id,
               u.login_name as owner_login_name 
        FROM collaborative_sessions cs
        JOIN users u ON cs.owner_id = u.id
        WHERE cs.id = $1 AND cs.owner_id = $2
        FOR UPDATE
        "#,
        session_id,
        owner_id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or("Session not found or not owned by user")?;

    // Check if already saved while holding the lock
    if session.saved_post_id.is_some() {
        tx.rollback().await?;
        return Err("Session has already been saved".into());
    }

    let participants = sqlx::query!(
        r#"
        SELECT u.login_name
        FROM collaborative_sessions_participants csp
        JOIN users u ON csp.user_id = u.id
        WHERE csp.session_id = $1
        ORDER BY csp.joined_at ASC
        "#,
        session_id
    )
    .fetch_all(&mut *tx)
    .await?;

    let image_sha256 = sha256::digest(&png_data);

    let credentials = aws_sdk_s3::config::Credentials::new(
        state.config.aws_access_key_id.clone(),
        state.config.aws_secret_access_key.clone(),
        None,
        None,
        "",
    );
    let credentials_provider = aws_sdk_s3::config::SharedCredentialsProvider::new(credentials);
    let s3_config = aws_sdk_s3::Config::builder()
        .endpoint_url(state.config.r2_endpoint_url.clone())
        .region(aws_sdk_s3::config::Region::new(
            state.config.aws_region.clone(),
        ))
        .credentials_provider(credentials_provider)
        .behavior_version_latest()
        .build();
    let s3_client = aws_sdk_s3::Client::from_conf(s3_config);

    // SHA256 is always 64 hex characters, but let's be safe about accessing them
    let s3_key = if image_sha256.len() >= 2 {
        format!(
            "image/{}{}/{}.png",
            &image_sha256[0..1],
            &image_sha256[1..2],
            image_sha256
        )
    } else {
        // This should never happen with valid SHA256, but handle gracefully
        return Err("Invalid SHA256 hash: too short".into());
    };

    s3_client
        .put_object()
        .bucket(&state.config.aws_s3_bucket)
        .key(&s3_key)
        .checksum_sha256(data_encoding::BASE64.encode(&hex::decode(&image_sha256)?))
        .body(aws_sdk_s3::primitives::ByteStream::from(png_data))
        .send()
        .await?;

    let participant_names: Vec<String> =
        participants.iter().map(|p| p.login_name.clone()).collect();

    let _description = if participant_names.len() > 1 {
        format!(
            "Collaborative drawing with {} participants: {}",
            participant_names.len(),
            participant_names.join(", ")
        )
    } else {
        "Collaborative drawing".to_string()
    };

    let community_id = session.community_id;

    let now = chrono::Utc::now();
    let created_at_utc = session.created_at.and_utc();
    let duration = now - created_at_utc;

    let total_microseconds = duration.num_microseconds().unwrap_or(0);
    let days = duration.num_days();
    let microseconds_per_day = 24 * 60 * 60 * 1_000_000i64;
    let remainder_microseconds = total_microseconds - (days * microseconds_per_day);

    let paint_duration = sqlx::postgres::types::PgInterval {
        months: 0,
        days: days as i32,
        microseconds: remainder_microseconds,
    };

    let image_id = Uuid::new_v4();

    sqlx::query!(
        r#"
        INSERT INTO images (id, width, height, paint_duration, stroke_count, image_filename, replay_filename, tool)
        VALUES ($1, $2, $3, $4, 0, $5, NULL, 'neo-cucumber'::tool)
        "#,
        image_id,
        session.width,
        session.height,
        paint_duration,
        format!("{}.png", image_sha256),
    )
    .execute(&mut *tx)
    .await?;

    let post_id = Uuid::new_v4();
    sqlx::query!(
        r#"
        INSERT INTO posts (id, author_id, community_id, image_id, is_sensitive, published_at)
        VALUES ($1, $2, $3, $4, false, NOW())
        "#,
        post_id,
        owner_id,
        community_id,
        image_id,
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query!(
        "UPDATE collaborative_sessions SET saved_post_id = $1 WHERE id = $2",
        post_id,
        session_id
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    tracing::info!(
        "Successfully saved collaborative drawing from session {} as post {}",
        session_id,
        post_id
    );

    Ok((post_id, session.owner_login_name))
}
