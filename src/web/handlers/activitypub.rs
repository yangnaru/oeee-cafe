use activitypub_federation::axum::inbox::{receive_activity, ActivityData};
use activitypub_federation::axum::json::FederationJson;
use activitypub_federation::config::Data;
use activitypub_federation::fetch::object_id::ObjectId;
use activitypub_federation::fetch::webfinger::{build_webfinger_response, extract_webfinger_name};
use activitypub_federation::kinds::actor::PersonType;
use activitypub_federation::protocol::context::WithContext;
use activitypub_federation::protocol::public_key::PublicKey;
use activitypub_federation::protocol::verification::verify_domains_match;
use activitypub_federation::traits::{
    ActivityHandler, Actor as ActivityPubFederationActor, Object,
};

use activitystreams_kinds::activity::{AcceptType, CreateType, FollowType, UndoType};
use activitystreams_kinds::object::NoteType;
use axum::extract::{Path, Query};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

use crate::app_error::AppError;
use crate::models::actor::{Actor, ActorType};
use crate::models::follow;
use crate::models::user::find_user_by_login_name;
use crate::web::state::AppState;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    id: ObjectId<Actor>,
    r#type: PersonType,
    preferred_username: String,
    name: String,
    inbox: Url,
    outbox: Url,
    public_key: PublicKey,
    endpoints: serde_json::Value,
    followers: Url,
    manually_approves_followers: bool,
    url: Url,
}

#[async_trait::async_trait]
impl Object for Actor {
    type DataType = AppState;
    type Kind = Person;
    type Error = AppError;

    async fn read_from_id(
        object_id: Url,
        data: &Data<Self::DataType>,
    ) -> Result<Option<Self>, Self::Error> {
        let db = data.app_data().config.connect_database().await?;
        let mut tx = db.begin().await?;

        let actor = Actor::find_by_iri(&mut tx, object_id.to_string()).await?;
        Ok(actor)
    }

    async fn into_json(self, _data: &Data<Self::DataType>) -> Result<Self::Kind, Self::Error> {
        let public_key = PublicKey {
            id: format!("{}#main-key", self.iri).parse().unwrap(),
            owner: self.iri.parse().unwrap(),
            public_key_pem: self.public_key_pem,
        };

        let endpoints = serde_json::json!({
            "type": "as:Endpoints",
            "sharedInbox": "https://typo.blue/inbox"
        });

        Ok(Person {
            id: ObjectId::parse(&self.iri)?,
            r#type: PersonType::Person,
            inbox: self.inbox_url.parse()?,
            public_key,
            endpoints,
            followers: self.followers_url.parse()?,
            manually_approves_followers: !self.automatically_approves_followers,
            name: self.name,
            outbox: format!("{}/outbox", self.iri).parse()?,
            preferred_username: self.username,
            url: self.url.parse()?,
        })
    }

    async fn verify(
        json: &Self::Kind,
        expected_domain: &Url,
        _data: &Data<Self::DataType>,
    ) -> Result<(), Self::Error> {
        verify_domains_match(json.id.inner(), expected_domain)?;
        Ok(())
    }

    async fn from_json(
        json: Self::Kind,
        _data: &Data<Self::DataType>,
    ) -> Result<Self, Self::Error> {
        // Parse instance host from the actor ID URL
        let actor_url = json.id.inner();
        let instance_host = actor_url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("Could not extract host from actor URL"))?
            .to_string();

        // Create handle components
        let handle_host = instance_host.clone();
        let handle = format!("@{}@{}", json.preferred_username, handle_host);

        // Get shared inbox URL from endpoints if available, otherwise use main inbox
        let shared_inbox_url = json
            .endpoints
            .get("sharedInbox")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| json.inbox.as_str())
            .to_string();

        Ok(Actor {
            name: json.name,
            iri: json.id.to_string(),
            inbox_url: json.inbox.to_string(),
            public_key_pem: json.public_key.public_key_pem,
            private_key_pem: None,
            id: Uuid::new_v4(),
            url: json.url.to_string(),
            r#type: ActorType::Person,
            username: json.preferred_username.clone(),
            instance_host,
            handle_host,
            handle,
            user_id: None,
            community_id: None,
            bio_html: String::new(),
            automatically_approves_followers: !json.manually_approves_followers,
            shared_inbox_url,
            followers_url: json.followers.to_string(),
            sensitive: false,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            published_at: chrono::Utc::now(),
        })
    }
}

impl ActivityPubFederationActor for Actor {
    fn id(&self) -> url::Url {
        self.iri.parse().unwrap()
    }

    fn public_key_pem(&self) -> &str {
        &self.public_key_pem
    }

    fn private_key_pem(&self) -> Option<String> {
        self.private_key_pem.clone()
    }

    fn inbox(&self) -> Url {
        self.inbox_url.parse().unwrap()
    }
}

#[derive(Deserialize)]
pub struct WebfingerQuery {
    resource: String,
}

