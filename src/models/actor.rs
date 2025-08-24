use anyhow::Result;
use chrono::{DateTime, Utc};
use sqlx::{query, query_as, Postgres, Transaction};
use uuid::Uuid;

use crate::models::user::{find_user_by_id, User};
use crate::AppConfig;

#[derive(Clone, Debug)]
pub struct Actor {
    pub id: Uuid,
    pub iri: String,
    pub url: String,
    pub r#type: String,
    pub username: String,
    pub instance_host: String,
    pub handle_host: String,
    pub handle: String,
    pub user_id: Option<Uuid>,
    pub name: String,
    pub bio_html: String,
    pub automatically_approves_followers: bool,
    pub avatar_url: String,
    pub header_url: String,
    pub inbox_url: String,
    pub shared_inbox_url: String,
    pub followers_url: String,
    pub featured_url: String,
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

    // Generate RSA keypair for ActivityPub
    let keypair = generate_actor_keypair()?;
    let private_key_pem = keypair.private_key;
    let public_key_pem = keypair.public_key;

    let now = Utc::now();

    let iri = format!("https://{}/ap/users/{}", config.domain, user.id.to_string());
    let handle = format!("@{}@{}", user.login_name, config.domain);
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
    let featured_url = format!(
        "https://{}/ap/users/{}/collections/featured",
        config.domain,
        user.id.to_string()
    );
    let url = format!("https://{}/@{}", config.domain, user.login_name);

    let actor = query_as!(
        Actor,
        r#"
        INSERT INTO actors (
            iri, type, username, instance_host, handle_host, handle,
            user_id, name, bio_html, automatically_approves_followers,
            avatar_url, header_url, inbox_url, shared_inbox_url, followers_url,
            featured_url, sensitive, public_key_pem, private_key_pem, url,
            created_at, updated_at, published_at
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
        )
        RETURNING 
            id, iri, type, username, instance_host, handle_host, handle,
            user_id, name, bio_html, automatically_approves_followers,
            avatar_url, header_url, inbox_url, shared_inbox_url, followers_url,
            featured_url, sensitive, public_key_pem, private_key_pem, url,
            created_at, updated_at, published_at
        "#,
        iri,
        "Person",
        user.login_name,
        config.domain,
        config.domain,
        handle,
        user.id,
        user.display_name,
        "", // bio_html - empty for now
        true, // automatically_approves_followers
        "", // avatar_url - empty for now
        "", // header_url - empty for now
        inbox_url,
        shared_inbox_url,
        followers_url,
        featured_url,
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
    let user_ids = query!(
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
