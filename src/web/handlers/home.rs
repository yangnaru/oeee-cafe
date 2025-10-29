use super::ExtractFtlLang;
use crate::app_error::AppError;
use crate::models::actor::Actor;
use crate::models::comment::{
    find_comments_by_post_id, find_latest_comments_from_public_communities,
};
use crate::models::community::{
    get_communities_members_count, get_public_communities,
};
use crate::models::post::{
    find_child_posts_by_parent_id, find_following_posts_by_user_id, find_post_by_id,
    find_public_community_posts, find_recent_posts_by_communities,
};
use crate::models::reaction::get_reaction_counts;
use crate::models::user::AuthSession;
use crate::web::context::CommonContext;
use crate::web::state::AppState;
use axum::extract::{Path, Query};
use axum::response::IntoResponse;
use axum::{extract::State, response::Html, response::Json};
use axum_messages::Messages;
use serde::Deserialize;
use uuid::Uuid;

use minijinja::context;

pub async fn home(
    auth_session: AuthSession,
    State(state): State<AppState>,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    messages: Messages,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let common_ctx =
        CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    let non_official_public_community_posts = find_public_community_posts(&mut tx, 18, 0).await?;
    let active_public_communities_raw = get_public_communities(&mut tx).await?;

    // Filter to communities with at least 10 posts
    let active_public_communities_raw: Vec<_> = active_public_communities_raw
        .into_iter()
        .filter(|c| c.posts_count.unwrap_or(0) >= 10)
        .collect();

    // Fetch recent posts and stats for active communities
    let community_ids: Vec<uuid::Uuid> = active_public_communities_raw.iter().map(|c| c.id).collect();

    let recent_posts = find_recent_posts_by_communities(&mut tx, &community_ids, 3).await?;
    let community_stats = get_communities_members_count(&mut tx, &community_ids).await?;

    // Group posts by community_id
    use std::collections::HashMap;
    let mut posts_by_community: HashMap<uuid::Uuid, Vec<serde_json::Value>> = HashMap::new();
    for post in recent_posts {
        let posts = posts_by_community.entry(post.community_id).or_insert_with(Vec::new);
        posts.push(serde_json::json!({
            "id": post.id.to_string(),
            "image_filename": post.image_filename,
            "image_width": post.image_width,
            "image_height": post.image_height,
            "author_login_name": post.author_login_name,
        }));
    }

    // Create stats lookup map
    let mut stats_by_community: HashMap<uuid::Uuid, Option<i64>> = HashMap::new();
    for stat in community_stats {
        stats_by_community.insert(stat.community_id, stat.members_count);
    }

    // Build active communities with all metadata
    let active_public_communities: Vec<serde_json::Value> = active_public_communities_raw
        .into_iter()
        .map(|community| {
            let recent_posts = posts_by_community.get(&community.id).cloned().unwrap_or_default();
            let members_count = stats_by_community.get(&community.id).cloned().unwrap_or(None);

            serde_json::json!({
                "id": community.id.to_string(),
                "name": community.name,
                "slug": community.slug,
                "description": community.description,
                "visibility": community.visibility,
                "owner_login_name": community.owner_login_name,
                "posts_count": community.posts_count,
                "members_count": members_count,
                "recent_posts": recent_posts,
            })
        })
        .collect();

    // Get recent comments from public communities
    let recent_comments = find_latest_comments_from_public_communities(&mut tx, 5).await?;

    tx.commit().await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("home.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        messages => messages.into_iter().collect::<Vec<_>>(),
        active_public_communities,
        non_official_public_community_posts,
        recent_comments,
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        ftl_lang
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn my_timeline(
    auth_session: AuthSession,
    State(state): State<AppState>,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    messages: Messages,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let common_ctx =
        CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    let posts =
        find_following_posts_by_user_id(&mut tx, auth_session.user.clone().unwrap().id).await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("timeline.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        messages => messages.into_iter().collect::<Vec<_>>(),
        posts,
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        ftl_lang
    })?;

    Ok(Html(rendered).into_response())
}

#[derive(Deserialize)]
pub struct LoadMoreQuery {
    pub offset: i64,
    pub limit: i64,
}

pub async fn load_more_public_posts(
    _auth_session: AuthSession,
    State(state): State<AppState>,
    Query(query): Query<LoadMoreQuery>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let posts = find_public_community_posts(&mut tx, query.limit, query.offset).await?;

    tx.commit().await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("home_posts_fragment.jinja")?;
    let rendered = template.render(context! {
        posts,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        offset => query.offset + query.limit,
        has_more => posts.len() as i64 == query.limit,
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn load_more_public_posts_json(
    _auth_session: AuthSession,
    State(state): State<AppState>,
    Query(query): Query<LoadMoreQuery>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let posts = find_public_community_posts(&mut tx, query.limit, query.offset).await?;

    tx.commit().await?;

    // Convert to JSON response with minimal fields for thumbnails
    let posts_with_urls: Vec<serde_json::Value> = posts
        .into_iter()
        .map(|post| {
            let image_prefix = &post.image_filename[..2];
            serde_json::json!({
                "id": post.id,
                "image_url": format!("{}/image/{}/{}", state.config.r2_public_endpoint_url, image_prefix, post.image_filename),
                "image_width": post.image_width,
                "image_height": post.image_height,
                "is_sensitive": post.is_sensitive,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "posts": posts_with_urls,
        "offset": query.offset + query.limit,
        "has_more": posts_with_urls.len() as i64 == query.limit,
    })).into_response())
}

pub async fn get_active_communities_json(
    _auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let active_public_communities_raw = get_public_communities(&mut tx).await?;

    // Filter to communities with at least 10 posts, then limit to 5 communities
    let active_public_communities_raw: Vec<_> = active_public_communities_raw
        .into_iter()
        .filter(|c| c.posts_count.unwrap_or(0) >= 10)
        .take(5)
        .collect();

    // Fetch recent posts and stats for active communities
    let community_ids: Vec<uuid::Uuid> = active_public_communities_raw
        .iter()
        .map(|c| c.id)
        .collect();

    let recent_posts = find_recent_posts_by_communities(&mut tx, &community_ids, 10).await?;
    let community_stats = get_communities_members_count(&mut tx, &community_ids).await?;

    tx.commit().await?;

    // Group posts by community_id with minimal fields for thumbnails
    use std::collections::HashMap;
    let mut posts_by_community: HashMap<uuid::Uuid, Vec<serde_json::Value>> = HashMap::new();
    for post in recent_posts {
        let posts = posts_by_community
            .entry(post.community_id)
            .or_insert_with(Vec::new);
        let image_prefix = &post.image_filename[..2];
        posts.push(serde_json::json!({
            "id": post.id.to_string(),
            "image_url": format!("{}/image/{}/{}", state.config.r2_public_endpoint_url, image_prefix, post.image_filename),
            "image_width": post.image_width,
            "image_height": post.image_height,
        }));
    }

    // Create stats lookup map
    let mut stats_by_community: HashMap<uuid::Uuid, Option<i64>> = HashMap::new();
    for stat in community_stats {
        stats_by_community.insert(stat.community_id, stat.members_count);
    }

    // Build active communities with all metadata
    let active_public_communities: Vec<serde_json::Value> = active_public_communities_raw
        .into_iter()
        .map(|community| {
            let recent_posts = posts_by_community
                .get(&community.id)
                .cloned()
                .unwrap_or_default();
            let members_count = stats_by_community
                .get(&community.id)
                .cloned()
                .unwrap_or(None);

            serde_json::json!({
                "id": community.id.to_string(),
                "name": community.name,
                "slug": community.slug,
                "description": community.description,
                "visibility": community.visibility,
                "owner_login_name": community.owner_login_name,
                "posts_count": community.posts_count,
                "members_count": members_count,
                "recent_posts": recent_posts,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "communities": active_public_communities,
    }))
    .into_response())
}

pub async fn get_latest_comments_json(
    _auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let recent_comments = find_latest_comments_from_public_communities(&mut tx, 10).await?;

    tx.commit().await?;

    // Convert comments to JSON with full image URLs
    let comments_json: Vec<serde_json::Value> = recent_comments
        .into_iter()
        .map(|comment| {
            let post_image_url = comment.post_image_filename.as_ref().map(|filename| {
                let image_prefix = &filename[..2];
                format!(
                    "{}/image/{}/{}",
                    state.config.r2_public_endpoint_url, image_prefix, filename
                )
            });

            serde_json::json!({
                "id": comment.id,
                "post_id": comment.post_id,
                "actor_id": comment.actor_id,
                "content": comment.content,
                "content_html": comment.content_html,
                "actor_name": comment.actor_name,
                "actor_handle": comment.actor_handle,
                "actor_login_name": comment.actor_login_name,
                "is_local": comment.is_local,
                "created_at": comment.created_at,
                "post_title": comment.post_title,
                "post_author_login_name": comment.post_author_login_name,
                "post_image_url": post_image_url,
                "post_image_width": comment.post_image_width,
                "post_image_height": comment.post_image_height,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "comments": comments_json,
    }))
    .into_response())
}

pub async fn get_post_details_json(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(post_id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Get post details
    let post = find_post_by_id(&mut tx, post_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Post not found"))?;

    // Get comments for this post
    let comments = find_comments_by_post_id(&mut tx, post_id).await?;

    // Get child posts (replies)
    let child_posts = find_child_posts_by_parent_id(&mut tx, post_id).await?;

    // Get reaction counts
    let user_actor_id = if let Some(ref user) = auth_session.user {
        Actor::find_by_user_id(&mut tx, user.id)
            .await
            .ok()
            .flatten()
            .map(|actor| actor.id)
    } else {
        None
    };
    let reactions = get_reaction_counts(&mut tx, post_id, user_actor_id).await?;

    tx.commit().await?;

    // Convert comments to JSON
    let comments_json: Vec<serde_json::Value> = comments
        .into_iter()
        .map(|comment| {
            serde_json::json!({
                "id": comment.id,
                "post_id": comment.post_id,
                "actor_id": comment.actor_id,
                "content": comment.content,
                "content_html": comment.content_html,
                "actor_name": comment.actor_name,
                "actor_handle": comment.actor_handle,
                "actor_login_name": comment.actor_login_name,
                "is_local": comment.is_local,
                "created_at": comment.created_at,
                "updated_at": comment.updated_at,
            })
        })
        .collect();

    // Convert child posts to JSON with image URLs
    let child_posts_json: Vec<serde_json::Value> = child_posts
        .into_iter()
        .map(|child| {
            let image_prefix = &child.image_filename[..2];
            serde_json::json!({
                "id": child.id,
                "title": child.title,
                "content": child.content,
                "author_id": child.author_id,
                "user_login_name": child.user_login_name,
                "user_display_name": child.user_display_name,
                "user_actor_handle": child.user_actor_handle,
                "image_url": format!("{}/image/{}/{}", state.config.r2_public_endpoint_url, image_prefix, child.image_filename),
                "image_width": child.image_width,
                "image_height": child.image_height,
                "published_at": child.published_at,
                "comments_count": child.comments_count,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "post": post,
        "comments": comments_json,
        "child_posts": child_posts_json,
        "reactions": reactions,
    })).into_response())
}
