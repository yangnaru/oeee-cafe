use crate::app_error::AppError;
use crate::models::actor::Actor;
use crate::models::comment::{create_comment, find_comments_by_post_id, CommentDraft};
use crate::models::community::{find_community_by_id, get_known_communities};
use crate::models::follow;
use crate::models::image::find_image_by_id;
use crate::models::post::{
    delete_post_with_activity, edit_post, edit_post_community, find_draft_posts_by_author_id,
    find_post_by_id, get_draft_post_count, increment_post_viewer_count, publish_post,
};
use crate::models::user::AuthSession;
use crate::web::handlers::activitypub::{
    create_note_from_post, create_updated_note_from_post, generate_object_id, Announce, Create,
    Note, UpdateNote,
};
use crate::web::handlers::{
    create_base_ftl_context, get_bundle, parse_id_with_legacy_support, ParsedId,
};
use crate::web::state::AppState;
use activitypub_federation::fetch::object_id::ObjectId;
use anyhow::Error;
use aws_sdk_s3::config::{Credentials as AwsCredentials, Region, SharedCredentialsProvider};
use aws_sdk_s3::types::{Delete, ObjectIdentifier};
use aws_sdk_s3::Client;
use axum::extract::Path;
use axum::http::{HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Redirect};
use axum::{extract::State, http::StatusCode, response::Html, Form};
use minijinja::context;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{handler_404, ExtractAcceptLanguage};

// Helper function to get community @slug URL from UUID
async fn get_community_slug_url(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    community_id: uuid::Uuid,
) -> Result<String, AppError> {
    let community = find_community_by_id(tx, community_id).await?;
    if let Some(community) = community {
        Ok(format!("/communities/@{}", community.slug))
    } else {
        Ok(format!("/communities/{}", community_id)) // Fallback to UUID if community not found
    }
}

async fn send_post_to_followers(
    actor: &Actor,
    post_id: Uuid,
    _title: String,
    _content: String,
    state: &AppState,
) -> Result<Note, AppError> {
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;

    // Get all followers for this actor
    let followers = follow::find_followers_by_actor_id(&mut tx, actor.id).await?;

    // Use the shared function to create the Note
    let note = create_note_from_post(
        &mut tx,
        post_id,
        actor,
        &state.config.domain,
        &state.config.r2_public_endpoint_url,
    )
    .await?;

    let actor_object_id = ObjectId::parse(&actor.iri)?;
    let to = vec!["https://www.w3.org/ns/activitystreams#Public".to_string()];
    let cc = vec![format!("{}/followers", actor.iri)];
    let published = chrono::Utc::now().to_rfc3339();

    tracing::info!("Note: {:?}", note);

    // Only send to followers if there are any
    if !followers.is_empty() {
        // Create the Create activity
        let activity_id = generate_object_id(&state.config.domain)?;
        let create = Create::new(
            actor_object_id,
            note.clone(),
            activity_id,
            to,
            cc,
            published,
        );

        // Get follower inboxes
        let follower_inboxes: Vec<url::Url> = followers
            .iter()
            .map(|follower| follower.inbox_url.parse())
            .collect::<Result<Vec<_>, _>>()?;

        if !follower_inboxes.is_empty() {
            // For now, we'll create a minimal federation config to send activities
            // In a production setup, this would be properly integrated with the federation middleware
            let federation_config = activitypub_federation::config::FederationConfig::builder()
                .domain(&state.config.domain)
                .app_data(state.clone())
                .build()
                .await?;
            let federation_data = federation_config.to_request_data();

            // Send to all followers
            actor
                .send(create, follower_inboxes, false, &federation_data)
                .await?;
            tracing::info!(
                "Sent Create activity for post {} to {} followers",
                post_id,
                followers.len()
            );
        }
    } else {
        tracing::info!(
            "No followers found for actor {}, skipping ActivityPub post",
            actor.iri
        );
    }

    tx.commit().await?;
    Ok(note)
}

