use activitypub_federation::axum::json::FederationJson;
use activitypub_federation::config::Data;
use activitypub_federation::fetch::object_id::ObjectId;
use activitypub_federation::fetch::webfinger::{build_webfinger_response, extract_webfinger_name};
use activitypub_federation::kinds::actor::PersonType;
use activitypub_federation::protocol::context::WithContext;
use activitypub_federation::protocol::public_key::PublicKey;
use activitypub_federation::protocol::verification::verify_domains_match;
use activitypub_federation::traits::{Actor as ActivityPubFederationActor, Object};
use axum::extract::{Path, Query};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

use crate::app_error::AppError;
use crate::models::actor::{Actor, ActorType};
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
    instance_host: String,
    handle_host: String,
    handle: String,
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

        let user_id = Uuid::parse_str(&object_id.path_segments().unwrap().last().unwrap()).unwrap();
        let actor = Actor::find_by_user_id(&mut tx, user_id).await?;
        Ok(actor)
    }

    async fn into_json(self, data: &Data<Self::DataType>) -> Result<Self::Kind, Self::Error> {
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
            url: self.iri.parse()?,
            instance_host: self.instance_host.clone(),
            handle_host: self.handle_host.clone(),
            handle: self.handle.clone(),
        })
    }

    async fn verify(
        json: &Self::Kind,
        expected_domain: &Url,
        data: &Data<Self::DataType>,
    ) -> Result<(), Self::Error> {
        verify_domains_match(json.id.inner(), expected_domain)?;
        Ok(())
    }

    async fn from_json(json: Self::Kind, data: &Data<Self::DataType>) -> Result<Self, Self::Error> {
        Ok(Actor {
            name: json.name,
            iri: json.id.to_string(),
            inbox_url: json.inbox.to_string(),
            public_key_pem: json.public_key.public_key_pem,
            private_key_pem: None,
            id: Uuid::new_v4(),
            url: json.id.to_string(),
            r#type: ActorType::Person,
            username: json.preferred_username.clone(),
            instance_host: json.instance_host.to_string(),
            handle_host: json.handle_host.to_string(),
            handle: json.handle.to_string(),
            user_id: None,
            bio_html: String::new(),
            automatically_approves_followers: false,
            shared_inbox_url: String::new(),
            followers_url: String::new(),
            sensitive: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            published_at: Utc::now(),
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
    let user = find_user_by_login_name(&mut tx, &name).await?;
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
    header_map: HeaderMap,
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
