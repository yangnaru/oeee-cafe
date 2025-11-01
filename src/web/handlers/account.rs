use crate::app_error::AppError;
use crate::models::email_verification_challenge::{
    create_email_verification_challenge, find_email_verification_challenge_by_id,
};
use crate::models::user::{
    delete_user_with_activity, find_user_by_id, update_password, update_user_email_verified_at,
    update_user_preferred_language, update_user_with_activity, AuthSession, Language,
};
use crate::web::context::CommonContext;
use crate::web::handlers::{get_bundle, ExtractAcceptLanguage, ExtractFtlLang};
use crate::web::state::AppState;
use axum::response::{IntoResponse, Redirect};
use axum::{extract::State, http::StatusCode, response::Html, Form, Json};
use axum_messages::Messages;
use chrono::{TimeDelta, Utc};

use lettre::transport::smtp::authentication::Credentials as SmtpCredentials;
use lettre::{Message, SmtpTransport, Transport};
use minijinja::context;
use rand::{thread_rng, Rng};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Deserialize)]
pub struct EmailVerificationChallengeResponseForm {
    pub challenge_id: Uuid,
    pub token: String,
}

pub async fn account(
    messages: Messages,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<Html<String>, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let common_ctx =
        CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    let languages = vec![
        ("ko", "한국어"),
        ("ja", "日本語"),
        ("en", "English"),
        ("zh", "中文"),
    ];
    let template: minijinja::Template<'_, '_> = state.env.get_template("account.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        languages,
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        messages => messages.into_iter().collect::<Vec<_>>(),
        ftl_lang
    })?;

    Ok(Html(rendered))
}

#[derive(Deserialize)]
pub struct LanguageEditForm {
    pub language: Option<String>,
}

pub async fn save_language(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Form(form): Form<LanguageEditForm>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;
    let language = match form.language.as_deref() {
        Some("ko") => Some(Language::Ko),
        Some("ja") => Some(Language::Ja),
        Some("en") => Some(Language::En),
        Some("zh") => Some(Language::Zh),
        _ => None,
    };
    let _ = update_user_preferred_language(&mut tx, auth_session.user.unwrap().id, language).await;
    let _ = tx.commit().await;

    Ok(Redirect::to("/account").into_response())
}

#[derive(Deserialize)]
pub struct EditPasswordForm {
    current_password: String,
    new_password: String,
    new_password_confirm: String,
}

pub async fn edit_password(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    messages: Messages,
    State(state): State<AppState>,
    Form(form): Form<EditPasswordForm>,
) -> Result<impl IntoResponse, AppError> {
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);

    let db = &state.db_pool;
    let mut tx = db.begin().await?;
    let user = auth_session.user.clone().unwrap();
    let user_id = user.id;
    let user = find_user_by_id(&mut tx, user_id).await?;
    if user.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let user = user.unwrap();
    if user.verify_password(&form.current_password).is_err() {
        messages.error(
            bundle.format_pattern(
                bundle
                    .get_message("account-change-password-error-incorrect-current")
                    .unwrap()
                    .value()
                    .unwrap(),
                None,
                &mut vec![],
            ),
        );
        return Ok(Redirect::to("/account").into_response());
    }
    if form.new_password != form.new_password_confirm {
        messages.error(
            bundle.format_pattern(
                bundle
                    .get_message("account-change-password-error-new-mismatch")
                    .unwrap()
                    .value()
                    .unwrap(),
                None,
                &mut vec![],
            ),
        );
        return Ok(Redirect::to("/account").into_response());
    }
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
        return Ok(Redirect::to("/account").into_response());
    }
    let _ = update_password(&mut tx, user_id, form.new_password).await;
    let _ = tx.commit().await;

    messages.success(
        bundle.format_pattern(
            bundle
                .get_message("account-change-password-success")
                .unwrap()
                .value()
                .unwrap(),
            None,
            &mut vec![],
        ),
    );
    Ok(Redirect::to("/account").into_response())
}

