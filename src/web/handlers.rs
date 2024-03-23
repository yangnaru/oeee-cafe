use super::state::AppState;
use crate::app_error::AppError;
use crate::models::community::{
    create_community, find_community_by_id, get_own_communities, get_public_communities,
    CommunityDraft,
};
use crate::models::post::{
    create_post, find_draft_posts_by_author_id, find_post_by_id,
    find_published_posts_by_community_id, get_draft_post_count, increment_post_viewer_count,
    publish_post, PostDraft,
};
use crate::models::user::{
    create_user, find_user_by_id, update_password, update_user, AuthSession, Credentials, UserDraft,
};
use aws_sdk_s3::config::{Credentials as AwsCredentials, Region, SharedCredentialsProvider};
use aws_sdk_s3::error::SdkError;
use aws_sdk_s3::operation::put_object::{PutObjectError, PutObjectOutput};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;
use axum::extract::{Path, Query};
use axum::response::{IntoResponse, Redirect};
use axum::{debug_handler, Json};
use axum::{
    extract::{Multipart, State},
    http::StatusCode,
    response::Html,
    Form,
};
use axum_messages::Messages;
use chrono::Duration;
use data_encoding::BASE64URL_NOPAD;
use data_url::DataUrl;
use minijinja::context;
use minijinja_autoreload::EnvironmentGuard;
use serde::{Deserialize, Serialize};
use sha256::digest;
use sqlx::postgres::types::PgInterval;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub async fn home(
    auth_session: AuthSession,
    State(state): State<AppState>,
    messages: Messages,
) -> Result<Html<String>, AppError> {
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;

    let own_communities = match auth_session.user.clone() {
        Some(user) => get_own_communities(&mut tx, user.id).await?,
        None => vec![],
    };

    let own_communities = own_communities
        .iter()
        .map(|community| {
            let name = community.name.clone();
            let description = community.description.clone();
            let is_private = community.is_private;
            let updated_at = community.updated_at.to_string();
            let created_at = community.created_at.to_string();
            let link = format!(
                "/communities/{}",
                BASE64URL_NOPAD.encode(community.id.as_bytes())
            );
            HashMap::<String, String>::from_iter(vec![
                ("name".to_string(), name),
                ("description".to_string(), description),
                ("is_private".to_string(), is_private.to_string()),
                ("updated_at".to_string(), updated_at),
                ("created_at".to_string(), created_at),
                ("link".to_string(), link),
            ])
        })
        .collect::<Vec<_>>();

    let public_communities = get_public_communities(&mut tx)
        .await?
        .iter()
        .map(|community| {
            let name = community.name.clone();
            let description = community.description.clone();
            let is_private = community.is_private;
            let updated_at = community.updated_at.to_string();
            let created_at = community.created_at.to_string();
            let link = format!(
                "/communities/{}",
                BASE64URL_NOPAD.encode(community.id.as_bytes())
            );
            HashMap::<String, String>::from_iter(vec![
                ("name".to_string(), name),
                ("description".to_string(), description),
                ("is_private".to_string(), is_private.to_string()),
                ("updated_at".to_string(), updated_at),
                ("created_at".to_string(), created_at),
                ("link".to_string(), link),
            ])
        })
        .collect::<Vec<_>>();

    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    println!("{:?}", public_communities);

    let env: EnvironmentGuard<'_> = state.reloader.acquire_env()?;
    let template: minijinja::Template<'_, '_> = env.get_template("home.html")?;

    let rendered = template.clone().render(context! {
        title => "홈",
        current_user => auth_session.user,
        messages => messages.into_iter().collect::<Vec<_>>(),
        draft_post_count,
        public_communities,
        own_communities,
    })?;

    Ok(Html(rendered))
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

    let env: EnvironmentGuard<'_> = state.reloader.acquire_env()?;
    let template: minijinja::Template<'_, '_> = env.get_template("account.html")?;
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

pub async fn new_community_post(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Html<String>, AppError> {
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let community = find_community_by_id(&mut tx, id).await?;
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let env: EnvironmentGuard<'_> = state.reloader.acquire_env()?;
    let template: minijinja::Template<'_, '_> = env.get_template("draw_post.html")?;

    let rendered = template.render(context! {
        current_user => auth_session.user,
        community => community,
        draft_post_count,
    })?;

    Ok(Html(rendered))
}

pub async fn community(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let uuid = Uuid::from_slice(BASE64URL_NOPAD.decode(id.as_bytes()).unwrap().as_slice())?;
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let community = find_community_by_id(&mut tx, uuid).await?;

    if community.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let posts = find_published_posts_by_community_id(&mut tx, uuid).await?;
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let env: EnvironmentGuard<'_> = state.reloader.acquire_env()?;
    let template: minijinja::Template<'_, '_> = env.get_template("community.html")?;
    let rendered = template.render(context! {
        community => community,
        current_user => auth_session.user,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        posts => posts.iter().map(|post| {
            HashMap::<String, String>::from_iter(vec![
                ("id".to_string(), post.id.to_string()),
                ("title".to_string(), post.title.clone().unwrap_or_default().to_string()),
                ("author_id".to_string(), post.author_id.to_string()),
                ("image_filename".to_string(), post.image_filename.to_string()),
                ("replay_filename".to_string(), post.replay_filename.to_string()),
                ("created_at".to_string(), post.created_at.to_string()),
                ("updated_at".to_string(), post.updated_at.to_string()),
            ])
        }).collect::<Vec<_>>(),
        draft_post_count,
    })?;

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

pub async fn draft_posts(
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
    let posts =
        find_draft_posts_by_author_id(&mut tx, auth_session.user.clone().unwrap().id).await?;

    let env: EnvironmentGuard<'_> = state.reloader.acquire_env()?;
    let template: minijinja::Template<'_, '_> = env.get_template("draft_posts.html")?;
    let rendered = template.render(context! {
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        current_user => auth_session.user,
        posts => posts,
        draft_post_count,
    })?;

    Ok(Html(rendered))
}

pub async fn handler_404() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, "nothing to see here")
}

pub async fn post_view(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let uuid = Uuid::from_slice(BASE64URL_NOPAD.decode(id.as_bytes()).unwrap().as_slice()).unwrap();
    let db = state.config.connect_database().await.unwrap();
    let mut tx: sqlx::Transaction<'_, sqlx::Postgres> = db.begin().await.unwrap();
    let post = find_post_by_id(&mut tx, uuid).await.unwrap();

    match post {
        Some(_) => {
            increment_post_viewer_count(&mut tx, uuid).await.unwrap();
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
    tx.commit().await?;

    let encoded_community_id = BASE64URL_NOPAD.encode(community_id.as_bytes());
    let env: EnvironmentGuard<'_> = state.reloader.acquire_env().unwrap();
    let template: minijinja::Template<'_, '_> = env.get_template("post_view.html").unwrap();
    let rendered = template
        .render(context! {
            current_user => auth_session.user,
            r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
            post => {
                match post {
                    Some(ref post) => Some(post),
                    None => None,
                }
            },
            encoded_post_id => BASE64URL_NOPAD.encode(Uuid::parse_str(&post.unwrap().get("id").unwrap().as_ref().unwrap()).as_ref().unwrap().as_bytes()),
            encoded_community_id,
            draft_post_count,
        })
        .unwrap();
    Ok(Html(rendered).into_response())
}

pub async fn post_replay_view(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let uuid = Uuid::from_slice(BASE64URL_NOPAD.decode(id.as_bytes()).unwrap().as_slice()).unwrap();
    let db = state.config.connect_database().await.unwrap();
    let mut tx: sqlx::Transaction<'_, sqlx::Postgres> = db.begin().await.unwrap();
    let post = find_post_by_id(&mut tx, uuid).await.unwrap();
    if post == None {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    println!("{:?}", post);

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
    let encoded_community_id = BASE64URL_NOPAD.encode(community_id.as_bytes());
    let env: EnvironmentGuard<'_> = state.reloader.acquire_env().unwrap();
    let template: minijinja::Template<'_, '_> = env.get_template("post_replay_view.html").unwrap();
    let rendered = template
        .render(context! {
            current_user => auth_session.user,
            r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
            post => {
                match post {
                    Some(ref post) => Some(post),
                    None => None,
                }
            },
            encoded_post_id => BASE64URL_NOPAD.encode(Uuid::parse_str(&post.unwrap().get("id").unwrap().as_ref().unwrap()).as_ref().unwrap().as_bytes()),
            encoded_community_id,
            draft_post_count,
        })
        .unwrap();
    Ok(Html(rendered).into_response())
}

pub async fn post_publish_form(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let post_uuid =
        Uuid::from_slice(BASE64URL_NOPAD.decode(id.as_bytes()).unwrap().as_slice()).unwrap();

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let post = find_post_by_id(&mut tx, post_uuid).await?;

    println!("{:?}", post);

    let published_at = post.clone().unwrap().get("published_at").unwrap().clone();
    if published_at != None {
        return Ok(Redirect::to(&format!("/posts/{}", id)).into_response());
    }

    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let community_id = Uuid::parse_str(
        &post
            .clone()
            .unwrap()
            .get("community_id")
            .unwrap()
            .as_ref()
            .unwrap(),
    )?;
    let link = format!(
        "/communities/{}",
        BASE64URL_NOPAD.encode(community_id.as_bytes())
    );

    let env: EnvironmentGuard<'_> = state.reloader.acquire_env()?;
    let template: minijinja::Template<'_, '_> = env.get_template("post_form.html")?;

    let rendered = template.render(context! {
        current_user => auth_session.user,
        link,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        post => {
            match post {
                Some(post) => Some(post),
                None => None,
            }
        },
        draft_post_count,
    })?;

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct PostPublishForm {
    post_id: String,
    title: String,
    content: String,
    is_sensitive: Option<String>,
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
            .clone()
            .unwrap(),
    )?;
    let user_id = auth_session.user.unwrap().id;
    if author_id != user_id {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let is_sensitive = form.is_sensitive == Some("on".to_string());
    let _ = publish_post(&mut tx, post_id, form.title, form.content, is_sensitive).await;
    let _ = tx.commit().await;

    let community_id = Uuid::parse_str(
        &post
            .clone()
            .unwrap()
            .get("community_id")
            .unwrap()
            .clone()
            .unwrap(),
    )?;
    let encoded_community_id = { BASE64URL_NOPAD.encode(community_id.as_bytes()) };
    Ok(Redirect::to(&format!("/communities/{}", encoded_community_id)).into_response())
}

#[derive(Deserialize)]
pub struct CreateCommunityForm {
    name: String,
    description: String,
    is_private: Option<String>,
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
            is_private: form.is_private == Some("on".to_string()),
        },
    )
    .await;
    let _ = tx.commit().await;

    Ok(Redirect::to("/").into_response())
}

pub async fn create_community_form(
    auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<Html<String>, AppError> {
    let db: sqlx::Pool<sqlx::Postgres> = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let env: EnvironmentGuard<'_> = state.reloader.acquire_env()?;
    let template: minijinja::Template<'_, '_> = env.get_template("create_community.html")?;
    let rendered = template.render(context! {
        title => "커뮤니티 생성",
        current_user => auth_session.user,
        draft_post_count,
    })?;

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
) -> Result<impl IntoResponse, AppError> {
    let env = state.reloader.acquire_env()?;
    let template: minijinja::Template<'_, '_> = env.get_template("signup.html")?;

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
) -> Result<impl IntoResponse, AppError> {
    let env = state.reloader.acquire_env()?;
    let template: minijinja::Template<'_, '_> = env.get_template("login.html")?;

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

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub struct Input {
    width: String,
    height: String,
    community_id: String,
}

pub async fn start_draw(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Form(input): Form<Input>,
) -> Result<Html<String>, AppError> {
    let env: EnvironmentGuard<'_> = state.reloader.acquire_env()?;
    let template: minijinja::Template<'_, '_> = env.get_template("draw_post.html")?;

    let rendered = template.render(context! {
        title => "그리기",
        message => "그림을 그렸습니다!",
        width => input.width.parse::<u32>()?,
        height => input.height.parse::<u32>()?,
        community_id => input.community_id,
        current_user => auth_session.user,
    })?;

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

#[derive(Serialize)]
pub struct DrawFinishResponse {
    pub community_id: String,
    pub post_id: String,
}

#[debug_handler]
pub async fn draw_finish(
    auth_session: AuthSession,
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<DrawFinishResponse>, AppError> {
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

    let mut width = 0;
    let mut height = 0;
    let mut image_sha256 = String::new();
    let mut replay_sha256 = String::new();
    let mut community_id = Uuid::nil();
    let mut security_timer = 0;
    let mut security_count = 0;

    while let Some(field) = multipart.next_field().await.unwrap() {
        let name = field.name().unwrap().to_string();
        let data = field.bytes().await.unwrap();

        if name == "image" {
            let url = DataUrl::process(std::str::from_utf8(data.as_ref()).unwrap()).unwrap();
            let (body, _fragment) = url.decode_to_vec().unwrap();
            image_sha256 = digest(&body);

            assert_eq!(url.mime_type().type_, "image");
            assert_eq!(url.mime_type().subtype, "png");

            upload_object(
                &client,
                &state.config.aws_s3_bucket,
                body,
                &format!(
                    "image/{}{}/{}.png",
                    image_sha256.chars().nth(0).unwrap(),
                    image_sha256.chars().nth(1).unwrap(),
                    image_sha256
                ),
            )
            .await?;
        } else if name == "animation" {
            replay_sha256 = digest(&*data);

            upload_object(
                &client,
                &state.config.aws_s3_bucket,
                data.to_vec(),
                &format!(
                    "replay/{}{}/{}.pch",
                    replay_sha256.chars().nth(0).unwrap(),
                    replay_sha256.chars().nth(1).unwrap(),
                    replay_sha256
                ),
            )
            .await?;
        } else if name == "community_id" {
            community_id = Uuid::parse_str(std::str::from_utf8(data.as_ref()).unwrap()).unwrap();
        } else if name == "security_timer" {
            security_timer = std::str::from_utf8(data.as_ref())
                .unwrap()
                .parse::<u128>()
                .unwrap();
        } else if name == "security_count" {
            security_count = std::str::from_utf8(data.as_ref())
                .unwrap()
                .parse::<i32>()
                .unwrap();
        } else if name == "width" {
            width = std::str::from_utf8(data.as_ref())
                .unwrap()
                .parse::<i32>()
                .unwrap();
        } else if name == "height" {
            height = std::str::from_utf8(data.as_ref())
                .unwrap()
                .parse::<i32>()
                .unwrap();
        }
        println!("Length of `{}` is {} bytes", name, data.len());
    }
    let start = SystemTime::now();
    let since_the_epoch = start
        .duration_since(UNIX_EPOCH)
        .expect("Time went backwards");
    println!(
        "duration_secs: {:?}",
        (since_the_epoch.as_millis() - security_timer)
    );
    let duration_ms = since_the_epoch.as_millis() - security_timer;

    let post_draft = PostDraft {
        author_id: auth_session.user.unwrap().id,
        community_id: community_id.clone(),
        paint_duration: PgInterval::try_from(
            Duration::try_milliseconds(duration_ms as i64).unwrap_or_default(),
        )
        .unwrap_or_default(),
        stroke_count: security_count,
        width,
        height,
        image_filename: format!("{}.png", image_sha256),
        replay_filename: format!("{}.pch", replay_sha256),
    };

    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let post = create_post(&mut tx, post_draft).await?;
    let t = tx.commit().await;

    println!("{:?}", post);
    println!("{:?}", t);

    Ok(Json(DrawFinishResponse {
        community_id: BASE64URL_NOPAD.encode(community_id.as_ref()),
        post_id: post.id,
    }))
}

pub async fn about(
    State(state): State<AppState>,
    auth_session: AuthSession,
) -> Result<Html<String>, AppError> {
    let db: sqlx::Pool<sqlx::Postgres> = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let env: EnvironmentGuard<'_> = state.reloader.acquire_env()?;
    let template: minijinja::Template<'_, '_> = env.get_template("about.html")?;
    let rendered: String = template.render(context! {
        current_user => auth_session.user,
        draft_post_count,
    })?;

    Ok(Html(rendered))
}
