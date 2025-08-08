use axum::{
    extract::{Path, State},
    response::{Html, Redirect},
    Form,
};
use minijinja::context;
use serde::Deserialize;
use uuid::Uuid;

use crate::app_error::AppError;
use crate::models::canvas_session::CanvasSession;
use crate::models::user::AuthSession;
use crate::web::handlers::{create_base_ftl_context, get_bundle, ExtractAcceptLanguage};
use crate::web::state::AppState;

#[derive(Deserialize)]
pub struct RoomCreateForm {
    canvas_size: String,
}

fn parse_canvas_size(size: &str) -> (i32, i32) {
    match size {
        "small" => (400, 300),
        "medium" => (800, 600),
        "large" => (1200, 900),
        "wide" => (1600, 900),
        "square" => (800, 800),
        _ => (800, 600), // Default to medium
    }
}

pub async fn canvas_index(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
) -> Result<Html<String>, AppError> {
    let db = state.config.connect_database().await?;

    // Get active public sessions with user counts
    let public_sessions_with_counts =
        CanvasSession::get_active_public_sessions(&db, Some(5)).await?;

    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);

    let template = state.env.get_template("canvas_index.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        public_sessions_with_counts => public_sessions_with_counts,
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered))
}

pub async fn canvas_room(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(room_id): Path<String>,
) -> Result<Html<String>, AppError> {
    let db = state.config.connect_database().await?;

    // Get or create session in database
    let session = CanvasSession::get_or_create_by_room_id(
        &db,
        room_id.clone(),
        Some(800), // Default fallback if creating new session
        Some(600), // Default fallback if creating new session
    )
    .await?;

    // Use actual canvas dimensions from the session
    let canvas_width = session.canvas_width;
    let canvas_height = session.canvas_height;

    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);

    let template = state.env.get_template("canvas_room.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        room_id => room_id,
        canvas_width => canvas_width,
        canvas_height => canvas_height,
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered))
}

pub async fn create_room_form(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
) -> Result<Html<String>, AppError> {
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);

    let template = state.env.get_template("canvas_create_room.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        room_type => "private",
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered))
}

pub async fn create_public_room_form(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
) -> Result<Html<String>, AppError> {
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);

    let template = state.env.get_template("canvas_create_room.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        room_type => "public",
        ..create_base_ftl_context(&bundle)
    })?;

    Ok(Html(rendered))
}

pub async fn create_room(
    auth_session: AuthSession,
    _accept_language: ExtractAcceptLanguage,
    State(state): State<AppState>,
    Form(form): Form<RoomCreateForm>,
) -> Result<Redirect, AppError> {
    let db = state.config.connect_database().await?;

    // Generate unique room ID
    let room_id = Uuid::new_v4().to_string();

    // Parse canvas size from form
    let (canvas_width, canvas_height) = parse_canvas_size(&form.canvas_size);

    // Create session with user as owner
    let owner_id = auth_session.user.as_ref().map(|u| u.id);
    let _session = CanvasSession::create(
        &db,
        room_id.clone(),
        Some("New Drawing Room".to_string()),
        canvas_width,
        canvas_height,
        owner_id,
        false, // Private room
    )
    .await?;

    // Redirect to the created room
    Ok(Redirect::to(&format!("/collaborate/{}", room_id)))
}

pub async fn create_public_room(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Form(form): Form<RoomCreateForm>,
) -> Result<Redirect, AppError> {
    let db = state.config.connect_database().await?;

    // Get localized strings
    let user_preferred_language = auth_session
        .user
        .as_ref()
        .and_then(|u| u.preferred_language.clone());
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let public_room_title = bundle.format_pattern(
        bundle
            .get_message("collaborative-public-room-title")
            .unwrap()
            .value()
            .unwrap(),
        None,
        &mut vec![],
    );

    // Generate unique room ID
    let room_id = Uuid::new_v4().to_string();

    // Parse canvas size from form
    let (canvas_width, canvas_height) = parse_canvas_size(&form.canvas_size);

    // Create public session with user as owner
    let owner_id = auth_session.user.as_ref().map(|u| u.id);
    let _session = CanvasSession::create(
        &db,
        room_id.clone(),
        Some(public_room_title.into()),
        canvas_width,
        canvas_height,
        owner_id, // User becomes owner even for public rooms
        true,     // Public room
    )
    .await?;

    // Redirect to the created room
    Ok(Redirect::to(&format!("/collaborate/{}", room_id)))
}
