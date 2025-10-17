use crate::app_error::AppError;
use crate::models::user::{create_user, AuthSession, Credentials, UserDraft};
use crate::web::handlers::{get_bundle, ExtractFtlLang};
use crate::web::state::AppState;
use axum::extract::Query;
use axum::response::{IntoResponse, Redirect};
use axum::{extract::State, http::StatusCode, response::Html, Form};
use axum_messages::Messages;
use fluent::{FluentArgs, FluentValue};
use minijinja::context;
use serde::Deserialize;

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
