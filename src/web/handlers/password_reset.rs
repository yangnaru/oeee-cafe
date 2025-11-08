use crate::app_error::AppError;
use crate::models::password_reset_challenge::{
    create_password_reset_challenge, delete_password_reset_challenges_for_user,
    find_password_reset_challenge_by_token, PasswordResetChallenge,
};
use crate::models::user::{find_user_by_email, update_password};
use crate::web::handlers::{get_bundle, ExtractAcceptLanguage, ExtractFtlLang};
use crate::web::state::AppState;
use axum::extract::State;
use axum::response::{Html, IntoResponse, Redirect};
use axum::{http::StatusCode, Form, Json};
use axum_messages::Messages;
use chrono::{TimeDelta, Utc};
use fluent::FluentResource;
use intl_memoizer::concurrent::IntlLangMemoizer;
use lettre::transport::smtp::authentication::Credentials as SmtpCredentials;
use lettre::{Message, SmtpTransport, Transport};
use minijinja::context;
use rand::{thread_rng, Rng};
use serde::{Deserialize, Serialize};

// Web form handlers

pub async fn password_reset_request_page(
    messages: Messages,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
) -> Result<Html<String>, AppError> {
    let template = state.env.get_template("password_reset_request.jinja")?;
    let rendered = template.render(context! {
        messages => messages.into_iter().collect::<Vec<_>>(),
        ftl_lang
    })?;

    Ok(Html(rendered))
}

#[derive(Deserialize)]
pub struct PasswordResetRequestForm {
    pub email: String,
}

