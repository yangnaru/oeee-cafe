use crate::app_error::AppError;
use crate::models::push_token::delete_push_token;
use crate::models::user::{create_user, AuthSession, Credentials, Language, UserDraft};
use crate::web::handlers::{get_bundle, ExtractFtlLang};
use crate::web::state::AppState;
use axum::extract::Query;
use axum::response::{IntoResponse, Redirect};
use axum::{extract::State, http::StatusCode, response::Html, response::Json, Form};
use axum_messages::Messages;
use fluent::{FluentArgs, FluentValue};
use minijinja::context;
use serde::{Deserialize, Serialize};

use super::ExtractAcceptLanguage;

// This allows us to extract the "next" field from the query string. We use this
// to redirect after log in.
#[derive(Debug, Deserialize)]
pub struct NextUrl {
    next: Option<String>,
}

pub async fn signup(
    messages: Messages,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    Query(NextUrl { next }): Query<NextUrl>,
    State(state): State<crate::web::state::AppState>,
) -> Result<impl IntoResponse, AppError> {
    let template: minijinja::Template<'_, '_> = state.env.get_template("signup.jinja")?;

    let rendered: String = template.render(context! {
        messages => messages.into_iter().collect::<Vec<_>>(),
        next => next,
        ftl_lang
    })?;

    Ok(Html(rendered))
}

#[derive(Deserialize)]
pub struct CreateUserForm {
    login_name: String,
    password: String,
    password_confirm: String,
    display_name: String,
    next: Option<String>,
}

pub async fn do_signup(
    mut auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    messages: Messages,
    State(state): State<AppState>,
    Form(form): Form<CreateUserForm>,
) -> Result<impl IntoResponse, AppError> {
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);

    if form.password != form.password_confirm {
        messages.error(
            bundle.format_pattern(
                bundle
                    .get_message("account-change-password-error-mismatch")
                    .unwrap()
                    .value()
                    .unwrap(),
                None,
                &mut vec![],
            ),
        );
        return Ok(Redirect::to("/signup").into_response());
    }

    let user_draft = UserDraft::new(form.login_name, form.password, form.display_name)?;
    let db = &state.db_pool;
    let mut tx = db.begin().await?;
    let user = create_user(&mut tx, user_draft, &state.config).await?;
    tx.commit().await?;

    if auth_session.login(&user).await.is_err() {
        return Ok(StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    let pattern = bundle.get_message("welcome").unwrap().value().unwrap();
    let mut args = FluentArgs::new();
    args.set("name", FluentValue::from(user.display_name));
    let message = bundle.format_pattern(pattern, Some(&args), &mut vec![]);
    messages.success(message);

    if let Some(ref next) = form.next {
        Ok(Redirect::to(next).into_response())
    } else {
        Ok(Redirect::to("/").into_response())
    }
}

pub async fn login(
    messages: Messages,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    Query(NextUrl { next }): Query<NextUrl>,
    State(state): State<crate::web::state::AppState>,
) -> Result<impl IntoResponse, AppError> {
    let template: minijinja::Template<'_, '_> = state.env.get_template("login.jinja")?;

    let collected_messages: Vec<axum_messages::Message> = messages.into_iter().collect();

    let rendered: String = template.render(context! {
        messages => collected_messages,
        next => next,
        ftl_lang
    })?;

    Ok(Html(rendered))
}

pub async fn do_login(
    mut auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    messages: Messages,
    Form(creds): Form<Credentials>,
) -> impl IntoResponse {
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);

    let user = match auth_session.authenticate(creds.clone()).await {
        Ok(Some(user)) => user,
        Ok(None) => {
            messages.error(
                bundle.format_pattern(
                    bundle
                        .get_message("message-incorrect-credentials")
                        .unwrap()
                        .value()
                        .unwrap(),
                    None,
                    &mut vec![],
                ),
            );

            let mut login_url = "/login".to_string();
            if let Some(next) = creds.next {
                login_url = format!("{}?next={}", login_url, next);
            };

            return Redirect::to(&login_url).into_response();
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    if auth_session.login(&user).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    let pattern = bundle.get_message("welcome").unwrap().value().unwrap();
    let mut args = FluentArgs::new();
    args.set("name", FluentValue::from(user.display_name));
    let message = bundle.format_pattern(pattern, Some(&args), &mut vec![]);
    messages.success(message);

    if let Some(ref next) = creds.next {
        Redirect::to(next)
    } else {
        Redirect::to("/")
    }
    .into_response()
}

#[derive(Debug)]
pub enum LoginError {
    UserNotFound,
    PasswordNotMatch,
}

pub async fn do_logout(mut auth_session: AuthSession) -> impl IntoResponse {
    match auth_session.logout().await {
        Ok(_) => Redirect::to("/").into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

// JSON API types
#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub login_name: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct LoginResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<UserInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UserInfo {
    pub id: String,
    pub login_name: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_verified_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_language: Option<Language>,
}

#[derive(Debug, Deserialize)]
pub struct LogoutRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_token: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LogoutResponse {
    pub success: bool,
}

#[derive(Debug, Deserialize)]
pub struct SignupRequest {
    pub login_name: String,
    pub password: String,
    pub display_name: String,
}

#[derive(Debug, Serialize)]
pub struct SignupResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<UserInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// JSON API endpoint for login
pub async fn api_login(
    mut auth_session: AuthSession,
    State(_state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> impl IntoResponse {
    // Create credentials from JSON request
    let creds = Credentials {
        login_name: req.login_name,
        password: req.password,
        next: None,
    };

    // Authenticate user
    let user = match auth_session.authenticate(creds).await {
        Ok(Some(user)) => user,
        Ok(None) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(LoginResponse {
                    success: false,
                    user: None,
                    error: Some("Invalid credentials".to_string()),
                }),
            )
                .into_response();
        }
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(LoginResponse {
                    success: false,
                    user: None,
                    error: Some("Authentication error".to_string()),
                }),
            )
                .into_response();
        }
    };

    // Login user (sets session cookie)
    if auth_session.login(&user).await.is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(LoginResponse {
                success: false,
                user: None,
                error: Some("Login error".to_string()),
            }),
        )
            .into_response();
    }

    // Return success with user info
    (
        StatusCode::OK,
        Json(LoginResponse {
            success: true,
            user: Some(UserInfo {
                id: user.id.to_string(),
                login_name: user.login_name,
                display_name: user.display_name,
                email: user.email,
                email_verified_at: user.email_verified_at.map(|dt| dt.to_rfc3339()),
                banner_id: user.banner_id.map(|id| id.to_string()),
                preferred_language: user.preferred_language,
            }),
            error: None,
        }),
    )
        .into_response()
}

