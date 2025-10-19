use super::ExtractFtlLang;
use crate::app_error::AppError;
use crate::models::comment::find_latest_comments_from_public_communities;
use crate::models::community::{
    get_active_public_communities_excluding_owner, get_communities_members_count, get_public_communities,
    get_user_communities_with_latest_9_posts,
};
use crate::models::post::{
    find_following_posts_by_user_id, find_public_community_posts_excluding_from_community_owner,
    find_recent_posts_by_communities,
};
use crate::models::user::{find_user_by_login_name, AuthSession};
use crate::web::context::CommonContext;
use crate::web::state::AppState;
use axum::extract::Query;
use axum::response::IntoResponse;
use axum::{extract::State, response::Html};
use axum_messages::Messages;
use serde::Deserialize;

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

    let user = find_user_by_login_name(&mut tx, &state.config.official_account_login_name).await?;
    let official_communities_with_latest_posts = match user.clone() {
        Some(user) => get_user_communities_with_latest_9_posts(&mut tx, user.id).await?,
        None => Vec::new(),
    };
    let non_official_public_community_posts = match user.clone() {
        Some(user) => {
            find_public_community_posts_excluding_from_community_owner(&mut tx, user.id, 18, 0).await?
        }
        None => Vec::new(),
    };
    let active_public_communities_raw = match user {
        Some(user) => get_active_public_communities_excluding_owner(&mut tx, user.id).await?,
        None => get_public_communities(&mut tx).await?,
    };

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
                "is_private": community.is_private,
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
        official_communities_with_latest_posts,
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
    offset: i64,
}

pub async fn load_more_public_posts(
    _auth_session: AuthSession,
    State(state): State<AppState>,
    Query(query): Query<LoadMoreQuery>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let user = find_user_by_login_name(&mut tx, &state.config.official_account_login_name).await?;
    let posts = match user {
        Some(user) => {
            find_public_community_posts_excluding_from_community_owner(&mut tx, user.id, 18, query.offset).await?
        }
        None => Vec::new(),
    };

    tx.commit().await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("home_posts_fragment.jinja")?;
    let rendered = template.render(context! {
        posts,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        offset => query.offset + 18,
        has_more => posts.len() == 18,
    })?;

    Ok(Html(rendered).into_response())
}
