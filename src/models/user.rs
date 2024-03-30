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
use sqlx::{query, query_as, PgPool, Postgres, Transaction};

pub struct UserDraft {
    pub login_name: String,
    pub password_hash: String,
    pub display_name: String,
    pub email: String,
}

impl UserDraft {
    pub fn new(
        login_name: String,
        password: String,
        display_name: String,
        email: String,
    ) -> Result<Self> {
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
            email,
        })
    }
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct User {
    pub id: Uuid,
    pub login_name: String,
    #[serde(skip_serializing)]
    pub password_hash: String,
    pub display_name: String,
    pub email: String,
    pub email_verified_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

impl User {
    pub fn verify_password(&self, password: &str) -> Result<(), argon2::password_hash::Error> {
        let argon2 = Argon2::default();
        let pwstr = PasswordHashString::new(&self.password_hash)?;
        let password_hash = pwstr.password_hash();
        argon2.verify_password(password.as_bytes(), &password_hash)
    }
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

    let q = query!(
        "
            UPDATE users
            SET password_hash = $1, updated_at = now()
            WHERE id = $2
            RETURNING id, login_name, password_hash, display_name, email, email_verified_at, created_at, updated_at
        ",
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
    })
}

pub async fn update_user(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    display_name: String,
    email: String,
) -> Result<User> {
    let q = query!(
        "
            UPDATE users
            SET display_name = $1, email = $2, updated_at = now()
            WHERE id = $3
            RETURNING id, login_name, password_hash, display_name, email, email_verified_at, created_at, updated_at
        ",
        display_name,
        email,
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
    })
}

pub async fn create_user(
    tx: &mut Transaction<'_, Postgres>,
    user_draft: UserDraft,
) -> Result<User> {
    let q = query!(
        "
            INSERT INTO users (
                login_name,
                password_hash,
                display_name,
                email
            )
            VALUES ($1, $2, $3, $4)
            RETURNING id, created_at, updated_at
        ",
        user_draft.login_name,
        user_draft.password_hash.to_string(),
        user_draft.display_name,
        user_draft.email,
    );
    let result = q.fetch_one(&mut **tx).await?;

    Ok(User {
        id: result.id,
        login_name: user_draft.login_name,
        password_hash: user_draft.password_hash,
        display_name: user_draft.display_name,
        email: user_draft.email,
        email_verified_at: None,
        created_at: result.created_at,
        updated_at: result.updated_at,
    })
}

pub async fn find_user_by_id(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<Option<User>> {
    let q = query_as!(User, "SELECT * FROM users WHERE id = $1", id);
    Ok(q.fetch_optional(&mut **tx).await?)
}

pub async fn find_user_by_login_name(
    tx: &mut Transaction<'_, Postgres>,
    login_name: &str,
) -> Result<Option<User>> {
    let q = query_as!(
        User,
        "SELECT * FROM users WHERE login_name = $1",
        login_name
    );
    Ok(q.fetch_optional(&mut **tx).await?)
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
            "SELECT * FROM users WHERE login_name = $1",
            creds.login_name
        );
        let user = q.fetch_optional(&self.db).await?;

        Ok(user.filter(|user| user.verify_password(&creds.password).is_ok()))
    }

    async fn get_user(&self, user_id: &UserId<Self>) -> Result<Option<Self::User>, Self::Error> {
        let q = query_as!(User, "SELECT * FROM users WHERE id = $1", user_id);
        Ok(q.fetch_optional(&self.db).await?)
    }
}

pub type AuthSession = axum_login::AuthSession<Backend>;
