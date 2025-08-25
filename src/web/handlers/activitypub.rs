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

use activitystreams_kinds::activity::{AcceptType, AnnounceType, CreateType, FollowType, UndoType, UpdateType};
use activitystreams_kinds::actor::GroupType;
use activitystreams_kinds::object::NoteType;
use axum::extract::{Path, Query};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;
use uuid::Uuid;

use crate::app_error::AppError;
use crate::models::actor::{Actor, ActorType};
use crate::models::community::find_community_by_slug;
use crate::models::follow;
use crate::models::image::find_image_by_id;
use crate::models::post::find_post_by_id;
use crate::models::user::find_user_by_login_name;
use crate::web::state::AppState;

#[derive(Deserialize, Serialize, Debug, Clone)]
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

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    id: ObjectId<Actor>,
    r#type: GroupType,
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

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(untagged)]
pub enum ActorObject {
    Person(Person),
    Group(Group),
}

#[async_trait::async_trait]
impl Object for Actor {
    type DataType = AppState;
    type Kind = ActorObject;
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
            "sharedInbox": format!("https://{}/inbox", self.instance_host)
        });

        match self.r#type {
            ActorType::Group => Ok(ActorObject::Group(Group {
                id: ObjectId::parse(&self.iri)?,
                r#type: GroupType::Group,
                inbox: self.inbox_url.parse()?,
                public_key,
                endpoints,
                followers: self.followers_url.parse()?,
                manually_approves_followers: !self.automatically_approves_followers,
                name: self.name,
                outbox: format!("{}/outbox", self.iri).parse()?,
                preferred_username: self.username,
                url: self.url.parse()?,
            })),
            // Handle all other actor types as Person for ActivityPub compatibility
            ActorType::Person
            | ActorType::Service
            | ActorType::Application
            | ActorType::Organization => Ok(ActorObject::Person(Person {
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
            })),
        }
    }

    async fn verify(
        json: &Self::Kind,
        expected_domain: &Url,
        _data: &Data<Self::DataType>,
    ) -> Result<(), Self::Error> {
        let id = match json {
            ActorObject::Person(person) => &person.id,
            ActorObject::Group(group) => &group.id,
        };
        verify_domains_match(id.inner(), expected_domain)?;
        Ok(())
    }

    async fn from_json(
        json: Self::Kind,
        _data: &Data<Self::DataType>,
    ) -> Result<Self, Self::Error> {
        let (
            id,
            inbox,
            public_key,
            endpoints,
            followers,
            manually_approves_followers,
            name,
            preferred_username,
            url,
            actor_type,
        ) = match json {
            ActorObject::Person(person) => (
                person.id,
                person.inbox,
                person.public_key,
                person.endpoints,
                person.followers,
                person.manually_approves_followers,
                person.name,
                person.preferred_username,
                person.url,
                ActorType::Person,
            ),
            ActorObject::Group(group) => (
                group.id,
                group.inbox,
                group.public_key,
                group.endpoints,
                group.followers,
                group.manually_approves_followers,
                group.name,
                group.preferred_username,
                group.url,
                ActorType::Group,
            ),
        };

        // Parse instance host from the actor ID URL
        let actor_url = id.inner();
        let instance_host = actor_url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("Could not extract host from actor URL"))?
            .to_string();

        // Create handle components
        let handle_host = instance_host.clone();
        let handle = format!("@{}@{}", preferred_username, handle_host);

        // Get shared inbox URL from endpoints if available, otherwise use main inbox
        let shared_inbox_url = endpoints
            .get("sharedInbox")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| inbox.as_str())
            .to_string();

        Ok(Actor {
            name,
            iri: id.to_string(),
            inbox_url: inbox.to_string(),
            public_key_pem: public_key.public_key_pem,
            private_key_pem: None,
            id: Uuid::new_v4(),
            url: url.to_string(),
            r#type: actor_type,
            username: preferred_username.clone(),
            instance_host,
            handle_host,
            handle,
            user_id: None,
            community_id: None,
            bio_html: String::new(),
            automatically_approves_followers: !manually_approves_followers,
            shared_inbox_url,
            followers_url: followers.to_string(),
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
    let db = data.app_data().config.connect_database().await?;
    let mut tx = db.begin().await?;

    // First, try to find a user with this login name
    let user = find_user_by_login_name(&mut tx, name).await?;
    if let Some(user) = user {
        let actor = Actor::find_by_user_id(&mut tx, user.id).await?;
        if let Some(actor) = actor {
            return Ok(Json(build_webfinger_response(
                query.resource,
                actor.iri.parse().unwrap(),
            ))
            .into_response());
        }
    }

    // If no user found, try to find a community with this slug
    let community = find_community_by_slug(&mut tx, name.to_string()).await?;
    if let Some(community) = community {
        let actor = Actor::find_by_community_id(&mut tx, community.id).await?;
        if let Some(actor) = actor {
            return Ok(Json(build_webfinger_response(
                query.resource,
                actor.iri.parse().unwrap(),
            ))
            .into_response());
        }
    }

    // Neither user nor community found
    Ok((StatusCode::NOT_FOUND, "User or community not found").into_response())
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
        let context = [
            "https://www.w3.org/ns/activitystreams",
            "https://w3id.org/security/v1",
        ];

        let activity = WithContext::new(
            json_actor,
            serde_json::Value::Array(
                context
                    .into_iter()
                    .map(|s| serde_json::Value::String(s.to_string()))
                    .collect(),
            ),
        );
        Ok(FederationJson(activity).into_response())
    } else {
        Ok((StatusCode::NOT_FOUND, "Actor not found").into_response())
    }
}

