use crate::app_error::AppError;
use crate::models::email_verification_challenge::{
    create_email_verification_challenge, find_email_verification_challenge_by_id,
};
use crate::models::post::get_draft_post_count;
use crate::models::actor::update_actor_for_user;
use crate::models::user::{
    find_user_by_id, update_password, update_user, update_user_email_verified_at,
    update_user_preferred_language, AuthSession, Language,
};
use crate::web::handlers::{create_base_ftl_context, get_bundle};
use crate::web::state::AppState;
use axum::response::{IntoResponse, Redirect};
use axum::{extract::State, http::StatusCode, response::Html, Form};
use axum_messages::Messages;
use chrono::{TimeDelta, Utc};

use lettre::transport::smtp::authentication::Credentials as SmtpCredentials;
use lettre::{Message, SmtpTransport, Transport};
use minijinja::context;
use rand::{thread_rng, Rng};
use serde::Deserialize;
use uuid::Uuid;

use super::ExtractAcceptLanguage;

#[derive(Deserialize)]
pub struct EmailVerificationChallengeResponseForm {
    pub challenge_id: Uuid,
    pub token: String,
}

pub async fn account(
    messages: Messages,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    auth_session: AuthSession,
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

    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);

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
        draft_post_count,
        messages => messages.into_iter().collect::<Vec<_>>(),
        ..create_base_ftl_context(&bundle)
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
    let db = state.config.connect_database().await?;
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

    let db = state.config.connect_database().await?;
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
    let db = state.config.connect_database().await.unwrap();
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
        let rendered = template.render(context! {
            challenge_id => challenge.id,
            email => challenge.email,
            message => bundle.format_pattern(bundle.get_message("account-change-email-error-token-mismatch").unwrap().value().unwrap(), None, &mut vec![]),
            success => false,
            ..create_base_ftl_context(&bundle)
        })?;

        return Ok(Html(rendered).into_response());
    }

    if challenge.expires_at < now {
        let rendered = template.render(context! {
            challenge_id => challenge.id,
            email => challenge.email,
            message => bundle.format_pattern(bundle.get_message("account-change-email-error-token-expired").unwrap().value().unwrap(), None, &mut vec![]),
            success => false,
            ..create_base_ftl_context(&bundle)
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

    let rendered = template.render(context! {
        challenge_id => challenge.id,
        email => challenge.email,
        message => bundle.format_pattern(bundle.get_message("account-change-email-success").unwrap().value().unwrap(), None, &mut vec![]),
        success => true,
        ..create_base_ftl_context(&bundle)
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
            ..create_base_ftl_context(&bundle),
        })?)
        .into_response());
    }

    let db = state.config.connect_database().await?;
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

    let rendered = template.render(context! {
        challenge_id => email_verification_challenge.id,
        email => form.email,
        ..create_base_ftl_context(&bundle),
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

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let user_id = auth_session.user.unwrap().id;
    let _ = update_user(
        &mut tx,
        user_id,
        form.login_name.clone(),
        form.display_name.clone(),
    )
    .await;
    let _ = update_actor_for_user(
        &mut tx,
        user_id,
        form.login_name,
        form.display_name,
        &state.config,
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