pub async fn activitypub_webfinger(
    Query(query): Query<WebfingerQuery>,
    data: Data<AppState>,
) -> Result<impl IntoResponse, AppError> {
    let name = extract_webfinger_name(&query.resource, &data)?;
    let user = data.app_data().config.connect_database().await?;
    let mut tx = user.begin().await?;
    let user = find_user_by_login_name(&mut tx, name).await?;
    if user.is_none() {
        return Ok((StatusCode::NOT_FOUND, "User not found").into_response());
    }

    let actor = Actor::find_by_user_id(&mut tx, user.unwrap().id).await?;

    if let Some(actor) = actor {
        Ok(Json(build_webfinger_response(
            query.resource,
            actor.iri.parse().unwrap(),
        ))
        .into_response())
    } else {
        Ok((StatusCode::NOT_FOUND, "Actor not found").into_response())
    }
}

pub async fn activitypub_get_user(
    _header_map: HeaderMap,
    Path(actor_id): Path<String>,
    data: Data<AppState>,
) -> Result<impl IntoResponse, AppError> {
    let db = data.app_data().config.connect_database().await?;
    let mut tx = db.begin().await?;

    if let Some(actor) =
        Actor::find_by_user_id(&mut tx, Uuid::parse_str(&actor_id).unwrap()).await?
    {
        let json_actor = actor.into_json(&data).await?;
        Ok(FederationJson(WithContext::new_default(json_actor)).into_response())
    } else {
        Ok((StatusCode::NOT_FOUND, "Actor not found").into_response())
    }
}

pub async fn activitypub_post_user_inbox(
    data: Data<AppState>,
    activity_data: ActivityData,
) -> impl IntoResponse {
    receive_activity::<WithContext<PersonAcceptedActivities>, Actor, AppState>(activity_data, &data)
        .await
}

/// List of all activities which this actor can receive.
#[derive(Deserialize, Serialize, Debug)]
#[serde(untagged)]
#[enum_delegate::implement(ActivityHandler)]
pub enum PersonAcceptedActivities {
    Follow(Follow),
    Undo(Undo),
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Follow {
    pub(crate) actor: ObjectId<Actor>,
    pub(crate) object: ObjectId<Actor>,
    #[serde(rename = "type")]
    r#type: FollowType,
    id: Url,
}

impl Follow {
    pub fn new(actor: ObjectId<Actor>, object: ObjectId<Actor>, id: Url) -> Follow {
        Follow {
            actor,
            object,
            r#type: Default::default(),
            id,
        }
    }
}

#[async_trait::async_trait]
impl ActivityHandler for Follow {
    type DataType = AppState;
    type Error = AppError;

    fn id(&self) -> &Url {
        &self.id
    }

    fn actor(&self) -> &Url {
        self.actor.inner()
    }

    async fn verify(&self, _data: &Data<Self::DataType>) -> Result<(), Self::Error> {
        Ok(())
    }

    // Ignore clippy false positive: https://github.com/rust-lang/rust-clippy/issues/6446
    #[allow(clippy::await_holding_lock)]
    async fn receive(self, data: &Data<Self::DataType>) -> Result<(), Self::Error> {
        tracing::info!("receive: {:?} {:?}", self.actor, self.object);

        // add to followers
        let db = data.app_data().config.connect_database().await?;
        let mut tx = db.begin().await?;

        // Find the target actor being followed
        let following_actor = Actor::find_by_iri(&mut tx, self.object.to_string()).await?;
        tracing::info!("following_actor: {:?}", following_actor);

        let following_actor =
            following_actor.ok_or_else(|| anyhow::anyhow!("Target actor not found"))?;

        // Dereference and persist the follower actor
        let follower_actor = self.actor.dereference(data).await?;
        tracing::info!("follower_actor: {:?}", follower_actor);

        let persisted_follower = match Actor::create_or_update_actor(&mut tx, &follower_actor).await
        {
            Ok(f) => f,
            Err(e) => {
                tracing::error!("Failed to persist follower actor: {:?}", e);
                return Err(e.into());
            }
        };
        tracing::info!("persisted_follower: {:?}", persisted_follower);

        // Create the follow relationship
        let follow_relation =
            follow::create_follow_by_actor_ids(&mut tx, persisted_follower.id, following_actor.id)
                .await?;
        tracing::info!("follow_relation: {:?}", follow_relation);

        // Commit the transaction before sending accept
        tx.commit().await?;

        // Send back an accept activity
        let id = generate_object_id(data.domain())?;
        let following_actor_object_id = ObjectId::parse(&following_actor.iri)?;
        let accept = Box::new(Accept::new(following_actor_object_id, self, id.clone()));
        following_actor
            .send(
                accept,
                vec![follower_actor.shared_inbox_or_inbox()],
                false,
                data,
            )
            .await?;

        Ok(())
    }
}

#[derive(Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Accept {
    actor: ObjectId<Actor>,
    object: Follow,
    r#type: AcceptType,
    id: Url,
}