pub async fn activitypub_get_community(
    _header_map: HeaderMap,
    Path(community_id): Path<String>,
    data: Data<AppState>,
) -> Result<impl IntoResponse, AppError> {
    let db = data.app_data().config.connect_database().await?;
    let mut tx = db.begin().await?;

    if let Some(actor) =
        Actor::find_by_community_id(&mut tx, Uuid::parse_str(&community_id).unwrap()).await?
    {
        let json_actor = actor.into_json(&data).await?;
        let context = [
            "https://www.w3.org/ns/activitystreams",
            "https://w3id.org/security/v1",
        ];

        let activity = WithContext::new(
            json_actor,
            serde_json::Value::Array(
                context
                    .into_iter()
                    .map(|s| serde_json::Value::String(s.to_string()))
                    .collect(),
            ),
        );
        Ok(FederationJson(activity).into_response())
    } else {
        Ok((StatusCode::NOT_FOUND, "Actor not found").into_response())
    }
}

pub async fn activitypub_get_post(
    _header_map: HeaderMap,
    Path(post_id): Path<String>,
    data: Data<AppState>,
) -> Result<impl IntoResponse, AppError> {
    let db = data.app_data().config.connect_database().await?;
    let mut tx = db.begin().await?;

    let post_uuid = Uuid::parse_str(&post_id)?;

    if let Some(post) = find_post_by_id(&mut tx, post_uuid).await? {
        let author_id = Uuid::parse_str(post.get("author_id").unwrap().as_ref().unwrap())?;

        // Find the author's actor
        let author_actor = Actor::find_by_user_id(&mut tx, author_id).await?;
        if author_actor.is_none() {
            return Ok((StatusCode::NOT_FOUND, "Author actor not found").into_response());
        }
        let author_actor = author_actor.unwrap();

        // Use the shared function to create the Note
        let note = create_note_from_post(
            &mut tx,
            post_uuid,
            &author_actor,
            &data.app_data().config.domain,
            &data.app_data().config.r2_public_endpoint_url,
        )
        .await?;

        let context = [
            "https://www.w3.org/ns/activitystreams",
            "https://w3id.org/security/v1",
        ];

        Ok(FederationJson(WithContext::new(
            note,
            Value::Array(
                context
                    .into_iter()
                    .map(|s| Value::String(s.to_string()))
                    .collect(),
            ),
        ))
        .into_response())
    } else {
        Ok((StatusCode::NOT_FOUND, "Post not found").into_response())
    }
}

