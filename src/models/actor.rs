use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{query_as, Postgres, Transaction, Type};
use uuid::Uuid;

use crate::models::instance::find_or_create_local_instance;
use crate::models::user::{find_user_by_id, User};
use crate::AppConfig;

#[derive(Debug)]
struct UserIdRow {
    id: Option<Uuid>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[sqlx(type_name = "actor_type", rename_all = "PascalCase")]
pub enum ActorType {
    Person,
    Service,
    Group,
    Application,
    Organization,
}

impl std::fmt::Display for ActorType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ActorType::Person => write!(f, "Person"),
            ActorType::Service => write!(f, "Service"),
            ActorType::Group => write!(f, "Group"),
            ActorType::Application => write!(f, "Application"),
            ActorType::Organization => write!(f, "Organization"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Actor {
    pub id: Uuid,
    pub iri: String,
    pub url: String,
    pub r#type: ActorType,
    pub username: String,
    pub instance_host: String,
    pub handle_host: String,
    pub handle: String,
    pub user_id: Option<Uuid>,
    pub name: String,
    pub bio_html: String,
    pub automatically_approves_followers: bool,
    pub inbox_url: String,
    pub shared_inbox_url: String,
    pub followers_url: String,
    pub sensitive: bool,
    pub public_key_pem: String,
    pub private_key_pem: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub published_at: DateTime<Utc>,
}

pub async fn create_actor_for_user(
    tx: &mut Transaction<'_, Postgres>,
    user: &User,
    config: &AppConfig,
) -> Result<Actor> {
    use activitypub_federation::http_signatures::generate_actor_keypair;

    // Ensure local instance exists
    find_or_create_local_instance(tx, &config.domain, None, None).await?;

    // Generate RSA keypair for ActivityPub
    let keypair = generate_actor_keypair()?;
    let private_key_pem = keypair.private_key;
    let public_key_pem = keypair.public_key;

    let now = Utc::now();

    let iri = format!("https://{}/ap/users/{}", config.domain, user.id.to_string());
    let handle = format!("{}@{}", user.login_name, config.domain);
    let inbox_url = format!(
        "https://{}/ap/users/{}/inbox",
        config.domain,
        user.id.to_string()
    );
    let shared_inbox_url = format!("https://{}/ap/inbox", config.domain);
    let followers_url = format!(
        "https://{}/ap/users/{}/followers",
        config.domain,
        user.id.to_string()
    );
    let url = format!("https://{}/@{}", config.domain, user.login_name);

    let actor = query_as!(Actor,
        r#"
        INSERT INTO actors (
            iri, type, username, instance_host, handle_host, handle,
            user_id, name, bio_html, automatically_approves_followers,
            inbox_url, shared_inbox_url, followers_url,
            sensitive, public_key_pem, private_key_pem, url,
            created_at, updated_at, published_at
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
        )
        RETURNING 
            id, iri, type as "type: _", username, instance_host, handle_host, handle,
            user_id, name, bio_html, automatically_approves_followers,
            inbox_url, shared_inbox_url, followers_url,
            sensitive, public_key_pem, private_key_pem, url,
            created_at, updated_at, published_at
        "#,
        iri,
        ActorType::Person as _,
        user.login_name,
        config.domain,
        config.domain,
        handle,
        user.id,
        user.display_name,
        "", // bio_html - empty for now
        true, // automatically_approves_followers
        inbox_url,
        shared_inbox_url,
        followers_url,
        false, // sensitive
        public_key_pem,
        private_key_pem,
        url,
        now,
        now,
        now
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(actor)
}

pub async fn backfill_actors_for_existing_users(
    tx: &mut Transaction<'_, Postgres>,
    config: &AppConfig,
) -> Result<usize> {
    // Get user IDs who don't have actors
    let user_ids = query_as!(UserIdRow,
        r#"
        SELECT u.id
        FROM users u
        LEFT JOIN actors a ON u.id = a.user_id
        WHERE a.id IS NULL
        "#
    )
    .fetch_all(&mut **tx)
    .await?;

    let mut created_count = 0;
    for row in user_ids {
        if let Some(user_id) = row.id {
            if let Some(user) = find_user_by_id(tx, user_id).await? {
                create_actor_for_user(tx, &user, config).await?;
                created_count += 1;
            }
        }
    }

    Ok(created_count)
}
