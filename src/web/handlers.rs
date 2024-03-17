use super::state::AppState;
use crate::app_error::AppError;
use crate::models::community::{
    create_community, find_community_by_id, get_own_communities, CommunityDraft,
};
use crate::models::user::{create_user, update_user, AuthSession, Credentials, UserDraft};
use aws_sdk_s3::config::{Credentials as AwsCredentials, Region, SharedCredentialsProvider};
use aws_sdk_s3::error::SdkError;
use aws_sdk_s3::operation::put_object::{PutObjectError, PutObjectOutput};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;
use axum::debug_handler;
use axum::extract::{Path, Query};
use axum::response::{IntoResponse, Redirect};
use axum::{
    extract::{Multipart, State},
    http::StatusCode,
    response::Html,
    Form,
};
use axum_messages::Messages;
use data_url::DataUrl;
use minijinja::context;
use minijinja_autoreload::EnvironmentGuard;
use serde::Deserialize;
use sha256::{digest, try_digest};
use std::{fs::File, io::Write};
use uuid::Uuid;

#[debug_handler]
pub async fn home(
    auth_session: AuthSession,
    State(state): State<AppState>,
    messages: Messages,
) -> Result<Html<String>, AppError> {
    let communities = match auth_session.user.clone() {
        Some(user) => {
            let db = state.config.connect_database().await?;
            let mut tx = db.begin().await?;
            let communities = get_own_communities(&mut tx, user.id).await?;
            let _ = tx.commit().await;
            communities
        }
        None => vec![],
    };

    let env: EnvironmentGuard<'_> = state.reloader.acquire_env().unwrap();
    let template: minijinja::Template<'_, '_> = env.get_template("home.html").unwrap();

    let rendered = template
        .clone()
        .render(context! {
            title => "홈",
            current_user => auth_session.user,
            messages => messages.into_iter().collect::<Vec<_>>(),
            communities,
        })
        .unwrap();

    Ok(Html(rendered))
}