pub async fn activitypub_post_user_inbox(
    data: Data<AppState>,
    activity_data: ActivityData,
) -> impl IntoResponse {
    receive_activity::<WithContext<PersonAcceptedActivities>, Actor, AppState>(activity_data, &data)
        .await
}

pub async fn activitypub_post_community_inbox(
    data: Data<AppState>,
    activity_data: ActivityData,
) -> impl IntoResponse {
    receive_activity::<WithContext<GroupAcceptedActivities>, Actor, AppState>(activity_data, &data)
        .await
}

/// List of all activities which this actor can receive.
#[derive(Deserialize, Serialize, Debug)]
#[serde(untagged)]
#[enum_delegate::implement(ActivityHandler)]
pub enum PersonAcceptedActivities {
    Follow(Follow),
    Undo(Undo),
    Update(Update),
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(untagged)]
#[enum_delegate::implement(ActivityHandler)]
pub enum GroupAcceptedActivities {
    Follow(Follow),
    Undo(Undo),
    Update(Update),
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
        tracing::info!("self.object: {:?}", self.object);
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

#[derive(Deserialize, Serialize, Clone, Debug)]
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

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub r#type: String,
    pub url: String,
    pub media_type: String,
    pub name: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: Url,
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

#[derive(Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Announce {
    actor: ObjectId<Actor>,
    object: Url,
    r#type: AnnounceType,
    id: Url,
    to: Vec<String>,
    cc: Vec<String>,
    published: String,
}

