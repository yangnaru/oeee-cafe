use crate::app_error::AppError;
use crate::models::actor::Actor;
use crate::models::banner::find_banner_by_id;
use crate::models::follow::{find_followings_by_user_id, follow_user, is_following, unfollow_user};
use crate::models::guestbook_entry::{
    add_guestbook_entry_reply, create_guestbook_entry, delete_guestbook_entry,
    find_guestbook_entries_by_recipient_id, find_guestbook_entry_by_id, GuestbookEntryDraft,
};
use crate::models::link::{
    create_link, delete_link, find_links_by_user_id, update_link_order, LinkDraft,
};
use crate::models::notification::{create_notification, CreateNotificationParams, NotificationType};
use crate::models::post::{
    find_published_posts_by_author_id, find_published_public_posts_by_author_id,
};
use crate::models::user::{find_user_by_id, find_user_by_login_name, AuthSession};
use crate::web::context::CommonContext;
use crate::web::state::AppState;
use axum::extract::Path;
use axum::response::IntoResponse;
use axum::{extract::State, http::StatusCode, response::Html, response::Json, Form};

use minijinja::context;
use serde::Deserialize;
use uuid::Uuid;

use super::ExtractFtlLang;

pub async fn do_follow_profile(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path(login_name): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;
    let user = find_user_by_login_name(&mut tx, &login_name).await?;

    if user.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    follow_user(
        &mut tx,
        auth_session.user.clone().unwrap().id,
        user.clone().unwrap().id,
    )
    .await?;

    // Create notification for the user being followed
    let follower_actor = Actor::find_by_user_id(&mut tx, auth_session.user.clone().unwrap().id).await?;
    if let Some(follower_actor) = follower_actor {
        match create_notification(
            &mut tx,
            CreateNotificationParams {
                recipient_id: user.clone().unwrap().id,
                actor_id: follower_actor.id,
                notification_type: NotificationType::Follow,
                post_id: None,
                comment_id: None,
                reaction_iri: None,
                guestbook_entry_id: None,
            },
        )
        .await
        {
            Ok(_) => tracing::info!("Created follow notification"),
            Err(e) => tracing::warn!("Failed to create follow notification: {:?}", e),
        }
    }

    let _ = tx.commit().await;

    let template: minijinja::Template<'_, '_> = state.env.get_template("unfollow_button.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        user,
        ftl_lang,
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn do_unfollow_profile(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path(login_name): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;
    let user = find_user_by_login_name(&mut tx, &login_name).await?;

    if user.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let _ = unfollow_user(
        &mut tx,
        auth_session.user.clone().unwrap().id,
        user.clone().unwrap().id,
    )
    .await;
    let _ = tx.commit().await;

    let template: minijinja::Template<'_, '_> = state.env.get_template("follow_button.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        user,
        ftl_lang,
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn profile(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path(login_name): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;
    let user = find_user_by_login_name(&mut tx, &login_name).await?;

    if user.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let published_posts =
        find_published_posts_by_author_id(&mut tx, user.clone().unwrap().id).await?;
    use crate::models::community::CommunityVisibility;
    let public_community_posts = published_posts
        .iter()
        .filter(|post| post.community_visibility == CommunityVisibility::Public)
        .collect::<Vec<_>>();
    let private_community_posts = published_posts
        .iter()
        .filter(|post| post.community_visibility != CommunityVisibility::Public)
        .collect::<Vec<_>>();

    let common_ctx = CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    let mut is_current_user_following = false;
    if let Some(current_user) = auth_session.user.clone() {
        is_current_user_following =
            is_following(&mut tx, current_user.id, user.clone().unwrap().id).await?;
    }

    let followings = find_followings_by_user_id(&mut tx, user.clone().unwrap().id).await?;

    let banner = match user.clone().unwrap().banner_id {
        Some(banner_id) => Some(find_banner_by_id(&mut tx, banner_id).await?),
        None => None,
    };

    let links = find_links_by_user_id(&mut tx, user.clone().unwrap().id).await?;
    let links = links
        .iter()
        .map(|link| {
            let target = if link.url.starts_with(&state.config.base_url) {
                "_self"
            } else {
                "_blank"
            };
            (link, target)
        })
        .collect::<Vec<_>>();

    let template: minijinja::Template<'_, '_> = state.env.get_template("profile.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        links,
        banner,
        is_following => is_current_user_following,
        followings,
        user,
        domain => state.config.domain.clone(),
        public_community_posts,
        private_community_posts,
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        ftl_lang,
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn profile_iframe(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path(login_name): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;
    let user = find_user_by_login_name(&mut tx, &login_name).await?;

    if user.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let posts = find_published_public_posts_by_author_id(&mut tx, user.clone().unwrap().id).await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("profile_iframe.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        user,
        posts,
        ftl_lang,
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn profile_banners_iframe(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path(login_name): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;
    let user = find_user_by_login_name(&mut tx, &login_name).await?;

    if user.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let followings = find_followings_by_user_id(&mut tx, user.clone().unwrap().id).await?;

    let template: minijinja::Template<'_, '_> =
        state.env.get_template("profile_banners_iframe.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        followings,
        user,
        ftl_lang,
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn do_move_link_down(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path((login_name, link_id)): Path<(String, Uuid)>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = find_user_by_login_name(&mut tx, &login_name).await?;
    if user.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    if user.clone().unwrap().id != auth_session.user.clone().unwrap().id {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let links = find_links_by_user_id(&mut tx, auth_session.user.clone().unwrap().id).await?;
    let link = links.iter().find(|link| link.id == link_id);

    if link.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let link = link.unwrap();
    let index = link.index;

    update_link_order(&mut tx, link_id, index + 1).await?;
    let links = find_links_by_user_id(&mut tx, auth_session.user.clone().unwrap().id).await?;
    let _ = tx.commit().await;

    let template: minijinja::Template<'_, '_> = state.env.get_template("profile_settings.jinja")?;
    let rendered = template
        .eval_to_state(context! {
            user => auth_session.user,
            links => links,
            ftl_lang,
        })?
        .render_block("links")?;
    Ok(Html(rendered).into_response())
}

pub async fn do_move_link_up(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path((login_name, link_id)): Path<(String, Uuid)>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = find_user_by_login_name(&mut tx, &login_name).await?;
    if user.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    if user.clone().unwrap().id != auth_session.user.clone().unwrap().id {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let links = find_links_by_user_id(&mut tx, auth_session.user.clone().unwrap().id).await?;
    let link = links.iter().find(|link| link.id == link_id);

    if link.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let link = link.unwrap();
    let index = link.index;

    update_link_order(&mut tx, link_id, index - 1).await?;
    let links = find_links_by_user_id(&mut tx, auth_session.user.clone().unwrap().id).await?;
    let _ = tx.commit().await;

    let template: minijinja::Template<'_, '_> = state.env.get_template("profile_settings.jinja")?;
    let rendered = template
        .eval_to_state(context! {
            user => auth_session.user,
            links => links,
            ftl_lang,
        })?
        .render_block("links")?;
    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct AddLinkForm {
    pub url: String,
    pub description: String,
}

pub async fn do_delete_link(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path((login_name, link_id)): Path<(String, Uuid)>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = find_user_by_login_name(&mut tx, &login_name).await?;
    if user.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    if user.clone().unwrap().id != auth_session.user.clone().unwrap().id {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let links = find_links_by_user_id(&mut tx, auth_session.user.clone().unwrap().id).await?;
    let link = links.iter().find(|link| link.id == link_id);

    if link.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    delete_link(&mut tx, link_id).await?;

    let links = find_links_by_user_id(&mut tx, auth_session.user.clone().unwrap().id).await?;
    let _ = tx.commit().await;

    let template: minijinja::Template<'_, '_> = state.env.get_template("profile_settings.jinja")?;
    let rendered = template
        .eval_to_state(context! {
            user => auth_session.user,
            links => links,
            ftl_lang,
        })?
        .render_block("links")?;
    Ok(Html(rendered).into_response())
}

pub async fn do_add_link(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path(login_name): Path<String>,
    Form(form): Form<AddLinkForm>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = find_user_by_login_name(&mut tx, &login_name).await?;
    if user.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    if user.clone().unwrap().id != auth_session.user.clone().unwrap().id {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    if user.unwrap().email_verified_at.is_none() {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let _ = create_link(
        &mut tx,
        LinkDraft {
            user_id: auth_session.user.clone().unwrap().id,
            url: form.url,
            description: form.description,
        },
    )
    .await;
    let links = find_links_by_user_id(&mut tx, auth_session.user.clone().unwrap().id).await?;
    let _ = tx.commit().await;

    let template: minijinja::Template<'_, '_> = state.env.get_template("profile_settings.jinja")?;
    let rendered = template
        .eval_to_state(context! {
            user => auth_session.user,
            links => links,
            ftl_lang,
        })?
        .render_block("links")?;
    Ok(Html(rendered).into_response())
}

pub async fn profile_settings(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;
    let user = find_user_by_id(&mut tx, auth_session.user.clone().unwrap().id).await?;

    if user.clone().is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    if user.clone().unwrap().id != auth_session.user.clone().unwrap().id {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let common_ctx = CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    let links = find_links_by_user_id(&mut tx, user.clone().unwrap().id).await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("profile_settings.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        links,
        user,
        ftl_lang,
    })?;

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct AddGuestbookEntryReplyForm {
    pub content: String,
}

pub async fn do_reply_guestbook_entry(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path((login_name, entry_id)): Path<(String, Uuid)>,
    Form(form): Form<AddGuestbookEntryReplyForm>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;
    let entry = find_guestbook_entry_by_id(&mut tx, entry_id).await?;
    if entry.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let entry = entry.unwrap();
    if entry.recipient_id != auth_session.user.clone().unwrap().id {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let author = find_user_by_login_name(&mut tx, &login_name).await?;
    if author.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let author = author.unwrap();
    if author.id != entry.recipient_id {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let guestbook_entry = find_guestbook_entry_by_id(&mut tx, entry_id).await?;
    if guestbook_entry.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let mut guestbook_entry = guestbook_entry.unwrap();

    let replied_at = add_guestbook_entry_reply(&mut tx, entry_id, form.content.clone()).await?;
    guestbook_entry.reply = Some(form.content);
    guestbook_entry.replied_at = Some(replied_at);

    // Create notification for the guestbook entry author (person who originally wrote the entry)
    let replier_actor = Actor::find_by_user_id(&mut tx, auth_session.user.clone().unwrap().id).await?;
    if let Some(replier_actor) = replier_actor {
        match create_notification(
            &mut tx,
            CreateNotificationParams {
                recipient_id: guestbook_entry.author_id,
                actor_id: replier_actor.id,
                notification_type: NotificationType::GuestbookReply,
                post_id: None,
                comment_id: None,
                reaction_iri: None,
                guestbook_entry_id: Some(entry_id),
            },
        )
        .await
        {
            Ok(_) => tracing::info!("Created guestbook reply notification"),
            Err(e) => tracing::warn!("Failed to create guestbook reply notification: {:?}", e),
        }
    }

    let _ = tx.commit().await;

    let template: minijinja::Template<'_, '_> =
        state.env.get_template("guestbook_entry_reply.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        user => author,
        entry => guestbook_entry,
        ftl_lang,
    })?;

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct CreateGuestbookEntryForm {
    pub content: String,
}

pub async fn do_delete_guestbook_entry(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path((login_name, entry_id)): Path<(String, Uuid)>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;
    let entry = find_guestbook_entry_by_id(&mut tx, entry_id).await?;
    if entry.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let entry = entry.unwrap();
    if entry.author_id != auth_session.user.clone().unwrap().id
        && entry.recipient_id != auth_session.user.clone().unwrap().id
    {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    // Check if login_name matches recipient_id
    let recipient = find_user_by_login_name(&mut tx, &login_name).await?;
    if recipient.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let recipient = recipient.unwrap();
    if recipient.id != entry.recipient_id {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let _ = delete_guestbook_entry(&mut tx, entry_id).await;
    let _ = tx.commit().await;

    Ok(StatusCode::OK.into_response())
}

pub async fn do_write_guestbook_entry(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path(login_name): Path<String>,
    Form(form): Form<CreateGuestbookEntryForm>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;
    let current_user_id = auth_session.user.clone().unwrap().id;
    let recipient_user = find_user_by_login_name(&mut tx, &login_name).await?;
    let recipient_id = recipient_user.clone().unwrap().id;

    if current_user_id == recipient_id {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let guestbook_entry = create_guestbook_entry(
        &mut tx,
        GuestbookEntryDraft {
            author_id: current_user_id,
            recipient_id,
            content: form.content,
        },
    )
    .await;

    // Create notification for the guestbook owner
    if let Ok(ref entry) = guestbook_entry {
        let author_actor = Actor::find_by_user_id(&mut tx, current_user_id).await?;
        if let Some(author_actor) = author_actor {
            match create_notification(
                &mut tx,
                CreateNotificationParams {
                    recipient_id,
                    actor_id: author_actor.id,
                    notification_type: NotificationType::GuestbookEntry,
                    post_id: None,
                    comment_id: None,
                    reaction_iri: None,
                    guestbook_entry_id: Some(entry.id),
                },
            )
            .await
            {
                Ok(_) => tracing::info!("Created guestbook entry notification"),
                Err(e) => tracing::warn!("Failed to create guestbook entry notification: {:?}", e),
            }
        }
    }

    let _ = tx.commit().await;

    let template: minijinja::Template<'_, '_> = state.env.get_template("guestbook_entry.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        user => recipient_user.unwrap(),
        entry => guestbook_entry.unwrap(),
        ftl_lang,
    })?;
    Ok(Html(rendered).into_response())
}

pub async fn guestbook(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path(login_name): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;
    let user = find_user_by_login_name(&mut tx, &login_name).await?;

    if user.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let guestbook_entries =
        find_guestbook_entries_by_recipient_id(&mut tx, user.clone().unwrap().id)
            .await
            .unwrap();

    let common_ctx = CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    let banner = match user.clone().unwrap().banner_id {
        Some(banner_id) => Some(find_banner_by_id(&mut tx, banner_id).await?),
        None => None,
    };

    let mut is_current_user_following = false;
    if let Some(current_user) = auth_session.user.clone() {
        is_current_user_following =
            is_following(&mut tx, current_user.id, user.clone().unwrap().id).await?;
    }

    let template: minijinja::Template<'_, '_> = state.env.get_template("guestbook.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        banner,
        user,
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        is_following => is_current_user_following,
        guestbook_entries,
        ftl_lang,
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn profile_json(
    _auth_session: AuthSession,
    State(state): State<AppState>,
    Path(login_name): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = find_user_by_login_name(&mut tx, &login_name)
        .await?
        .ok_or_else(|| anyhow::anyhow!("User not found"))?;

    // Get only public posts
    let public_posts = find_published_public_posts_by_author_id(&mut tx, user.id).await?;

    // Get banner
    let banner = match user.banner_id {
        Some(banner_id) => {
            let banner = find_banner_by_id(&mut tx, banner_id).await?;
            Some(serde_json::json!({
                "id": banner.id,
                "image_filename": banner.image_filename,
                "image_url": format!("{}/image/{}/{}",
                    state.config.r2_public_endpoint_url,
                    &banner.image_filename[..2],
                    banner.image_filename
                ),
            }))
        }
        None => None,
    };

    // Get followings
    let followings = find_followings_by_user_id(&mut tx, user.id).await?;

    // Get links
    let links = find_links_by_user_id(&mut tx, user.id).await?;

    tx.commit().await?;

    // Convert posts to JSON with image URLs
    let posts_json: Vec<serde_json::Value> = public_posts
        .into_iter()
        .map(|post| {
            let image_prefix = &post.image_filename[..2];
            serde_json::json!({
                "id": post.id,
                "title": post.title,
                "author_id": post.author_id,
                "paint_duration": post.paint_duration,
                "stroke_count": post.stroke_count,
                "viewer_count": post.viewer_count,
                "image_url": format!("{}/image/{}/{}", state.config.r2_public_endpoint_url, image_prefix, post.image_filename),
                "image_width": post.image_width,
                "image_height": post.image_height,
                "published_at": post.published_at,
            })
        })
        .collect();

    // Convert followings to JSON
    let followings_json: Vec<serde_json::Value> = followings
        .into_iter()
        .map(|following| {
            let banner_image_url = following.banner_image_filename.as_ref().map(|filename| {
                let image_prefix = &filename[..2];
                format!("{}/image/{}/{}", state.config.r2_public_endpoint_url, image_prefix, filename)
            });

            serde_json::json!({
                "id": following.user_id,
                "login_name": following.login_name,
                "display_name": following.display_name,
                "banner_image_url": banner_image_url,
                "banner_image_width": following.banner_image_width,
                "banner_image_height": following.banner_image_height,
            })
        })
        .collect();

    // Convert links to JSON
    let links_json: Vec<serde_json::Value> = links
        .into_iter()
        .map(|link| {
            serde_json::json!({
                "id": link.id,
                "url": link.url,
                "description": link.description,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "user": {
            "id": user.id,
            "login_name": user.login_name,
            "display_name": user.display_name,
        },
        "banner": banner,
        "posts": posts_json,
        "followings": followings_json,
        "links": links_json,
    }))
    .into_response())
}
