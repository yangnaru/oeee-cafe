use crate::app_error::AppError;
use crate::models::banner::find_banner_by_id;
use crate::models::follow::{find_followings_by_user_id, follow_user, is_following, unfollow_user};
use crate::models::guestbook_entry::{
    add_guestbook_entry_reply, create_guestbook_entry, delete_guestbook_entry,
    find_guestbook_entries_by_recipient_id, find_guestbook_entry_by_id, GuestbookEntryDraft,
};
use crate::models::link::{
    create_link, delete_link, find_links_by_user_id, update_link_order, LinkDraft,
};
use crate::models::post::{find_published_public_posts_by_author_id, get_draft_post_count};
use crate::models::user::{find_user_by_id, find_user_by_login_name, AuthSession};
use crate::web::handlers::{create_base_ftl_context, get_bundle};
use crate::web::state::AppState;
use axum::extract::Path;
use axum::response::IntoResponse;
use axum::{extract::State, http::StatusCode, response::Html, Form};
use minijinja::context;
use serde::Deserialize;
use uuid::Uuid;

use super::ExtractAcceptLanguage;

pub async fn do_follow_profile(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(login_name): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let db = state.config.connect_database().await?;
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
    let _ = tx.commit().await;

    let template: minijinja::Template<'_, '_> = state.env.get_template("unfollow_button.html")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        current_user => auth_session.user,
        user,
        ..create_base_ftl_context(&bundle),
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn do_unfollow_profile(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(login_name): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let user = find_user_by_login_name(&mut tx, &login_name).await?;

    if user.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    unfollow_user(
        &mut tx,
        auth_session.user.clone().unwrap().id,
        user.clone().unwrap().id,
    )
    .await;
    let _ = tx.commit().await;

    let template: minijinja::Template<'_, '_> = state.env.get_template("follow_button.html")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        current_user => auth_session.user,
        user,
        ..create_base_ftl_context(&bundle),
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn profile(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(login_name): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let user = find_user_by_login_name(&mut tx, &login_name).await?;

    if user.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let posts = find_published_public_posts_by_author_id(&mut tx, user.clone().unwrap().id).await?;

    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

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

    let template: minijinja::Template<'_, '_> = state.env.get_template("profile.html")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        links,
        banner,
        is_following => is_current_user_following,
        followings,
        current_user => auth_session.user,
        user,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        posts,
        draft_post_count,
        ..create_base_ftl_context(&bundle),
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn do_move_link_down(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path((login_name, link_id)): Path<(String, Uuid)>,
) -> Result<impl IntoResponse, AppError> {
    let db = state.config.connect_database().await?;
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

    let template: minijinja::Template<'_, '_> = state.env.get_template("profile_settings.html")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template
        .eval_to_state(context! {
            user => auth_session.user,
            links => links,
            ..create_base_ftl_context(&bundle),
        })?
        .render_block("links")?;
    Ok(Html(rendered).into_response())
}

pub async fn do_move_link_up(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path((login_name, link_id)): Path<(String, Uuid)>,
) -> Result<impl IntoResponse, AppError> {
    let db = state.config.connect_database().await?;
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

    let template: minijinja::Template<'_, '_> = state.env.get_template("profile_settings.html")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template
        .eval_to_state(context! {
            user => auth_session.user,
            links => links,
            ..create_base_ftl_context(&bundle),
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
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path((login_name, link_id)): Path<(String, Uuid)>,
) -> Result<impl IntoResponse, AppError> {
    let db = state.config.connect_database().await?;
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

    let template: minijinja::Template<'_, '_> = state.env.get_template("profile_settings.html")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template
        .eval_to_state(context! {
            user => auth_session.user,
            links => links,
            ..create_base_ftl_context(&bundle),
        })?
        .render_block("links")?;
    Ok(Html(rendered).into_response())
}

pub async fn do_add_link(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(login_name): Path<String>,
    Form(form): Form<AddLinkForm>,
) -> Result<impl IntoResponse, AppError> {
    let db = state.config.connect_database().await?;
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

    let template: minijinja::Template<'_, '_> = state.env.get_template("profile_settings.html")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template
        .eval_to_state(context! {
            user => auth_session.user,
            links => links,
            ..create_base_ftl_context(&bundle),
        })?
        .render_block("links")?;
    Ok(Html(rendered).into_response())
}

pub async fn profile_settings(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let user = find_user_by_id(&mut tx, auth_session.user.clone().unwrap().id).await?;

    if user.clone().is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    if user.clone().unwrap().id != auth_session.user.clone().unwrap().id {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let links = find_links_by_user_id(&mut tx, user.clone().unwrap().id).await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("profile_settings.html")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        current_user => auth_session.user,
        draft_post_count,
        links,
        user,
        ..create_base_ftl_context(&bundle),
    })?;

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct AddGuestbookEntryReplyForm {
    pub content: String,
}

pub async fn do_reply_guestbook_entry(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path((login_name, entry_id)): Path<(String, Uuid)>,
    Form(form): Form<AddGuestbookEntryReplyForm>,
) -> Result<impl IntoResponse, AppError> {
    let db = state.config.connect_database().await?;
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

    let _ = tx.commit().await;

    let template: minijinja::Template<'_, '_> =
        state.env.get_template("guestbook_entry_reply.html")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        current_user => auth_session.user,
        user => author,
        entry => guestbook_entry,
        ..create_base_ftl_context(&bundle),
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
    let db = state.config.connect_database().await?;
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
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(login_name): Path<String>,
    Form(form): Form<CreateGuestbookEntryForm>,
) -> Result<impl IntoResponse, AppError> {
    let db = state.config.connect_database().await?;
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
    let _ = tx.commit().await;

    let template: minijinja::Template<'_, '_> = state.env.get_template("guestbook_entry.html")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        current_user => auth_session.user,
        user => recipient_user.unwrap(),
        entry => guestbook_entry.unwrap(),
        ..create_base_ftl_context(&bundle),
    })?;
    Ok(Html(rendered).into_response())
}

pub async fn guestbook(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(login_name): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let db = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let user = find_user_by_login_name(&mut tx, &login_name).await?;

    if user.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let guestbook_entries =
        find_guestbook_entries_by_recipient_id(&mut tx, user.clone().unwrap().id)
            .await
            .unwrap();

    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let banner = match user.clone().unwrap().banner_id {
        Some(banner_id) => Some(find_banner_by_id(&mut tx, banner_id).await?),
        None => None,
    };

    let mut is_current_user_following = false;
    if let Some(current_user) = auth_session.user.clone() {
        is_current_user_following =
            is_following(&mut tx, current_user.id, user.clone().unwrap().id).await?;
    }

    let template: minijinja::Template<'_, '_> = state.env.get_template("guestbook.html")?;
    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let rendered = template.render(context! {
        banner,
        current_user => auth_session.user,
        user,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        draft_post_count,
        is_following => is_current_user_following,
        guestbook_entries,
        ..create_base_ftl_context(&bundle),
    })?;

    Ok(Html(rendered).into_response())
}
