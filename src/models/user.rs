use anyhow::Result;
use argon2::password_hash::{
    rand_core::OsRng, PasswordHashString, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use axum::async_trait;
use axum_login::{AuthUser, AuthnBackend, UserId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::types::Uuid;
use sqlx::{query, query_as, PgPool, Postgres, Transaction, Type};

use crate::models::actor::create_actor_for_user;
use crate::AppConfig;

pub struct UserDraft {
    pub login_name: String,
    pub password_hash: String,
    pub display_name: String,
}

impl UserDraft {
    pub fn new(login_name: String, password: String, display_name: String) -> Result<Self> {
        if password.len() < 8 {
            return Err(anyhow::anyhow!("비밀번호는 8자 이상이어야 합니다"));
        }

        let salt = SaltString::generate(&mut OsRng);
        let argon2 = Argon2::default();
        let password_hash = argon2
            .hash_password(password.as_bytes(), &salt)?
            .serialize()
            .to_string();

        Ok(Self {
            login_name,
            password_hash,
            display_name,
        })
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Type)]
#[sqlx(type_name = "preferred_language", rename_all = "lowercase")]
pub enum Language {
    Ko,
    Ja,
    En,
    Zh,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct User {
    pub id: Uuid,
    pub login_name: String,
    #[serde(skip_serializing)]
    pub password_hash: String,
    pub display_name: String,
    pub email: Option<String>,
    pub email_verified_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub banner_id: Option<Uuid>,
    pub preferred_language: Option<Language>,
}

impl User {
    pub fn verify_password(&self, password: &str) -> Result<(), argon2::password_hash::Error> {
        let argon2 = Argon2::default();
        let pwstr = PasswordHashString::new(&self.password_hash)?;
        let password_hash = pwstr.password_hash();
        argon2.verify_password(password.as_bytes(), &password_hash)
    }
}

pub async fn update_user_preferred_language(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    preferred_language: Option<Language>,
) -> Result<User> {
    let q = query_as!(
        User,
        r#"
            UPDATE users
            SET preferred_language = $1, updated_at = now()
            WHERE id = $2
            RETURNING
                id,
                login_name,
                password_hash,
                display_name,
                email,
                email_verified_at,
                created_at,
                updated_at,
                banner_id,
                preferred_language AS "preferred_language: _"
        "#,
        preferred_language as _,
        id,
    );
    let result = q.fetch_one(&mut **tx).await?;

    Ok(User {
        id: result.id,
        login_name: result.login_name,
        password_hash: result.password_hash,
        display_name: result.display_name,
        email: result.email,
        email_verified_at: result.email_verified_at,
        created_at: result.created_at,
        updated_at: result.updated_at,
        banner_id: result.banner_id,
        preferred_language: result.preferred_language,
    })
}

pub async fn update_user_email_verified_at(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    email: String,
    email_verified_at: DateTime<Utc>,
) -> Result<User> {
    let q = query_as!(
        User,
        r#"
            UPDATE users
            SET email = $1, email_verified_at = $2, updated_at = now()
            WHERE id = $3
            RETURNING
                id,
                login_name,
                password_hash,
                display_name,
                email,
                email_verified_at,
                created_at,
                updated_at,
                banner_id,
                preferred_language AS "preferred_language: _"
        "#,
        email,
        email_verified_at,
        id,
    );
    let result = q.fetch_one(&mut **tx).await?;

    Ok(User {
        id: result.id,
        login_name: result.login_name,
        password_hash: result.password_hash,
        display_name: result.display_name,
        email: result.email,
        email_verified_at: result.email_verified_at,
        created_at: result.created_at,
        updated_at: result.updated_at,
        banner_id: result.banner_id,
        preferred_language: result.preferred_language,
    })
}

pub async fn update_password(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    new_password: String,
) -> Result<User> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let password_hash = argon2
        .hash_password(new_password.as_bytes(), &salt)?
        .serialize()
        .to_string();

    let q = query_as!(
        User,
        r#"
            UPDATE users
            SET password_hash = $1, updated_at = now()
            WHERE id = $2
            RETURNING
                id,
                login_name,
                password_hash,
                display_name,
                email,
                email_verified_at,
                created_at,
                updated_at,
                banner_id,
                preferred_language AS "preferred_language: _"
        "#,
        password_hash,
        id,
    );
    let result = q.fetch_one(&mut **tx).await?;

    Ok(User {
        id: result.id,
        login_name: result.login_name,
        password_hash: result.password_hash,
        display_name: result.display_name,
        email: result.email,
        email_verified_at: result.email_verified_at,
        created_at: result.created_at,
        updated_at: result.updated_at,
        banner_id: result.banner_id,
        preferred_language: result.preferred_language,
    })
}

pub async fn update_user(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    login_name: String,
    display_name: String,
) -> Result<User> {
    let q = query_as!(
        User,
        r#"
            UPDATE users
            SET login_name = $1, display_name = $2, updated_at = now()
            WHERE id = $3
            RETURNING
                id,
                login_name,
                password_hash,
                display_name,
                email,
                email_verified_at,
                created_at,
                updated_at,
                banner_id,
                preferred_language AS "preferred_language: _"
        "#,
        login_name,
        display_name,
        id,
    );
    let result = q.fetch_one(&mut **tx).await?;

    Ok(User {
        id: result.id,
        login_name: result.login_name,
        password_hash: result.password_hash,
        display_name: result.display_name,
        email: result.email,
        email_verified_at: result.email_verified_at,
        created_at: result.created_at,
        updated_at: result.updated_at,
        banner_id: result.banner_id,
        preferred_language: result.preferred_language,
    })
}

pub async fn update_user_with_activity(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    login_name: String,
    display_name: String,
    config: &AppConfig,
    state: Option<&crate::web::state::AppState>,
) -> Result<User> {
    // First update the user
    let updated_user = update_user(tx, id, login_name.clone(), display_name.clone()).await?;

    // Update the corresponding actor
    let _ = super::actor::update_actor_for_user(tx, id, login_name, display_name, config).await;

    // If state is provided, send ActivityPub Update activity
    if let Some(state) = state {
        // Get the updated actor
        if let Some(updated_actor) = super::actor::Actor::find_by_user_id(tx, id).await? {
            // Send Update activity - don't fail if this fails
            if let Err(e) =
                crate::web::handlers::activitypub::send_update_activity(&updated_actor, state).await
            {
                tracing::warn!("Failed to send Update activity for user {}: {:?}", id, e);
            }
        }
    }

    Ok(updated_user)
}

pub async fn create_user(
    tx: &mut Transaction<'_, Postgres>,
    user_draft: UserDraft,
    config: &AppConfig,
) -> Result<User> {
    let q = query!(
        "
            INSERT INTO users (
                login_name,
                password_hash,
                display_name
            )
            VALUES ($1, $2, $3)
            RETURNING id, created_at, updated_at
        ",
        user_draft.login_name,
        user_draft.password_hash.to_string(),
        user_draft.display_name,
    );
    let result = q.fetch_one(&mut **tx).await?;

    let user = User {
        id: result.id,
        login_name: user_draft.login_name,
        password_hash: user_draft.password_hash,
        display_name: user_draft.display_name,
        email: None,
        email_verified_at: None,
        created_at: result.created_at,
        updated_at: result.updated_at,
        banner_id: None,
        preferred_language: None,
    };

    // Create actor for the user
    create_actor_for_user(tx, &user, config).await?;

    Ok(user)
}

pub async fn find_user_by_id(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<Option<User>> {
    let q = query_as!(
        User,
        r#"
        SELECT
            id,
            login_name,
            password_hash,
            display_name,
            email,
            email_verified_at,
            created_at,
            updated_at,
            banner_id,
            preferred_language AS "preferred_language: _"
        FROM users
        WHERE id = $1"#,
        id
    );
    Ok(q.fetch_optional(&mut **tx).await?)
}

pub async fn find_user_by_login_name(
    tx: &mut Transaction<'_, Postgres>,
    login_name: &str,
) -> Result<Option<User>> {
    let q = query_as!(
        User,
        r#"
        SELECT
            id,
            login_name,
            password_hash,
            display_name,
            email,
            email_verified_at,
            created_at,
            updated_at,
            banner_id,
            preferred_language AS "preferred_language: _"
        FROM users
        WHERE login_name = $1"#,
        login_name
    );
    Ok(q.fetch_optional(&mut **tx).await?)
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct UserWithPublicPostAndBanner {
    pub login_name: String,
    pub display_name: String,
    pub banner_image_filename: String,
}

pub async fn find_users_with_public_posts_and_banner(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<Vec<UserWithPublicPostAndBanner>> {
    let q = query_as!(
        UserWithPublicPostAndBanner,
        r#"
        SELECT
            u.login_name,
            u.display_name,
            i.image_filename AS banner_image_filename
        FROM users u
        JOIN posts p ON u.id = p.author_id
        JOIN communities c ON p.community_id = c.id
        JOIN banners b ON u.banner_id = b.id
        JOIN images i ON b.image_id = i.id
        WHERE p.published_at IS NOT NULL
        AND c.visibility = 'public'
        GROUP BY u.id, banner_image_filename
        ORDER BY count(p.id) DESC
        "#,
    );
    Ok(q.fetch_all(&mut **tx).await?)
}

impl AuthUser for User {
    type Id = Uuid;

    fn id(&self) -> Self::Id {
        self.id
    }

    fn session_auth_hash(&self) -> &[u8] {
        self.id.as_bytes()
    }
}

#[derive(Clone, Deserialize)]
pub struct Credentials {
    pub login_name: String,
    pub password: String,
    pub next: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Backend {
    pub db: PgPool,
}

#[async_trait]
impl AuthnBackend for Backend {
    type User = User;
    type Credentials = Credentials;
    type Error = sqlx::Error;

    async fn authenticate(
        &self,
        creds: Self::Credentials,
    ) -> Result<Option<Self::User>, Self::Error> {
        let q = query_as!(
            User,
            r#"
            SELECT
                id,
                login_name,
                password_hash,
                display_name,
                email,
                email_verified_at,
                created_at,
                updated_at,
                banner_id,
                preferred_language AS "preferred_language: _"
            FROM users
            WHERE login_name = $1"#,
            creds.login_name
        );
        let user = q.fetch_optional(&self.db).await?;

        Ok(user.filter(|user| user.verify_password(&creds.password).is_ok()))
    }

    async fn get_user(&self, user_id: &UserId<Self>) -> Result<Option<Self::User>, Self::Error> {
        let q = query_as!(
            User,
            r#"SELECT
                id,
                login_name,
                password_hash,
                display_name,
                email,
                email_verified_at,
                created_at,
                updated_at,
                banner_id,
                preferred_language AS "preferred_language: _"
            FROM users
            WHERE id = $1"#,
            user_id
        );
        Ok(q.fetch_optional(&self.db).await?)
    }
}

pub type AuthSession = axum_login::AuthSession<Backend>;