impl Accept {
    pub fn new(actor: ObjectId<Actor>, object: Follow, id: Url) -> Accept {
        Accept {
            actor,
            object,
            r#type: Default::default(),
            id,
        }
    }
}

#[async_trait::async_trait]
impl ActivityHandler for Accept {
    type DataType = AppState;
    type Error = AppError;

    fn id(&self) -> &Url {
        &self.id
    }

    fn actor(&self) -> &Url {
        self.actor.inner()
    }

    async fn verify(&self, _data: &Data<Self::DataType>) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn receive(self, _data: &Data<Self::DataType>) -> Result<(), Self::Error> {
        // Accept activities are typically not processed when received
        // They're sent as responses to Follow activities
        Ok(())
    }
}

#[derive(Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Undo {
    actor: ObjectId<Actor>,
    object: Follow,
    r#type: UndoType,
    id: Url,
}

impl Undo {
    pub fn new(actor: ObjectId<Actor>, object: Follow, id: Url) -> Undo {
        Undo {
            actor,
            object,
            r#type: Default::default(),
            id,
        }
    }
}

#[async_trait::async_trait]
impl ActivityHandler for Undo {
    type DataType = AppState;
    type Error = AppError;

    fn id(&self) -> &Url {
        &self.id
    }

    fn actor(&self) -> &Url {
        self.actor.inner()
    }

    async fn verify(&self, _data: &Data<Self::DataType>) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn receive(self, data: &Data<Self::DataType>) -> Result<(), Self::Error> {
        tracing::info!("receive: {:?} {:?}", self.actor, self.object);

        // Remove the follow relationship from the database
        let db = data.app_data().config.connect_database().await?;
        let mut tx = db.begin().await?;

        // Find the target actor being unfollowed
        let following_actor = Actor::find_by_iri(&mut tx, self.object.object.to_string()).await?;
        let following_actor =
            following_actor.ok_or_else(|| anyhow::anyhow!("Target actor not found"))?;

        // Find the follower actor
        let follower_actor = Actor::find_by_iri(&mut tx, self.object.actor.to_string()).await?;
        let follower_actor =
            follower_actor.ok_or_else(|| anyhow::anyhow!("Follower actor not found"))?;

        // Remove the follow relationship
        follow::unfollow_by_actor_ids(&mut tx, follower_actor.id, following_actor.id).await?;
        tracing::info!(
            "Removed follow relationship: {} -> {}",
            follower_actor.iri,
            following_actor.iri
        );

        // Commit the transaction
        tx.commit().await?;

        Ok(())
    }
}

#[derive(Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub r#type: String,
    pub url: String,
    pub media_type: String,
    pub name: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

#[derive(Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    id: Url,
    r#type: NoteType,
    attributed_to: ObjectId<Actor>,
    content: String,
    to: Vec<String>,
    cc: Vec<String>,
    published: String,
    url: Url,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    attachment: Vec<Attachment>,
}

impl Note {
    pub fn new(
        id: Url,
        attributed_to: ObjectId<Actor>,
        content: String,
        to: Vec<String>,
        cc: Vec<String>,
        published: String,
        url: Url,
        attachment: Vec<Attachment>,
    ) -> Note {
        Note {
            id,
            r#type: Default::default(),
            attributed_to,
            content,
            to,
            cc,
            published,
            url,
            attachment,
        }
    }
}

#[derive(Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Create {
    actor: ObjectId<Actor>,
    object: Note,
    r#type: CreateType,
    id: Url,
    to: Vec<String>,
    cc: Vec<String>,
    published: String,
}

impl Create {
    pub fn new(
        actor: ObjectId<Actor>,
        object: Note,
        id: Url,
        to: Vec<String>,
        cc: Vec<String>,
        published: String,
    ) -> Create {
        Create {
            actor,
            object,
            r#type: Default::default(),
            id,
            to,
            cc,
            published,
        }
    }
}

#[async_trait::async_trait]
impl ActivityHandler for Create {
    type DataType = AppState;
    type Error = AppError;

    fn id(&self) -> &Url {
        &self.id
    }

    fn actor(&self) -> &Url {
        self.actor.inner()
    }

    async fn verify(&self, _data: &Data<Self::DataType>) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn receive(self, _data: &Data<Self::DataType>) -> Result<(), Self::Error> {
        // Create activities are typically sent outbound, not received
        // If we wanted to handle incoming Create activities (e.g., from other servers),
        // we would implement the logic here to store the post/note
        tracing::info!("Received Create activity: {:?}", self);
        Ok(())
    }
}

pub fn generate_object_id(domain: &str) -> Result<Url, AppError> {
    Ok(Url::parse(&format!(
        "https://{}/objects/{}",
        domain,
        Uuid::new_v4()
    ))?)
}
