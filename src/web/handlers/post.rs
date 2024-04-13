use crate::app_error::AppError;
use crate::models::comment::{create_comment, find_comments_by_post_id, CommentDraft};
use crate::models::post::{
    find_draft_posts_by_author_id, find_post_by_id, get_draft_post_count,
    increment_post_viewer_count, publish_post,
};
use crate::models::user::AuthSession;
use crate::web::state::AppState;
use axum::extract::Path;
use axum::response::{IntoResponse, Redirect};
use axum::{extract::State, http::StatusCode, response::Html, Form};
use data_encoding::BASE64URL_NOPAD;
use minijinja::context;
use serde::Deserialize;
use uuid::Uuid;

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

    let comments = find_comments_by_post_id(&mut tx, uuid).await.unwrap();

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
    let template: minijinja::Template<'_, '_> = state.env.get_template("post_view.html").unwrap();
    let rendered = template
        .render(context! {
            current_user => auth_session.user,
            r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
            post => {
                post.as_ref()
            },
            encoded_post_id => BASE64URL_NOPAD.encode(Uuid::parse_str(post.unwrap().get("id").unwrap().as_ref().unwrap()).as_ref().unwrap().as_bytes()),
            encoded_community_id,
            draft_post_count,
            base_url => state.config.base_url.clone(),
            comments,
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
    if post.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
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
    let encoded_community_id = BASE64URL_NOPAD.encode(community_id.as_bytes());

    let template_filename = match post.clone().unwrap().get("replay_filename") {
        Some(replay_filename) => {
            let replay_filename = replay_filename.as_ref().unwrap();
            if replay_filename.ends_with(".pch") {
                "post_replay_view_pch.html"
            } else if replay_filename.ends_with(".tgkr") {
                "post_replay_view_tgkr.html"
            } else {
                "post_replay_view_pch.html"
            }
        }
        None => "post_replay_view_pch.html",
    };

    let template: minijinja::Template<'_, '_> = state.env.get_template(template_filename).unwrap();
    let rendered = template
        .render(context! {
            current_user => auth_session.user,
            r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
            post => {
                post.as_ref()
            },
            encoded_post_id => BASE64URL_NOPAD.encode(Uuid::parse_str(post.unwrap().get("id").unwrap().as_ref().unwrap()).as_ref().unwrap().as_bytes()),
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

    let published_at = post.clone().unwrap().get("published_at").unwrap().clone();
    if published_at.is_some() {
        return Ok(Redirect::to(&format!("/posts/{}", id)).into_response());
    }

    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let community_id = Uuid::parse_str(
        post.clone()
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

    let template: minijinja::Template<'_, '_> = state.env.get_template("post_form.html")?;

    let rendered = template.render(context! {
        current_user => auth_session.user,
        link,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        post => {
            post
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

    let template: minijinja::Template<'_, '_> = state.env.get_template("draft_posts.html")?;
    let rendered = template.render(context! {
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        current_user => auth_session.user,
        posts => posts,
        draft_post_count,
    })?;

    Ok(Html(rendered))
}

#[derive(Deserialize)]
pub struct CreateCommentForm {
    pub post_id: String,
    pub content: String,
}

pub async fn do_create_comment(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Form(form): Form<CreateCommentForm>,
) -> Result<impl IntoResponse, AppError> {
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let user_id = auth_session.user.unwrap().id;
    let post_id = Uuid::from_slice(
        BASE64URL_NOPAD
            .decode(form.post_id.as_bytes())
            .unwrap()
            .as_slice(),
    )?;
    let _ = create_comment(
        &mut tx,
        CommentDraft {
            user_id,
            post_id,
            content: form.content,
        },
    )
    .await;
    let comments = find_comments_by_post_id(&mut tx, post_id).await?;
    let _ = tx.commit().await;

    let template: minijinja::Template<'_, '_> = state.env.get_template("post_comments.html")?;
    let rendered = template.render(context! {
        comments => comments,
    })?;
    Ok(Html(rendered).into_response())
}