pub async fn verify_email_verification_code(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Form(form): Form<EmailVerificationChallengeResponseForm>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await.unwrap();
    let challenge = find_email_verification_challenge_by_id(&mut tx, form.challenge_id)
        .await
        .unwrap();
    if challenge.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let challenge = challenge.unwrap();
    let now = Utc::now();

    let template: minijinja::Template<'_, '_> = state.env.get_template("email_verify.jinja")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);

    if challenge.token != form.token {
        let ftl_lang = bundle.locales.first().unwrap().to_string();
        let rendered = template.render(context! {
            challenge_id => challenge.id,
            email => challenge.email,
            message => bundle.format_pattern(bundle.get_message("account-change-email-error-token-mismatch").unwrap().value().unwrap(), None, &mut vec![]),
            success => false,
            ftl_lang
        })?;

        return Ok(Html(rendered).into_response());
    }

    if challenge.expires_at < now {
        let ftl_lang = bundle.locales.first().unwrap().to_string();
        let rendered = template.render(context! {
            challenge_id => challenge.id,
            email => challenge.email,
            message => bundle.format_pattern(bundle.get_message("account-change-email-error-token-expired").unwrap().value().unwrap(), None, &mut vec![]),
            success => false,
            ftl_lang
        })?;

        return Ok(Html(rendered).into_response());
    }

    let _ = update_user_email_verified_at(
        &mut tx,
        auth_session.user.unwrap().id,
        challenge.clone().email,
        now,
    )
    .await;
    let _ = tx.commit().await;

    let ftl_lang = bundle.locales.first().unwrap().to_string();
    let rendered = template.render(context! {
        challenge_id => challenge.id,
        email => challenge.email,
        message => bundle.format_pattern(bundle.get_message("account-change-email-success").unwrap().value().unwrap(), None, &mut vec![]),
        success => true,
        ftl_lang
    })?;

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct RequestEmailVerificationCodeForm {
    email: String,
}

pub async fn request_email_verification_code(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Form(form): Form<RequestEmailVerificationCodeForm>,
) -> Result<impl IntoResponse, AppError> {
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let edit_email_template = state.env.get_template("email_edit.jinja")?;

    let current_email = auth_session.user.clone().unwrap().email;
    if current_email.is_some()
        && current_email.unwrap() == form.email
        && auth_session
            .user
            .clone()
            .unwrap()
            .email_verified_at
            .is_some()
    {
        let ftl_lang = bundle.locales.first().unwrap().to_string();
        return Ok(Html(edit_email_template.render(context! {
            current_user => auth_session.user,
            default_community_id => state.config.default_community_id.clone(),
            message => bundle.format_pattern(
                bundle
                    .get_message("account-change-email-error-already-verified")
                    .unwrap()
                    .value()
                    .unwrap(),
                None,
                &mut vec![],
            ),
            ftl_lang,
        })?)
        .into_response());
    }

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let token = {
        let mut rng = thread_rng();
        let token: String = (0..6)
            .map(|_| rng.gen_range(0..10).to_string())
            .collect::<Vec<String>>()
            .join("");
        token
    };

    let expires_at = Utc::now() + TimeDelta::try_seconds(60 * 5).unwrap();

    let email_verification_challenge = create_email_verification_challenge(
        &mut tx,
        auth_session.user.unwrap().id,
        &form.email,
        &token,
        expires_at,
    )
    .await?;
    let _ = tx.commit().await;

    let email = Message::builder()
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
        .to(form.email.clone().parse().unwrap())
        .subject(
            bundle.format_pattern(
                bundle
                    .get_message("account-change-email-subject")
                    .unwrap()
                    .value()
                    .unwrap(),
                None,
                &mut vec![],
            ),
        )
        .body(email_verification_challenge.token.clone().to_string())
        .unwrap();

    let mailer = SmtpTransport::relay(&state.config.smtp_host)
        .unwrap()
        .credentials(SmtpCredentials::new(
            state.config.smtp_user.clone(),
            state.config.smtp_password.clone(),
        ))
        .build();

    let _ = mailer.send(&email).unwrap();

    let template: minijinja::Template<'_, '_> = state.env.get_template("email_verify.jinja")?;
    let ftl_lang = bundle.locales.first().unwrap().to_string();

    let rendered = template.render(context! {
        challenge_id => email_verification_challenge.id,
        email => form.email,
        ftl_lang,
    })?;

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct EditUserForm {
    login_name: String,
    display_name: String,
}

pub async fn edit_account(
    messages: Messages,
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Form(form): Form<EditUserForm>,
) -> Result<impl IntoResponse, AppError> {
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);

    let db = &state.db_pool;
    let mut tx = db.begin().await?;
    let user_id = auth_session.user.unwrap().id;
    let _ = update_user_with_activity(
        &mut tx,
        user_id,
        form.login_name,
        form.display_name,
        &state.config,
        Some(&state),
    )
    .await;
    let _ = tx.commit().await;

    messages.success(
        bundle.format_pattern(
            bundle
                .get_message("account-info-edit-success")
                .unwrap()
                .value()
                .unwrap(),
            None,
            &mut vec![],
        ),
    );
    Ok(Redirect::to("/account").into_response())
}

