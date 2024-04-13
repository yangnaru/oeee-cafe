use crate::app_error::AppError;
use crate::models::email_verification_challenge::{
    create_email_verification_challenge, find_email_verification_challenge_by_id,
};
use crate::models::post::get_draft_post_count;
use crate::models::user::{
    find_user_by_id, update_password, update_user, update_user_email_verified_at, AuthSession,
};
use crate::web::state::AppState;
use axum::debug_handler;
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

#[derive(Deserialize)]
pub struct EmailVerificationChallengeResponseForm {
    pub challenge_id: Uuid,
    pub token: String,
}

pub async fn account(
    messages: Messages,
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

    let template: minijinja::Template<'_, '_> = state.env.get_template("account.html")?;
    let rendered = template.render(context! {
        title => "계정",
        current_user => auth_session.user,
        draft_post_count,
        messages => messages.into_iter().collect::<Vec<_>>(),
    })?;

    Ok(Html(rendered))
}

#[derive(Deserialize)]
pub struct EditPasswordForm {
    current_password: String,
    new_password: String,
    new_password_confirm: String,
}

#[debug_handler]
pub async fn edit_password(
    auth_session: AuthSession,
    messages: Messages,
    State(state): State<AppState>,
    Form(form): Form<EditPasswordForm>,
) -> Result<impl IntoResponse, AppError> {
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
        messages.error("기존 비밀번호가 틀렸습니다.");
        return Ok(Redirect::to("/account").into_response());
    }
    if form.new_password != form.new_password_confirm {
        messages.error("새로운 비밀번호가 일치하지 않습니다.");
        return Ok(Redirect::to("/account").into_response());
    }
    if form.new_password.len() < 8 {
        messages.error("비밀번호는 8자 이상이어야 합니다.");
        return Ok(Redirect::to("/account").into_response());
    }
    let _ = update_password(&mut tx, user_id, form.new_password).await;
    let _ = tx.commit().await;

    messages.success("비밀번호가 변경되었습니다.");
    Ok(Redirect::to("/account").into_response())
}

#[debug_handler]
pub async fn verify_email_verification_code(
    auth_session: AuthSession,
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

    let template: minijinja::Template<'_, '_> = state.env.get_template("email_verify.html")?;

    if challenge.token != form.token {
        let rendered = template.render(context! {
            challenge_id => challenge.id,
            email => challenge.email,
            message => "인증 코드가 일치하지 않습니다.".to_string(),
            success => false,
        })?;

        return Ok(Html(rendered).into_response());
    }

    if challenge.expires_at < now {
        let rendered = template.render(context! {
            challenge_id => challenge.id,
            email => challenge.email,
            message => "인증 코드가 만료되었습니다.".to_string(),
            success => false,
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
        message => "이메일 주소가 인증되었습니다.".to_string(),
        success => true,
    })?;

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct RequestEmailVerificationCodeForm {
    email: String,
}

pub async fn request_email_verification_code(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Form(form): Form<RequestEmailVerificationCodeForm>,
) -> Result<impl IntoResponse, AppError> {
    let edit_email_template = state.env.get_template("email_edit.html")?;

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
            message => "이미 인증된 이메일 주소입니다.".to_string(),
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
        .from(state.config.email_from_address.clone().parse().unwrap())
        .to(form.email.clone().parse().unwrap())
        .subject("오이카페 이메일 주소 인증 코드")
        .body(format!(
            "인증 코드: {}",
            email_verification_challenge.token.clone()
        ))
        .unwrap();

    let mailer = SmtpTransport::relay(&state.config.smtp_host)
        .unwrap()
        .credentials(SmtpCredentials::new(
            state.config.smtp_user.clone(),
            state.config.smtp_password.clone(),
        ))
        .build();

    let _ = mailer.send(&email).unwrap();

    let template: minijinja::Template<'_, '_> = state.env.get_template("email_verify.html")?;

    let rendered = template.render(context! {
        challenge_id => email_verification_challenge.id,
        email => form.email,
    })?;

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct EditUserForm {
    login_name: String,
    user_id: String,
    display_name: String,
}

pub async fn edit_account(
    messages: Messages,
    State(state): State<AppState>,
    Form(form): Form<EditUserForm>,
) -> Result<impl IntoResponse, AppError> {
    let user_id = Uuid::parse_str(&form.user_id)?;

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let _ = update_user(&mut tx, user_id, form.login_name, form.display_name).await;
    let _ = tx.commit().await;

    messages.success("계정 정보가 수정되었습니다.");
    Ok(Redirect::to("/account").into_response())
}