pub async fn account(
    auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<Html<String>, StatusCode> {
    let env: EnvironmentGuard<'_> = state.reloader.acquire_env().unwrap();
    let template: minijinja::Template<'_, '_> = env.get_template("account.html").unwrap();

    let rendered = template
        .render(context! {
            title => "계정",
            current_user => auth_session.user,
        })
        .unwrap();

    Ok(Html(rendered))
}

pub async fn new_community_post(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Html<String>, AppError> {
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let community = find_community_by_id(&mut tx, id).await?;

    let env: EnvironmentGuard<'_> = state.reloader.acquire_env().unwrap();
    let template: minijinja::Template<'_, '_> = env.get_template("draw_post.html").unwrap();

    let rendered = template
        .render(context! {
            current_user => auth_session.user,
            community => community,
        })
        .unwrap();

    Ok(Html(rendered))
}

pub async fn community(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let community = find_community_by_id(&mut tx, id).await?;

    if community.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let env: EnvironmentGuard<'_> = state.reloader.acquire_env().unwrap();
    let template: minijinja::Template<'_, '_> = env.get_template("community.html").unwrap();
    let rendered = template
        .render(context! {
            community => community,
            current_user => auth_session.user,
        })
        .unwrap();

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct EditUserForm {
    user_id: String,
    display_name: String,
    email: String,
}

pub async fn edit_account(
    messages: Messages,
    State(state): State<AppState>,
    Form(form): Form<EditUserForm>,
) -> Result<impl IntoResponse, AppError> {
    let user_id = Uuid::parse_str(&form.user_id)?;

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let _ = update_user(&mut tx, user_id, form.display_name, form.email).await;
    let _ = tx.commit().await;

    messages.success("계정 정보가 수정되었습니다.");
    Ok(Redirect::to("/account").into_response())
}

#[derive(Deserialize)]
pub struct CreateCommunityForm {
    name: String,
    description: String,
}

pub async fn do_create_community(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Form(form): Form<CreateCommunityForm>,
) -> Result<impl IntoResponse, AppError> {
    let db: sqlx::Pool<sqlx::Postgres> = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let _ = create_community(
        &mut tx,
        auth_session.user.unwrap().id,
        CommunityDraft {
            name: form.name,
            description: form.description,
        },
    )
    .await;
    let _ = tx.commit().await;

    Ok(Redirect::to("/").into_response())
}

pub async fn create_community_form(
    auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<Html<String>, StatusCode> {
    let env: EnvironmentGuard<'_> = state.reloader.acquire_env().unwrap();
    let template: minijinja::Template<'_, '_> = env.get_template("create_community.html").unwrap();

    let rendered = template
        .render(context! {
            title => "커뮤니티 생성",
            current_user => auth_session.user,
        })
        .unwrap();

    Ok(Html(rendered))
}

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
) -> impl IntoResponse {
    let env = state.reloader.acquire_env().unwrap();
    let template: minijinja::Template<'_, '_> = env.get_template("signup.html").unwrap();

    let rendered: String = template
        .render(context! {
            messages => messages.into_iter().collect::<Vec<_>>(),
            next => next,
        })
        .unwrap();

    Html(rendered)
}

#[derive(Deserialize)]
pub struct CreateUserForm {
    login_name: String,
    password: String,
    password_confirm: String,
    display_name: String,
    email: String,
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

    let user_draft = UserDraft::new(
        form.login_name,
        form.password,
        form.display_name,
        form.email,
    )?;
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
) -> impl IntoResponse {
    let env = state.reloader.acquire_env().unwrap();
    let template: minijinja::Template<'_, '_> = env.get_template("login.html").unwrap();

    let collected_messages: Vec<axum_messages::Message> = messages.into_iter().collect();

    let rendered: String = template
        .render(context! {
            messages => collected_messages,
            next => next,
        })
        .unwrap();

    Html(rendered)
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

pub async fn draw(
    State(state): State<AppState>,
    auth_session: AuthSession,
) -> Result<Html<String>, StatusCode> {
    let env: EnvironmentGuard<'_> = state.reloader.acquire_env().unwrap();
    let template: minijinja::Template<'_, '_> = env.get_template("draw.html").unwrap();

    let some_example_entries: Vec<&str> = vec!["Data 1", "Data 2", "Data 3"];

    let rendered = template
        .render(context! {
            title => "그리기",
            entries => some_example_entries,
            current_user => auth_session.user,
        })
        .unwrap();

    Ok(Html(rendered))
}
#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub struct Input {
    width: String,
    height: String,
}

pub async fn start_draw(
    State(state): State<AppState>,
    Form(input): Form<Input>,
) -> Result<Html<String>, StatusCode> {
    let env: EnvironmentGuard<'_> = state.reloader.acquire_env().unwrap();
    let template: minijinja::Template<'_, '_> = env.get_template("draw_post.html").unwrap();

    let rendered = template
        .render(context! {
            title => "그리기",
            message => "그림을 그렸습니다!",
            width => input.width.parse::<u32>().unwrap(),
            height => input.height.parse::<u32>().unwrap(),
        })
        .unwrap();

    Ok(Html(rendered))
}

pub async fn upload_object(
    client: &Client,
    bucket_name: &str,
    bytes: Vec<u8>,
    key: &str,
) -> Result<PutObjectOutput, SdkError<PutObjectError>> {
    let body = ByteStream::from(bytes);
    client
        .put_object()
        .bucket(bucket_name)
        .key(key)
        .body(body)
        .send()
        .await
}

pub async fn draw_finish(
    State(_state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Html<String>, StatusCode> {
    let credentials: AwsCredentials = AwsCredentials::new(
        _state.config.aws_access_key_id.clone(),
        _state.config.aws_secret_access_key.clone(),
        None,
        None,
        "",
    );
    let credentials_provider = SharedCredentialsProvider::new(credentials);
    let config = aws_sdk_s3::Config::builder()
        .endpoint_url(_state.config.r2_endpoint_url.clone())
        .region(Region::new(_state.config.aws_region.clone()))
        .credentials_provider(credentials_provider)
        .behavior_version_latest()
        .build();
    let client = Client::from_conf(config);

    while let Some(field) = multipart.next_field().await.unwrap() {
        let name = field.name().unwrap().to_string();
        let data = field.bytes().await.unwrap();

        if name == "image" {
            let url = DataUrl::process(std::str::from_utf8(data.as_ref()).unwrap()).unwrap();
            let (body, _fragment) = url.decode_to_vec().unwrap();
            let digest: String = digest(&body);

            assert_eq!(url.mime_type().type_, "image");
            assert_eq!(url.mime_type().subtype, "png");

            upload_object(
                &client,
                &_state.config.aws_s3_bucket,
                body,
                &format!(
                    "image/{}{}/{}.png",
                    digest.chars().nth(0).unwrap(),
                    digest.chars().nth(1).unwrap(),
                    digest
                ),
            )
            .await;
        } else if name == "animation" {
            let digest = digest(&*data);

            upload_object(
                &client,
                &_state.config.aws_s3_bucket,
                data.to_vec(),
                &format!(
                    "replay/{}{}/{}.pch",
                    digest.chars().nth(0).unwrap(),
                    digest.chars().nth(1).unwrap(),
                    digest
                ),
            )
            .await;
        }

        println!("Length of `{}` is {} bytes", name, data.len());
    }
    Ok(Html("".to_string()))
}

pub async fn about(
    State(state): State<AppState>,
    auth_session: AuthSession,
) -> Result<Html<String>, StatusCode> {
    let env: EnvironmentGuard<'_> = state.reloader.acquire_env().unwrap();
    let template: minijinja::Template<'_, '_> = env.get_template("about.html").unwrap();

    let rendered: String = template
        .render(context! {
            current_user => auth_session.user,
        })
        .unwrap();

    Ok(Html(rendered))
}