pub async fn password_reset_request(
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Form(form): Form<PasswordResetRequestForm>,
) -> Result<impl IntoResponse, AppError> {
    let bundle = get_bundle(&accept_language, None);

    // Always show success message to prevent email enumeration
    let template = state.env.get_template("password_reset_sent.jinja")?;
    let ftl_lang = bundle.locales.first().unwrap().to_string();

    // Validate email format
    if !form.email.contains('@') || form.email.parse::<lettre::Address>().is_err() {
        let rendered = template.render(context! {
            email => form.email,
            ftl_lang
        })?;
        return Ok(Html(rendered).into_response());
    }

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Find user by email
    let user = find_user_by_email(&mut tx, &form.email).await?;

    // If user exists and email is verified, send reset email
    if let Some(user) = user {
        if user.email_verified_at.is_some() && user.deleted_at.is_none() {
            // Create challenge and send email
            let _ = create_and_send_password_reset_email(&state, user.id, &form.email, &bundle).await;
        }
    }

    tx.commit().await?;

    // Always show the same success message
    let rendered = template.render(context! {
        email => form.email,
        ftl_lang
    })?;

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct PasswordResetVerifyForm {
    pub token: String,
    pub new_password: String,
    pub new_password_confirm: String,
}

pub async fn password_reset_verify(
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    messages: Messages,
    State(state): State<AppState>,
    Form(form): Form<PasswordResetVerifyForm>,
) -> Result<impl IntoResponse, AppError> {
    let bundle = get_bundle(&accept_language, None);
    let ftl_lang = bundle.locales.first().unwrap().to_string();

    // Validate passwords match
    if form.new_password != form.new_password_confirm {
        messages.error(
            bundle.format_pattern(
                bundle
                    .get_message("password-reset-error-mismatch")
                    .unwrap()
                    .value()
                    .unwrap(),
                None,
                &mut vec![],
            ),
        );
        let template = state.env.get_template("password_reset_verify.jinja")?;
        let rendered = template.render(context! {
            token => form.token,
            ftl_lang
        })?;
        return Ok(Html(rendered).into_response());
    }

    // Validate password length
    if form.new_password.len() < 8 {
        messages.error(
            bundle.format_pattern(
                bundle
                    .get_message("account-change-password-error-too-short")
                    .unwrap()
                    .value()
                    .unwrap(),
                None,
                &mut vec![],
            ),
        );
        let template = state.env.get_template("password_reset_verify.jinja")?;
        let rendered = template.render(context! {
            token => form.token,
            ftl_lang
        })?;
        return Ok(Html(rendered).into_response());
    }

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Find challenge by token
    let challenge = find_password_reset_challenge_by_token(&mut tx, &form.token).await?;

    if let Some(challenge) = challenge {
        // Update password
        let _ = update_password(&mut tx, challenge.user_id, form.new_password.clone()).await?;

        // Delete all password reset challenges for this user
        let _ = delete_password_reset_challenges_for_user(&mut tx, challenge.user_id).await?;

        tx.commit().await?;

        messages.success(
            bundle.format_pattern(
                bundle
                    .get_message("password-reset-success")
                    .unwrap()
                    .value()
                    .unwrap(),
                None,
                &mut vec![],
            ),
        );

        Ok(Redirect::to("/login").into_response())
    } else {
        messages.error(
            bundle.format_pattern(
                bundle
                    .get_message("password-reset-error-invalid-token")
                    .unwrap()
                    .value()
                    .unwrap(),
                None,
                &mut vec![],
            ),
        );
        let template = state.env.get_template("password_reset_verify.jinja")?;
        let rendered = template.render(context! {
            token => form.token,
            ftl_lang
        })?;
        Ok(Html(rendered).into_response())
    }
}

pub async fn password_reset_verify_page(
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<TokenQuery>,
) -> Result<Html<String>, AppError> {
    let template = state.env.get_template("password_reset_verify.jinja")?;
    let rendered = template.render(context! {
        token => query.token,
        ftl_lang
    })?;

    Ok(Html(rendered))
}

#[derive(Deserialize)]
pub struct TokenQuery {
    pub token: String,
}

// Helper function to create password reset challenge and send email
async fn create_and_send_password_reset_email(
    state: &AppState,
    user_id: uuid::Uuid,
    email: &str,
    bundle: &fluent::bundle::FluentBundle<&FluentResource, IntlLangMemoizer>,
) -> Result<PasswordResetChallenge, String> {
    let db = &state.db_pool;
    let mut tx = db.begin().await.map_err(|e| e.to_string())?;

    // Generate 6-digit token
    let token = {
        let mut rng = thread_rng();
        (0..6)
            .map(|_| rng.gen_range(0..10).to_string())
            .collect::<Vec<String>>()
            .join("")
    };

    let expires_at = Utc::now() + TimeDelta::try_seconds(60 * 15).unwrap(); // 15 minutes

    let password_reset_challenge = create_password_reset_challenge(
        &mut tx,
        user_id,
        email,
        &token,
        expires_at,
    )
    .await
    .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;

    // Send email
    let email_message = Message::builder()
        .from(
            bundle
                .format_pattern(
                    bundle
                        .get_message("email-from-address")
                        .unwrap()
                        .value()
                        .unwrap(),
                    None,
                    &mut vec![],
                )
                .parse()
                .unwrap(),
        )
        .to(email.parse().unwrap())
        .subject(
            bundle.format_pattern(
                bundle
                    .get_message("password-reset-email-subject")
                    .unwrap()
                    .value()
                    .unwrap(),
                None,
                &mut vec![],
            ),
        )
        .body(format!(
            "{}\n\n{}",
            bundle.format_pattern(
                bundle
                    .get_message("password-reset-email-body")
                    .unwrap()
                    .value()
                    .unwrap(),
                None,
                &mut vec![],
            ),
            token
        ))
        .unwrap();

    let mailer = SmtpTransport::relay(&state.config.smtp_host)
        .unwrap()
        .credentials(SmtpCredentials::new(
            state.config.smtp_user.clone(),
            state.config.smtp_password.clone(),
        ))
        .build();

    mailer.send(&email_message).map_err(|e| e.to_string())?;

    Ok(password_reset_challenge)
}

// JSON API endpoints for mobile apps

#[derive(Deserialize)]
pub struct PasswordResetRequestJson {
    pub email: String,
}

#[derive(Serialize)]
pub struct PasswordResetRequestResponseJson {
    pub success: bool,
    pub error: Option<String>,
}

pub async fn password_reset_request_json(
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Json(payload): Json<PasswordResetRequestJson>,
) -> impl IntoResponse {
    let bundle = get_bundle(&accept_language, None);

    // Validate email format
    if !payload.email.contains('@') || payload.email.parse::<lettre::Address>().is_err() {
        return (
            StatusCode::OK,
            Json(PasswordResetRequestResponseJson {
                success: true, // Always return success to prevent enumeration
                error: None,
            }),
        )
            .into_response();
    }

    let db = &state.db_pool;
    let mut tx = match db.begin().await {
        Ok(tx) => tx,
        Err(_) => {
            return (
                StatusCode::OK,
                Json(PasswordResetRequestResponseJson {
                    success: true,
                    error: None,
                }),
            )
                .into_response();
        }
    };

    // Find user by email
    let user = match find_user_by_email(&mut tx, &payload.email).await {
        Ok(user) => user,
        Err(_) => {
            let _ = tx.commit().await;
            return (
                StatusCode::OK,
                Json(PasswordResetRequestResponseJson {
                    success: true,
                    error: None,
                }),
            )
                .into_response();
        }
    };

    // If user exists and email is verified, send reset email
    if let Some(user) = user {
        if user.email_verified_at.is_some() && user.deleted_at.is_none() {
            let _ = create_and_send_password_reset_email(&state, user.id, &payload.email, &bundle)
                .await;
        }
    }

    let _ = tx.commit().await;

    // Always return success to prevent email enumeration
    (
        StatusCode::OK,
        Json(PasswordResetRequestResponseJson {
            success: true,
            error: None,
        }),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct PasswordResetVerifyJson {
    pub token: String,
    pub new_password: String,
}

#[derive(Serialize)]
pub struct PasswordResetVerifyResponseJson {
    pub success: bool,
    pub error: Option<String>,
}

pub async fn password_reset_verify_json(
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Json(payload): Json<PasswordResetVerifyJson>,
) -> impl IntoResponse {
    let bundle = get_bundle(&accept_language, None);

    // Validate password length
    if payload.new_password.len() < 8 {
        return (
            StatusCode::BAD_REQUEST,
            Json(PasswordResetVerifyResponseJson {
                success: false,
                error: Some("PASSWORD_TOO_SHORT".to_string()),
            }),
        )
            .into_response();
    }

    let db = &state.db_pool;
    let mut tx = match db.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(PasswordResetVerifyResponseJson {
                    success: false,
                    error: Some(format!("Database error: {}", e)),
                }),
            )
                .into_response();
        }
    };

    // Find challenge by token
    let challenge = match find_password_reset_challenge_by_token(&mut tx, &payload.token).await {
        Ok(challenge) => challenge,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(PasswordResetVerifyResponseJson {
                    success: false,
                    error: Some(format!("Database error: {}", e)),
                }),
            )
                .into_response();
        }
    };

    if let Some(challenge) = challenge {
        // Update password
        match update_password(&mut tx, challenge.user_id, payload.new_password.clone()).await {
            Ok(_) => {}
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(PasswordResetVerifyResponseJson {
                        success: false,
                        error: Some(format!("Failed to update password: {}", e)),
                    }),
                )
                    .into_response();
            }
        }

        // Delete all password reset challenges for this user
        let _ = delete_password_reset_challenges_for_user(&mut tx, challenge.user_id).await;

        match tx.commit().await {
            Ok(_) => {
                return (
                    StatusCode::OK,
                    Json(PasswordResetVerifyResponseJson {
                        success: true,
                        error: None,
                    }),
                )
                    .into_response();
            }
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(PasswordResetVerifyResponseJson {
                        success: false,
                        error: Some(format!("Database error: {}", e)),
                    }),
                )
                    .into_response();
            }
        }
    } else {
        return (
            StatusCode::BAD_REQUEST,
            Json(PasswordResetVerifyResponseJson {
                success: false,
                error: Some("INVALID_OR_EXPIRED_TOKEN".to_string()),
            }),
        )
            .into_response();
    }
}
