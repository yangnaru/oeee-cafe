use crate::app_error::AppError;
use crate::models::user::{create_user, AuthSession, Credentials, UserDraft};
use crate::web::state::AppState;
use axum::extract::Query;
use axum::response::{IntoResponse, Redirect};
use axum::{extract::State, http::StatusCode, response::Html, Form};
use axum_messages::Messages;
use minijinja::context;
use serde::Deserialize;

// This allows us to extract the "next" field from the query string. We use this
// to redirect after log in.
#[derive(Debug, Deserialize)]
pub struct NextUrl {
    next: Option<String>,
}

pub async fn signup(
    messages: Messages,
    Query(NextUrl { next }): Query<NextUrl>,
    State(state): State<crate::web::state::AppState>,
) -> Result<impl IntoResponse, AppError> {
    let template: minijinja::Template<'_, '_> = state.env.get_template("signup.html")?;

    let rendered: String = template.render(context! {
        messages => messages.into_iter().collect::<Vec<_>>(),
        next => next,
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
    messages: Messages,
    State(state): State<AppState>,
    Form(form): Form<CreateUserForm>,
) -> Result<impl IntoResponse, AppError> {
    if form.password != form.password_confirm {
        messages.error("비밀번호가 일치하지 않습니다.");
        return Ok(Redirect::to("/signup").into_response());
    }

    let user_draft = UserDraft::new(form.login_name, form.password, form.display_name)?;
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let user = create_user(&mut tx, user_draft).await?;
    tx.commit().await?;

    if auth_session.login(&user).await.is_err() {
        return Ok(StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    messages.success(format!("{}님, 환영합니다!", user.login_name));
    if let Some(ref next) = form.next {
        Ok(Redirect::to(next).into_response())
    } else {
        Ok(Redirect::to("/").into_response())
    }
}

pub async fn login(
    messages: Messages,
    Query(NextUrl { next }): Query<NextUrl>,
    State(state): State<crate::web::state::AppState>,
) -> Result<impl IntoResponse, AppError> {
    let template: minijinja::Template<'_, '_> = state.env.get_template("login.html")?;

    let collected_messages: Vec<axum_messages::Message> = messages.into_iter().collect();

    let rendered: String = template.render(context! {
        messages => collected_messages,
        next => next,
    })?;

    Ok(Html(rendered))
}

pub async fn do_login(
    mut auth_session: AuthSession,
    messages: Messages,
    Form(creds): Form<Credentials>,
) -> impl IntoResponse {
    let user = match auth_session.authenticate(creds.clone()).await {
        Ok(Some(user)) => user,
        Ok(None) => {
            messages.error("아이디 또는 비밀번호가 틀렸습니다.");

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

    messages.success(format!("{}님, 환영합니다!", user.login_name));

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