#[derive(Deserialize)]
pub struct DeleteAccountRequest {
    password: String,
}

#[derive(serde::Serialize)]
pub struct DeleteAccountResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub async fn delete_account(
    mut auth_session: AuthSession,
    State(state): State<AppState>,
    Json(payload): Json<DeleteAccountRequest>,
) -> Result<impl IntoResponse, AppError> {
    let user = match auth_session.user.as_ref() {
        Some(user) => user.clone(),
        None => {
            return Ok((
                StatusCode::UNAUTHORIZED,
                Json(DeleteAccountResponse {
                    success: false,
                    error: Some("Not authenticated".to_string()),
                }),
            )
                .into_response())
        }
    };

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Attempt to delete the user
    match delete_user_with_activity(
        &mut tx,
        user.id,
        &payload.password,
        &state.config,
        Some(&state),
    )
    .await
    {
        Ok(_) => {
            tx.commit().await?;

            // Log the user out
            auth_session.logout().await?;

            Ok((
                StatusCode::OK,
                Json(DeleteAccountResponse {
                    success: true,
                    error: None,
                }),
            )
                .into_response())
        }
        Err(e) => {
            tx.rollback().await?;

            Ok((
                StatusCode::BAD_REQUEST,
                Json(DeleteAccountResponse {
                    success: false,
                    error: Some(e.to_string()),
                }),
            )
                .into_response())
        }
    }
}

#[derive(Deserialize)]
pub struct DeleteAccountForm {
    password: String,
}

pub async fn delete_account_htmx(
    mut auth_session: AuthSession,
    State(state): State<AppState>,
    Form(form): Form<DeleteAccountForm>,
) -> Result<impl IntoResponse, AppError> {
    let user = match auth_session.user.as_ref() {
        Some(user) => user.clone(),
        None => {
            return Ok(Redirect::to("/login").into_response());
        }
    };

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Attempt to delete the user
    match delete_user_with_activity(
        &mut tx,
        user.id,
        &form.password,
        &state.config,
        Some(&state),
    )
    .await
    {
        Ok(_) => {
            tx.commit().await?;

            // Log the user out
            auth_session.logout().await?;

            // Redirect to homepage with HX-Redirect header
            Ok((
                StatusCode::OK,
                [("HX-Redirect", "/")],
            )
                .into_response())
        }
        Err(e) => {
            tx.rollback().await?;

            // Return error message as HTML for HTMX to display
            let error_html = format!(
                r#"<div class="error-message">{}</div>"#,
                e.to_string()
            );
            Ok((StatusCode::BAD_REQUEST, Html(error_html)).into_response())
        }
    }
}