async fn send_post_to_community_followers(
    _user_actor: &Actor,
    community_id: Uuid,
    note: &Note,
    state: &AppState,
) -> Result<(), AppError> {
    // Print note
    tracing::info!("Note: {:?}", note);

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;

    // Find the community's actor, create one if it doesn't exist
    let mut community_actor = Actor::find_by_community_id(&mut tx, community_id).await?;
    if community_actor.is_none() {
        // Community doesn't have an actor yet, create one
        let community = find_community_by_id(&mut tx, community_id).await?;
        if let Some(community) = community {
            tracing::info!(
                "Creating actor for community {} as it doesn't exist",
                community_id
            );
            match crate::models::actor::create_actor_for_community(
                &mut tx,
                &community,
                &state.config,
            )
            .await
            {
                Ok(new_actor) => community_actor = Some(new_actor),
                Err(e) => {
                    tracing::error!(
                        "Failed to create actor for community {}: {:?}",
                        community_id,
                        e
                    );
                    return Ok(());
                }
            }
        } else {
            tracing::error!("Community {} not found", community_id);
            return Ok(());
        }
    }

    if let Some(community_actor) = community_actor {
        // Get all followers for the community actor
        let followers = follow::find_followers_by_actor_id(&mut tx, community_actor.id).await?;

        if followers.is_empty() {
            tracing::info!(
                "No followers found for community actor {}, skipping ActivityPub post",
                community_actor.iri
            );
            tx.commit().await?;
            return Ok(());
        }

        // Create the Announce activity referencing the user's original note
        let note_id = note.id.clone();
        let community_actor_object_id = ObjectId::<Actor>::parse(&community_actor.iri)?;

        let published = chrono::Utc::now().to_rfc3339();

        // For the Announce activity, the audience should be the community's followers
        let to = vec!["https://www.w3.org/ns/activitystreams#Public".to_string()];
        let cc = vec![
            format!("{}/followers", community_actor.iri), // Community's followers
        ];

        // Create the Announce activity where the community announces the user's post
        let announce_activity_id = generate_object_id(&state.config.domain)?;
        let announce = Announce::new(
            community_actor_object_id,
            note_id.clone(), // The URL of the original post being announced
            announce_activity_id,
            to.clone(),
            cc.clone(),
            published.clone(),
        );

        // Get follower inboxes (community followers)
        let follower_inboxes: Vec<url::Url> = followers
            .iter()
            .map(|follower| follower.inbox_url.parse())
            .collect::<Result<Vec<_>, _>>()?;

        if !follower_inboxes.is_empty() {
            // Create federation config to send activities
            let federation_config = activitypub_federation::config::FederationConfig::builder()
                .domain(&state.config.domain)
                .app_data(state.clone())
                .build()
                .await?;
            let federation_data = federation_config.to_request_data();

            // Send to all community followers using the community actor (announcing the user's post)
            community_actor
                .send(announce, follower_inboxes, false, &federation_data)
                .await?;
            tracing::info!(
                "Sent Announce activity for note {} to {} community followers",
                note_id,
                followers.len()
            );
        }
    } else {
        tracing::info!(
            "No actor found for community {}, skipping community followers ActivityPub",
            community_id
        );
    }

    tx.commit().await?;
    Ok(())
}