impl Announce {
    pub fn new(
        actor: ObjectId<Actor>,
        object: Url,
        id: Url,
        to: Vec<String>,
        cc: Vec<String>,
        published: String,
    ) -> Announce {
        Announce {
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
impl ActivityHandler for Announce {
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
        // Announce activities are typically sent outbound, not received
        // If we wanted to handle incoming Announce activities (e.g., boosts from other servers),
        // we would implement the logic here
        tracing::info!("Received Announce activity: {:?}", self);
        Ok(())
    }
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    actor: ObjectId<Actor>,
    object: ActorObject,
    r#type: UpdateType,
    id: Url,
    to: Vec<String>,
    cc: Vec<String>,
    published: String,
}

impl Update {
    pub fn new(
        actor: ObjectId<Actor>,
        object: ActorObject,
        id: Url,
        to: Vec<String>,
        cc: Vec<String>,
        published: String,
    ) -> Update {
        Update {
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
impl ActivityHandler for Update {
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
        // Update activities notify followers about actor profile changes
        // We would typically update our local copy of the actor here
        tracing::info!("Received Update activity: {:?}", self);
        
        let db = data.app_data().config.connect_database().await?;
        let mut tx = db.begin().await?;
        
        // Find the actor being updated
        let actor = Actor::find_by_iri(&mut tx, self.actor.to_string()).await?;
        if let Some(mut actor) = actor {
            // Update actor fields based on the object
            match &self.object {
                ActorObject::Person(person) => {
                    actor.name = person.name.clone();
                    actor.username = person.preferred_username.clone();
                    actor.url = person.url.to_string();
                }
                ActorObject::Group(group) => {
                    actor.name = group.name.clone(); 
                    actor.username = group.preferred_username.clone();
                    actor.url = group.url.to_string();
                }
            }
            
            // Update the actor in the database
            Actor::create_or_update_actor(&mut tx, &actor).await?;
            tx.commit().await?;
        }
        
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

pub async fn create_note_from_post(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    post_id: Uuid,
    author_actor: &Actor,
    domain: &str,
    r2_public_endpoint_url: &str,
) -> Result<Note, AppError> {
    // Get post details
    let post = find_post_by_id(tx, post_id).await?;
    let post = post.ok_or_else(|| anyhow::anyhow!("Post not found"))?;

    // Get title and content
    let title = post.get("title").and_then(|t| t.as_ref()).map_or("", |v| v);
    let content = post
        .get("content")
        .and_then(|c| c.as_ref())
        .map_or("", |v| v);

    // Format content with title if available
    let formatted_content = if title.is_empty() {
        content.to_string()
    } else {
        format!("<p>{}</p><p>{}</p>", title, content)
    };

    // Get attachments if image exists
    let mut attachments = Vec::new();
    if let Some(Some(image_id_str)) = post.get("image_id") {
        if let Ok(image_id) = Uuid::parse_str(image_id_str) {
            if let Ok(image) = find_image_by_id(tx, image_id).await {
                let image_url = format!(
                    "{}/image/{}{}/{}",
                    r2_public_endpoint_url,
                    image.image_filename.chars().next().unwrap_or('0'),
                    image.image_filename.chars().nth(1).unwrap_or('0'),
                    image.image_filename
                );

                let attachment = Attachment {
                    r#type: "Image".to_string(),
                    url: image_url,
                    media_type: "image/png".to_string(),
                    name: Some(title.to_string()),
                    width: Some(image.width),
                    height: Some(image.height),
                };
                attachments.push(attachment);
            }
        }
    }

    // Create URLs and IDs
    let post_url: Url =
        format!("https://{}/@{}/{}", domain, author_actor.username, post_id).parse()?;

    let note_id: Url = format!("https://{}/ap/posts/{}", domain, post_id).parse()?;

    // Set up audience - public post
    let to = vec!["https://www.w3.org/ns/activitystreams#Public".to_string()];
    let cc = vec![format!("{}/followers", author_actor.iri)];

    // Get published date
    let published = post.get("published_at_utc").unwrap();

    // Create the Note object
    let note = Note::new(
        note_id,
        ObjectId::<Actor>::parse(&author_actor.iri)?,
        formatted_content,
        to,
        cc,
        published.clone().unwrap_or_default(),
        post_url,
        attachments,
    );

    Ok(note)
}

pub async fn send_update_activity(
    actor: &Actor,
    app_state: &crate::web::state::AppState,
) -> Result<(), AppError> {
    use crate::models::follow::get_follower_shared_inboxes_for_actor;
    use activitypub_federation::config::FederationConfig;
    
    let db = app_state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    
    // Get follower inboxes
    let follower_inboxes = get_follower_shared_inboxes_for_actor(&mut tx, actor.id).await?;
    tx.commit().await?;
    
    if follower_inboxes.is_empty() {
        return Ok(());
    }
    
    // Convert inboxes to Urls
    let inbox_urls: Result<Vec<Url>, _> = follower_inboxes
        .into_iter()
        .map(|inbox| inbox.parse::<Url>())
        .collect();
    let inbox_urls = inbox_urls?;
    
    // Create federation config and data
    let federation_config = FederationConfig::builder()
        .domain(app_state.config.domain.clone())
        .app_data(app_state.clone())
        .build()
        .await?;
    let federation_data = federation_config.to_request_data();
    
    // Create the updated actor object
    let actor_object = actor.clone().into_json(&federation_data).await?;
    
    // Generate activity ID
    let activity_id = generate_object_id(&app_state.config.domain)?;
    
    // Set up audience - public update
    let to = vec!["https://www.w3.org/ns/activitystreams#Public".to_string()];
    let cc = vec![format!("{}/followers", actor.iri)];
    
    // Create Update activity
    let update_activity = Update::new(
        ObjectId::parse(&actor.iri)?,
        actor_object,
        activity_id,
        to,
        cc,
        chrono::Utc::now().to_rfc3339(),
    );
    
    // Send the activity to followers
    actor.send(
        update_activity,
        inbox_urls,
        false, // Don't use queue for now
        &federation_data,
    ).await?;
    
    Ok(())
}