// JSON API endpoint for logout
pub async fn api_logout(
    mut auth_session: AuthSession,
    State(state): State<AppState>,
    Json(request): Json<LogoutRequest>,
) -> impl IntoResponse {
    // Delete the push token for this device if provided
    if let (Some(user), Some(device_token)) = (&auth_session.user, request.device_token) {
        let db_pool = &state.db_pool;
        if let Ok(mut tx) = db_pool.begin().await {
            let _ = delete_push_token(&mut tx, user.id, device_token).await;
            let _ = tx.commit().await;
        }
    }

    match auth_session.logout().await {
        Ok(_) => (
            StatusCode::OK,
            Json(LogoutResponse { success: true }),
        )
            .into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(LogoutResponse { success: false }),
        )
            .into_response(),
    }
}

// JSON API endpoint to get current user info
pub async fn api_me(auth_session: AuthSession) -> impl IntoResponse {
    match auth_session.user {
        Some(user) => (
            StatusCode::OK,
            Json(UserInfo {
                id: user.id.to_string(),
                login_name: user.login_name,
                display_name: user.display_name,
                email: user.email,
                email_verified_at: user.email_verified_at.map(|dt| dt.to_rfc3339()),
                banner_id: user.banner_id.map(|id| id.to_string()),
                preferred_language: user.preferred_language,
            }),
        )
            .into_response(),
        None => (StatusCode::UNAUTHORIZED).into_response(),
    }
}

// JSON API endpoint for signup
pub async fn api_signup(
    mut auth_session: AuthSession,
    State(state): State<AppState>,
    Json(req): Json<SignupRequest>,
) -> impl IntoResponse {
    // Create user draft
    let user_draft = match UserDraft::new(req.login_name, req.password, req.display_name) {
        Ok(draft) => draft,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(SignupResponse {
                    success: false,
                    user: None,
                    error: Some(e.to_string()),
                }),
            )
                .into_response();
        }
    };

    // Create user in database
    let db = &state.db_pool;
    let mut tx = match db.begin().await {
        Ok(tx) => tx,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(SignupResponse {
                    success: false,
                    user: None,
                    error: Some("Database error".to_string()),
                }),
            )
                .into_response();
        }
    };

    let user = match create_user(&mut tx, user_draft, &state.config).await {
        Ok(user) => user,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(SignupResponse {
                    success: false,
                    user: None,
                    error: Some(e.to_string()),
                }),
            )
                .into_response();
        }
    };

    if tx.commit().await.is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(SignupResponse {
                success: false,
                user: None,
                error: Some("Database error".to_string()),
            }),
        )
            .into_response();
    }

    // Auto-login user (sets session cookie)
    if auth_session.login(&user).await.is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(SignupResponse {
                success: false,
                user: None,
                error: Some("Login error".to_string()),
            }),
        )
            .into_response();
    }

    // Return success with user info
    (
        StatusCode::CREATED,
        Json(SignupResponse {
            success: true,
            user: Some(UserInfo {
                id: user.id.to_string(),
                login_name: user.login_name,
                display_name: user.display_name,
                email: user.email,
                email_verified_at: user.email_verified_at.map(|dt| dt.to_rfc3339()),
                banner_id: user.banner_id.map(|id| id.to_string()),
                preferred_language: user.preferred_language,
            }),
            error: None,
        }),
    )
        .into_response()
}