pub async fn post_relay_view(
    auth_session: AuthSession,
    State(state): State<AppState>,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let uuid = match parse_id_with_legacy_support(&id, "/posts", &state)? {
        ParsedId::Uuid(uuid) => uuid,
        ParsedId::Redirect(redirect) => return Ok(redirect.into_response()),
        ParsedId::InvalidId(error_response) => return Ok(error_response),
    };
    let db = state.config.connect_database().await.unwrap();
    let mut tx: sqlx::Transaction<'_, sqlx::Postgres> = db.begin().await.unwrap();
    let post = find_post_by_id(&mut tx, uuid).await.unwrap();

    if post.is_none() {
        return Ok((
            StatusCode::NOT_FOUND,
            handler_404(
                auth_session,
                ExtractAcceptLanguage(accept_language),
                State(state),
            )
            .await?,
        )
            .into_response());
    }

    let template: minijinja::Template<'_, '_> =
        state.env.get_template("draw_post_neo.jinja").unwrap();
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let community_id = Uuid::parse_str(
        post.clone()
            .unwrap()
            .get("community_id")
            .unwrap()
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    let community = find_community_by_id(&mut tx, community_id).await?.unwrap();
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        parent_post => post.clone().unwrap(),
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        community_name => community.name,
        width => post.clone().unwrap().get("image_width").unwrap().as_ref().unwrap().parse::<u32>()?,
        height => post.unwrap().get("image_height").unwrap().as_ref().unwrap().parse::<u32>()?,
        background_color => community.background_color,
        foreground_color => community.foreground_color,
        community_id => community_id.to_string(),
        draft_post_count,
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn post_view(
    auth_session: AuthSession,
    headers: HeaderMap,
    State(state): State<AppState>,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let uuid = match parse_id_with_legacy_support(&id, "/posts", &state)? {
        ParsedId::Uuid(uuid) => uuid,
        ParsedId::Redirect(redirect) => return Ok(redirect.into_response()),
        ParsedId::InvalidId(error_response) => return Ok(error_response),
    };
    let db = state.config.connect_database().await.unwrap();
    let mut tx: sqlx::Transaction<'_, sqlx::Postgres> = db.begin().await.unwrap();
    let post = find_post_by_id(&mut tx, uuid).await.unwrap();

    match post {
        Some(_) => {
            increment_post_viewer_count(&mut tx, uuid).await.unwrap();
        }
        None => {
            return Ok((
                StatusCode::NOT_FOUND,
                handler_404(
                    auth_session,
                    ExtractAcceptLanguage(accept_language),
                    State(state),
                )
                .await?,
            )
                .into_response());
        }
    }

    let comments = find_comments_by_post_id(&mut tx, uuid).await.unwrap();

    // Get parent post data if it exists
    let parent_post_author_login_name = if let Some(parent_post_id_str) = post
        .clone()
        .unwrap()
        .get("parent_post_id")
        .and_then(|id| id.as_ref())
    {
        if let Ok(parent_uuid) = Uuid::parse_str(parent_post_id_str) {
            find_post_by_id(&mut tx, parent_uuid)
                .await
                .unwrap_or(None)
                .and_then(|parent_post| parent_post.get("login_name").cloned())
                .flatten()
                .unwrap_or_default()
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    let community_id = Uuid::parse_str(
        post.clone()
            .as_ref()
            .unwrap()
            .get("community_id")
            .unwrap()
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    // Get collaborative session participants if this post is from a collaborative session
    let collaborative_participants: Vec<CollaborativeParticipant> = sqlx::query!(
        r#"
        SELECT u.login_name, u.display_name
        FROM collaborative_sessions cs
        JOIN collaborative_sessions_participants csp ON cs.id = csp.session_id
        JOIN users u ON csp.user_id = u.id
        WHERE cs.saved_post_id = $1
        ORDER BY csp.joined_at ASC
        "#,
        uuid
    )
    .fetch_all(&mut *tx)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|row| CollaborativeParticipant {
        login_name: row.login_name,
        display_name: row.display_name,
    })
    .collect();

    tx.commit().await?;

    let community_id = community_id.to_string();

    let template: minijinja::Template<'_, '_> = state.env.get_template("post_view.jinja").unwrap();
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);

    if headers.get("HX-Request") == Some(&HeaderValue::from_static("true")) {
        let rendered = template
            .eval_to_state(context! {
                current_user => auth_session.user,
                post => {
                    post.as_ref()
                },
                post_id => id,
                ..create_base_ftl_context(&bundle)
            })?
            .render_block("post_edit_block")
            .unwrap();
        Ok(Html(rendered).into_response())
    } else {
        let rendered = template
            .render(context! {
                current_user => auth_session.user,
                default_community_id => state.config.default_community_id.clone(),
                r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
                post => {
                    post.as_ref()
                },
                parent_post_id => post.clone().unwrap().get("parent_post_id")
                    .and_then(|id| id.as_ref())
                    .and_then(|id| Uuid::parse_str(id).ok())
                    .map(|uuid| uuid.to_string())
                    .unwrap_or_default(),
                parent_post_author_login_name => parent_post_author_login_name.clone(),
                post_id => post.unwrap().get("id").unwrap().as_ref().unwrap().clone(),
                community_id,
                draft_post_count,
                base_url => state.config.base_url.clone(),
                domain => state.config.domain.clone(),
                comments,
                collaborative_participants,
                ..create_base_ftl_context(&bundle)
            })
            .unwrap();
        Ok(Html(rendered).into_response())
    }
}

pub async fn post_replay_view(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let uuid = match parse_id_with_legacy_support(&id, "/posts", &state)? {
        ParsedId::Uuid(uuid) => uuid,
        ParsedId::Redirect(redirect) => return Ok(redirect.into_response()),
        ParsedId::InvalidId(error_response) => return Ok(error_response),
    };
    let db = state.config.connect_database().await.unwrap();
    let mut tx: sqlx::Transaction<'_, sqlx::Postgres> = db.begin().await.unwrap();
    let post = find_post_by_id(&mut tx, uuid).await.unwrap();
    if post.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let community_id = Uuid::parse_str(
        post.clone()
            .as_ref()
            .unwrap()
            .get("community_id")
            .unwrap()
            .as_ref()
            .unwrap(),
    )
    .unwrap();

    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };
    let community_id = community_id.to_string();

    let template_filename = match post.clone().unwrap().get("replay_filename") {
        Some(replay_filename) => {
            let replay_filename = replay_filename.as_ref().unwrap();
            if replay_filename.ends_with(".pch") {
                "post_replay_view_pch.jinja"
            } else if replay_filename.ends_with(".tgkr") {
                "post_replay_view_tgkr.jinja"
            } else {
                "post_replay_view_pch.jinja"
            }
        }
        None => "post_replay_view_pch.jinja",
    };

    let template: minijinja::Template<'_, '_> = state.env.get_template(template_filename).unwrap();
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template
        .render(context! {
            current_user => auth_session.user,
            default_community_id => state.config.default_community_id.clone(),
            r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
            post => {
                post.as_ref()
            },
            post_id => post.unwrap().get("id").unwrap().as_ref().unwrap().clone(),
            community_id,
            draft_post_count,
            ..create_base_ftl_context(&bundle),
        })
        .unwrap();
    Ok(Html(rendered).into_response())
}

pub async fn post_publish_form(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let post_uuid = Uuid::parse_str(&id)?;

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let post = find_post_by_id(&mut tx, post_uuid).await?;

    if post.is_none() {
        return Ok((
            StatusCode::NOT_FOUND,
            handler_404(
                auth_session,
                ExtractAcceptLanguage(accept_language),
                State(state),
            )
            .await?,
        )
            .into_response());
    }

    if *post
        .clone()
        .unwrap()
        .get("author_id")
        .unwrap()
        .as_ref()
        .unwrap()
        != auth_session.user.clone().unwrap().id.to_string()
    {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let published_at = post.clone().unwrap().get("published_at").unwrap().clone();
    if published_at.is_some() {
        return Ok(Redirect::to(&format!("/posts/{}", id)).into_response());
    }

    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let community_id = Uuid::parse_str(
        post.clone()
            .unwrap()
            .get("community_id")
            .unwrap()
            .as_ref()
            .unwrap(),
    )?;
    let link = get_community_slug_url(&mut tx, community_id).await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("post_form.jinja")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        post_id => id,
        link,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        post => {
            post
        },
        draft_post_count,
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct PostPublishForm {
    post_id: String,
    title: String,
    content: String,
    is_sensitive: Option<String>,
    allow_relay: Option<String>,
}

pub async fn post_publish(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Form(form): Form<PostPublishForm>,
) -> Result<impl IntoResponse, AppError> {
    let post_id = Uuid::parse_str(&form.post_id)?;

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let post = find_post_by_id(&mut tx, post_id).await?;
    if post.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let author_id = Uuid::parse_str(
        post.clone()
            .unwrap()
            .clone()
            .get("author_id")
            .unwrap()
            .as_ref()
            .unwrap(),
    )?;
    let user_id = auth_session.user.unwrap().id;
    if author_id != user_id {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let is_sensitive = form.is_sensitive == Some("on".to_string());
    let allow_relay = form.allow_relay == Some("on".to_string());
    let community_id = Uuid::parse_str(
        &post
            .clone()
            .unwrap()
            .get("community_id")
            .unwrap()
            .clone()
            .unwrap(),
    )?;
    let community_url = get_community_slug_url(&mut tx, community_id).await?;

    let _ = publish_post(
        &mut tx,
        post_id,
        form.title.clone(),
        form.content.clone(),
        is_sensitive,
        allow_relay,
    )
    .await;

    // Find the actor for this user to send ActivityPub activities
    let actor = Actor::find_by_user_id(&mut tx, user_id).await?;

    let _ = tx.commit().await;

    // Send ActivityPub Create activity to followers if actor exists
    if let Some(actor) = actor {
        // Send to user's followers first and get the Note object
        match send_post_to_followers(
            &actor,
            post_id,
            form.title.clone(),
            form.content.clone(),
            &state,
        )
        .await
        {
            Ok(note) => {
                // Send to community's followers using the Note from the first call
                if let Err(e) =
                    send_post_to_community_followers(&actor, community_id, &note, &state).await
                {
                    tracing::error!(
                        "Failed to send post to community's ActivityPub followers: {:?}",
                        e
                    );
                    // Don't fail the entire operation if ActivityPub sending fails
                }
            }
            Err(e) => {
                tracing::error!(
                    "Failed to send post to user's ActivityPub followers: {:?}",
                    e
                );
                // Don't fail the entire operation if ActivityPub sending fails
            }
        }
    } else {
        tracing::warn!("No actor found for user {}, skipping ActivityPub", user_id);
    }

    Ok(Redirect::to(&community_url).into_response())
}

pub async fn draft_posts(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
) -> Result<Html<String>, AppError> {
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };
    let posts =
        find_draft_posts_by_author_id(&mut tx, auth_session.user.clone().unwrap().id).await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("draft_posts.jinja")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        posts => posts,
        draft_post_count,
        ..create_base_ftl_context(&bundle),
    })?;

    Ok(Html(rendered))
}

#[derive(Deserialize)]
pub struct CreateCommentForm {
    pub post_id: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct CollaborativeParticipant {
    pub login_name: String,
    pub display_name: String,
}

pub async fn do_create_comment(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Form(form): Form<CreateCommentForm>,
) -> Result<impl IntoResponse, AppError> {
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let user_id = auth_session.user.unwrap().id;
    let post_id = Uuid::parse_str(&form.post_id).unwrap();
    let _ = create_comment(
        &mut tx,
        CommentDraft {
            user_id,
            post_id,
            content: form.content,
        },
    )
    .await;
    let comments = find_comments_by_post_id(&mut tx, post_id).await?;
    let _ = tx.commit().await;

    let template: minijinja::Template<'_, '_> = state.env.get_template("post_comments.jinja")?;
    let rendered = template.render(context! {
        comments => comments,
        ..create_base_ftl_context(&bundle)
    })?;
    Ok(Html(rendered).into_response())
}

pub async fn post_edit_community(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let post_uuid = Uuid::parse_str(&id)?;

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let post = find_post_by_id(&mut tx, post_uuid).await?;
    if post.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    if *post
        .clone()
        .unwrap()
        .get("author_id")
        .unwrap()
        .as_ref()
        .unwrap()
        != auth_session.user.clone().unwrap().id.to_string()
    {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let known_communities =
        get_known_communities(&mut tx, auth_session.user.clone().unwrap().id).await?;
    let filtered_known_communities = known_communities
        .iter()
        .filter(|c| {
            c.id != Uuid::parse_str(
                post.clone()
                    .unwrap()
                    .get("community_id")
                    .unwrap()
                    .as_ref()
                    .unwrap(),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    let known_communities_with_community_id = filtered_known_communities
        .iter()
        .map(|c| {
            let community_id = c.id.to_string();
            (c, community_id)
        })
        .collect::<Vec<_>>();

    let template: minijinja::Template<'_, '_> =
        state.env.get_template("post_edit_community.jinja")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        post,
        post_id => id,
        known_communities_with_community_id,
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct EditPostCommunityForm {
    pub community_id: Uuid,
}

pub async fn do_post_edit_community(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Form(form): Form<EditPostCommunityForm>,
) -> Result<impl IntoResponse, AppError> {
    let post_uuid = Uuid::parse_str(&id)?;

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let post = find_post_by_id(&mut tx, post_uuid).await?;
    if post.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    if *post
        .clone()
        .unwrap()
        .get("author_id")
        .unwrap()
        .as_ref()
        .unwrap()
        != auth_session.user.clone().unwrap().id.to_string()
    {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let _ = edit_post_community(&mut tx, post_uuid, form.community_id).await;
    let _ = tx.commit().await;

    Ok(Redirect::to(&format!("/posts/{}", id)).into_response())
}

pub async fn hx_edit_post(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let post_uuid = Uuid::parse_str(&id)?;

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let post = find_post_by_id(&mut tx, post_uuid).await?;

    if post.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    if *post
        .clone()
        .unwrap()
        .get("author_id")
        .unwrap()
        .as_ref()
        .unwrap()
        != auth_session.user.clone().unwrap().id.to_string()
    {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let template: minijinja::Template<'_, '_> = state.env.get_template("post_edit.jinja")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        post,
        post_id => id,
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct EditPostForm {
    pub title: String,
    pub content: String,
    pub is_sensitive: Option<String>,
    pub allow_relay: Option<String>,
}

pub async fn hx_do_edit_post(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Form(form): Form<EditPostForm>,
) -> Result<impl IntoResponse, AppError> {
    let post_uuid = Uuid::parse_str(&id)?;

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let post = find_post_by_id(&mut tx, post_uuid).await?;
    if post.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    if *post
        .clone()
        .unwrap()
        .get("author_id")
        .unwrap()
        .as_ref()
        .unwrap()
        != auth_session.user.clone().unwrap().id.to_string()
    {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let _ = edit_post(
        &mut tx,
        post_uuid,
        form.title.clone(),
        form.content.clone(),
        form.is_sensitive == Some("on".to_string()),
        form.allow_relay == Some("on".to_string()),
    )
    .await;
    let post = find_post_by_id(&mut tx, post_uuid).await?;

    // Find the actor for this user to send ActivityPub activities
    let actor = Actor::find_by_user_id(&mut tx, auth_session.user.clone().unwrap().id).await?;

    let _ = tx.commit().await;

    // Send ActivityPub Update activity to followers if actor exists and post is published
    if let Some(actor) = actor {
        if let Some(ref post_data) = post {
            // Only send ActivityPub activities for published posts
            if post_data
                .get("published_at")
                .and_then(|p| p.as_ref())
                .is_some()
            {
                // Send update to user's followers
                if let Err(e) = send_post_update_to_followers(&actor, post_uuid, &state).await {
                    tracing::error!(
                        "Failed to send post update to user's ActivityPub followers: {:?}",
                        e
                    );
                    // Don't fail the entire operation if ActivityPub sending fails
                }
            }
        }
    }

    let template: minijinja::Template<'_, '_> = state.env.get_template("post_view.jinja")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template
        .eval_to_state(context! {
            current_user => auth_session.user,
            default_community_id => state.config.default_community_id.clone(),
            post,
            post_id => id,
            ..create_base_ftl_context(&bundle)
        })?
        .render_block("post_edit_block")?;

    Ok(Html(rendered).into_response())
}

pub async fn hx_delete_post(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let post_uuid = Uuid::parse_str(&id)?;

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let post = find_post_by_id(&mut tx, post_uuid).await?;
    if post.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    if *post
        .clone()
        .unwrap()
        .get("author_id")
        .unwrap()
        .as_ref()
        .unwrap()
        != auth_session.user.clone().unwrap().id.to_string()
    {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let image_id = Uuid::parse_str(
        &post
            .clone()
            .unwrap()
            .get("image_id")
            .unwrap()
            .clone()
            .unwrap(),
    )
    .unwrap();
    let image = find_image_by_id(&mut tx, image_id).await?;

    let mut keys = vec![format!(
        "image/{}{}/{}",
        image.image_filename.chars().next().unwrap(),
        image.image_filename.chars().nth(1).unwrap(),
        image.image_filename
    )];

    // Only add replay file to deletion if it exists
    if let Some(ref replay_filename) = image.replay_filename {
        keys.push(format!(
            "replay/{}{}/{}",
            replay_filename.chars().next().unwrap(),
            replay_filename.chars().nth(1).unwrap(),
            replay_filename
        ));
    }

    let credentials: AwsCredentials = AwsCredentials::new(
        state.config.aws_access_key_id.clone(),
        state.config.aws_secret_access_key.clone(),
        None,
        None,
        "",
    );
    let credentials_provider = SharedCredentialsProvider::new(credentials);
    let config = aws_sdk_s3::Config::builder()
        .endpoint_url(state.config.r2_endpoint_url.clone())
        .region(Region::new(state.config.aws_region.clone()))
        .credentials_provider(credentials_provider)
        .behavior_version_latest()
        .build();
    let client = Client::from_conf(config);
    client
        .delete_objects()
        .bucket(state.config.aws_s3_bucket.clone())
        .delete(
            Delete::builder()
                .set_objects(Some(
                    keys.iter()
                        .map(|key| ObjectIdentifier::builder().key(key).build().unwrap())
                        .collect::<Vec<_>>(),
                ))
                .build()
                .map_err(Error::from)?,
        )
        .send()
        .await?;
    let community_id = post.unwrap().get("community_id").unwrap().clone().unwrap();
    let community_id = Uuid::parse_str(&community_id)?;
    let community_url = get_community_slug_url(&mut tx, community_id).await?;

    delete_post_with_activity(&mut tx, post_uuid, Some(&state)).await?;
    tx.commit().await?;

    Ok(([("HX-Redirect", &community_url)],).into_response())
}

pub async fn post_view_by_login_name(
    auth_session: AuthSession,
    headers: HeaderMap,
    State(state): State<AppState>,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    Path((login_name, post_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let uuid = match parse_id_with_legacy_support(&post_id, &format!("/@{}", login_name), &state)? {
        ParsedId::Uuid(uuid) => uuid,
        ParsedId::Redirect(redirect) => return Ok(redirect.into_response()),
        ParsedId::InvalidId(error_response) => return Ok(error_response),
    };

    let db = state.config.connect_database().await.unwrap();
    let mut tx: sqlx::Transaction<'_, sqlx::Postgres> = db.begin().await.unwrap();
    let post = find_post_by_id(&mut tx, uuid).await.unwrap();

    match post {
        Some(post_data) => {
            let post_login_name = post_data.get("login_name").unwrap().as_ref().unwrap();
            if post_login_name != &login_name {
                return Ok(StatusCode::NOT_FOUND.into_response());
            }
            increment_post_viewer_count(&mut tx, uuid).await.unwrap();
        }
        None => {
            return Ok((
                StatusCode::NOT_FOUND,
                handler_404(
                    auth_session,
                    ExtractAcceptLanguage(accept_language),
                    State(state),
                )
                .await?,
            )
                .into_response());
        }
    }

    let comments = find_comments_by_post_id(&mut tx, uuid).await.unwrap();
    let post = find_post_by_id(&mut tx, uuid).await.unwrap();

    // Get parent post data if it exists
    let parent_post_author_login_name = if let Some(parent_post_id_str) = post
        .clone()
        .unwrap()
        .get("parent_post_id")
        .and_then(|id| id.as_ref())
    {
        if let Ok(parent_uuid) = Uuid::parse_str(parent_post_id_str) {
            find_post_by_id(&mut tx, parent_uuid)
                .await
                .unwrap_or(None)
                .and_then(|parent_post| parent_post.get("login_name").cloned())
                .flatten()
                .unwrap_or_default()
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    let community_id = Uuid::parse_str(
        post.clone()
            .as_ref()
            .unwrap()
            .get("community_id")
            .unwrap()
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    // Get collaborative session participants if this post is from a collaborative session
    let collaborative_participants: Vec<CollaborativeParticipant> = sqlx::query!(
        r#"
        SELECT u.login_name, u.display_name
        FROM collaborative_sessions cs
        JOIN collaborative_sessions_participants csp ON cs.id = csp.session_id
        JOIN users u ON csp.user_id = u.id
        WHERE cs.saved_post_id = $1
        ORDER BY csp.joined_at ASC
        "#,
        uuid
    )
    .fetch_all(&mut *tx)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|row| CollaborativeParticipant {
        login_name: row.login_name,
        display_name: row.display_name,
    })
    .collect();

    tx.commit().await?;

    let community_id = community_id.to_string();

    let template: minijinja::Template<'_, '_> = state.env.get_template("post_view.jinja").unwrap();
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);

    if headers.get("HX-Request") == Some(&HeaderValue::from_static("true")) {
        let rendered = template
            .eval_to_state(context! {
                current_user => auth_session.user,
                post => {
                    post.as_ref()
                },
                post_id => post_id,
                ..create_base_ftl_context(&bundle)
            })?
            .render_block("post_edit_block")
            .unwrap();
        Ok(Html(rendered).into_response())
    } else {
        let rendered = template
            .render(context! {
                current_user => auth_session.user,
                default_community_id => state.config.default_community_id.clone(),
                r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
                post => {
                    post.as_ref()
                },
                parent_post_id => post.clone().unwrap().get("parent_post_id")
                    .and_then(|id| id.as_ref())
                    .and_then(|id| Uuid::parse_str(id).ok())
                    .map(|uuid| uuid.to_string())
                    .unwrap_or_default(),
                parent_post_author_login_name => parent_post_author_login_name.clone(),
                post_id => post.unwrap().get("id").unwrap().as_ref().unwrap().clone(),
                community_id,
                draft_post_count,
                base_url => state.config.base_url.clone(),
                domain => state.config.domain.clone(),
                comments,
                collaborative_participants,
                ..create_base_ftl_context(&bundle)
            })
            .unwrap();
        Ok(Html(rendered).into_response())
    }
}

pub async fn redirect_post_to_login_name(
    State(state): State<AppState>,
    Path(post_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let uuid = match parse_id_with_legacy_support(&post_id, "/posts", &state)? {
        ParsedId::Uuid(uuid) => uuid,
        ParsedId::Redirect(redirect) => return Ok(redirect.into_response()),
        ParsedId::InvalidId(error_response) => return Ok(error_response),
    };

    let db = state.config.connect_database().await.unwrap();
    let mut tx: sqlx::Transaction<'_, sqlx::Postgres> = db.begin().await.unwrap();
    let post = find_post_by_id(&mut tx, uuid).await.unwrap();
    tx.commit().await?;

    match post {
        Some(post_data) => {
            let login_name = post_data.get("login_name").unwrap().as_ref().unwrap();
            let post_uuid_str = post_data.get("id").unwrap().as_ref().unwrap();
            Ok(Redirect::permanent(&format!("/@{}/{}", login_name, post_uuid_str)).into_response())
        }
        None => Ok(StatusCode::NOT_FOUND.into_response()),
    }
}

async fn send_post_update_to_followers(
    actor: &Actor,
    post_id: Uuid,
    state: &AppState,
) -> Result<(), AppError> {
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;

    // Get all followers for this actor
    let followers = follow::find_followers_by_actor_id(&mut tx, actor.id).await?;

    // Use the function to create the updated Note with timestamp
    let note = create_updated_note_from_post(
        &mut tx,
        post_id,
        actor,
        &state.config.domain,
        &state.config.r2_public_endpoint_url,
    )
    .await?;

    let actor_object_id = ObjectId::parse(&actor.iri)?;
    let to = vec!["https://www.w3.org/ns/activitystreams#Public".to_string()];
    let cc = vec![format!("{}/followers", actor.iri)];
    let published = chrono::Utc::now().to_rfc3339();

    tracing::info!("Updated Note: {:?}", note);

    // Only send to followers if there are any
    if !followers.is_empty() {
        // Create the Update activity for the Note
        let activity_id = generate_object_id(&state.config.domain)?;
        let update = UpdateNote::new(actor_object_id, note, activity_id, to, cc, published);

        // Get follower inboxes
        let follower_inboxes: Vec<url::Url> = followers
            .iter()
            .map(|follower| follower.inbox_url.parse())
            .collect::<Result<Vec<_>, _>>()?;

        if !follower_inboxes.is_empty() {
            // Create federation config to send activities
            let federation_config = activitypub_federation::config::FederationConfig::builder()
                .domain(&state.config.domain)
                .app_data(state.clone())
                .build()
                .await?;
            let federation_data = federation_config.to_request_data();

            // Send to all followers
            actor
                .send(update, follower_inboxes, false, &federation_data)
                .await?;
            tracing::info!(
                "Sent Update activity for post {} to {} followers",
                post_id,
                followers.len()
            );
        }
    } else {
        tracing::info!(
            "No followers to send Update activity to for post {}",
            post_id
        );
    }

    tx.commit().await?;
    Ok(())
}

pub async fn post_relay_view_by_login_name(
    auth_session: AuthSession,
    State(state): State<AppState>,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    Path((login_name, post_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let uuid = match parse_id_with_legacy_support(&post_id, &format!("/@{}", login_name), &state)? {
        ParsedId::Uuid(uuid) => uuid,
        ParsedId::Redirect(redirect) => return Ok(redirect.into_response()),
        ParsedId::InvalidId(error_response) => return Ok(error_response),
    };

    let db = state.config.connect_database().await.unwrap();
    let mut tx: sqlx::Transaction<'_, sqlx::Postgres> = db.begin().await.unwrap();
    let post = find_post_by_id(&mut tx, uuid).await.unwrap();

    match post {
        Some(ref post_data) => {
            let post_login_name = post_data.get("login_name").unwrap().as_ref().unwrap();
            if post_login_name != &login_name {
                return Ok(StatusCode::NOT_FOUND.into_response());
            }
        }
        None => {
            return Ok((
                StatusCode::NOT_FOUND,
                handler_404(
                    auth_session,
                    ExtractAcceptLanguage(accept_language),
                    State(state),
                )
                .await?,
            )
                .into_response());
        }
    }

    let template: minijinja::Template<'_, '_> =
        state.env.get_template("draw_post_neo.jinja").unwrap();

    let community_id = Uuid::parse_str(
        post.clone()
            .unwrap()
            .get("community_id")
            .unwrap()
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    let community = find_community_by_id(&mut tx, community_id).await?.unwrap();
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template
        .render(context! {
            parent_post => post.clone().unwrap(),
            current_user => auth_session.user,
            default_community_id => state.config.default_community_id.clone(),
            r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
            community_name => community.name,
            width => post.clone().unwrap().get("image_width").unwrap().as_ref().unwrap().parse::<u32>()?,
            height => post.unwrap().get("image_height").unwrap().as_ref().unwrap().parse::<u32>()?,
            background_color => community.background_color,
            foreground_color => community.foreground_color,
            community_id => community_id.to_string(),
            draft_post_count,
            ..create_base_ftl_context(&bundle)
        })
        .unwrap();
    Ok(Html(rendered).into_response())
}

pub async fn post_replay_view_by_login_name(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path((login_name, post_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let uuid = match parse_id_with_legacy_support(&post_id, &format!("/@{}", login_name), &state)? {
        ParsedId::Uuid(uuid) => uuid,
        ParsedId::Redirect(redirect) => return Ok(redirect.into_response()),
        ParsedId::InvalidId(error_response) => return Ok(error_response),
    };

    let db = state.config.connect_database().await.unwrap();
    let mut tx: sqlx::Transaction<'_, sqlx::Postgres> = db.begin().await.unwrap();
    let post = find_post_by_id(&mut tx, uuid).await.unwrap();

    match post {
        Some(ref post_data) => {
            let post_login_name = post_data.get("login_name").unwrap().as_ref().unwrap();
            if post_login_name != &login_name {
                return Ok(StatusCode::NOT_FOUND.into_response());
            }
        }
        None => {
            return Ok(StatusCode::NOT_FOUND.into_response());
        }
    }

    let community_id = Uuid::parse_str(
        post.clone()
            .as_ref()
            .unwrap()
            .get("community_id")
            .unwrap()
            .as_ref()
            .unwrap(),
    )
    .unwrap();

    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };
    let community_id = community_id.to_string();

    let template_filename = match post.clone().unwrap().get("replay_filename") {
        Some(replay_filename) => {
            let replay_filename = replay_filename.as_ref().unwrap();
            if replay_filename.ends_with(".pch") {
                "post_replay_view_pch.jinja"
            } else if replay_filename.ends_with(".tgkr") {
                "post_replay_view_tgkr.jinja"
            } else {
                "post_replay_view_pch.jinja"
            }
        }
        None => "post_replay_view_pch.jinja",
    };

    let template: minijinja::Template<'_, '_> = state.env.get_template(template_filename).unwrap();
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template
        .render(context! {
            current_user => auth_session.user,
            r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
            post => {
                post.as_ref()
            },
            post_id => post_id,
            community_id,
            draft_post_count,
            ..create_base_ftl_context(&bundle)
        })
        .unwrap();
    Ok(Html(rendered).into_response())
}
