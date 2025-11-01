use super::ExtractFtlLang;
use crate::app_error::AppError;
use crate::models::actor::Actor;
use crate::models::comment::{
    build_comment_thread_tree_paginated, create_comment, find_latest_comments_from_public_communities,
    CommentDraft,
};
use crate::models::community::{
    get_communities_members_count, get_public_communities, is_user_member, Community,
};
use crate::models::post::{
    build_thread_tree, delete_post_with_activity, find_following_posts_by_user_id,
    find_post_by_id, find_post_detail_for_json, find_public_community_posts,
    find_recent_posts_by_communities, SerializableThreadedPost,
};
use crate::models::hashtag::{get_hashtags_for_post, unlink_post_hashtags};
use crate::models::reaction::{create_reaction, delete_reaction, find_reactions_by_post_id_and_emoji, find_user_reaction, get_reaction_counts, ReactionDraft};
use crate::models::notification::{
    create_notification, get_notification_by_id, get_unread_count, send_push_for_notification,
    CreateNotificationParams, NotificationType,
};
use crate::models::user::AuthSession;
use crate::web::context::CommonContext;
use crate::web::responses::{
    ChildPostResponse, CommentListResponse, CommentsListResponse, CommentWithPost,
    CommunityListResponse, CommunityPostThumbnail, CommunityWithPosts, PaginationMeta,
    PostDetail, PostDetailResponse, PostListResponse, PostThumbnail, ReactionCount,
    ReactionsDetailResponse, Reactor, ThreadedCommentResponse,
};
use crate::web::state::AppState;
use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{extract::State, response::Html, response::Json};
use axum_messages::Messages;
use serde::{Deserialize, Serialize};
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

#[derive(Deserialize)]
pub struct CommentsQuery {
    #[serde(default)]
    pub offset: i64,
    #[serde(default = "default_comments_limit")]
    pub limit: i64,
}

fn default_comments_limit() -> i64 {
    100
}

#[derive(Deserialize)]
pub struct CreateCommentRequest {
    pub content: String,
    pub parent_comment_id: Option<String>,
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
) -> Result<Json<PostListResponse>, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let posts = find_public_community_posts(&mut tx, query.limit, query.offset).await?;

    tx.commit().await?;

    let thumbnails: Vec<PostThumbnail> = posts
        .into_iter()
        .map(|post| {
            let image_prefix = &post.image_filename[..2];
            PostThumbnail {
                id: post.id,
                image_url: format!(
                    "{}/image/{}/{}",
                    state.config.r2_public_endpoint_url, image_prefix, post.image_filename
                ),
                image_width: post.image_width,
                image_height: post.image_height,
                is_sensitive: post.is_sensitive,
            }
        })
        .collect();

    let has_more = thumbnails.len() as i64 == query.limit;

    Ok(Json(PostListResponse {
        posts: thumbnails,
        pagination: PaginationMeta {
            offset: query.offset,
            limit: query.limit,
            total: None,
            has_more,
        },
    }))
}

pub async fn get_active_communities_json(
    _auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<Json<CommunityListResponse>, AppError> {
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

    // Group posts by community_id
    use std::collections::HashMap;
    let mut posts_by_community: HashMap<uuid::Uuid, Vec<CommunityPostThumbnail>> = HashMap::new();
    for post in recent_posts {
        let posts = posts_by_community
            .entry(post.community_id)
            .or_insert_with(Vec::new);
        let image_prefix = &post.image_filename[..2];
        posts.push(CommunityPostThumbnail {
            id: post.id,
            image_url: format!(
                "{}/image/{}/{}",
                state.config.r2_public_endpoint_url, image_prefix, post.image_filename
            ),
            image_width: post.image_width,
            image_height: post.image_height,
            is_sensitive: post.is_sensitive,
        });
    }

    // Create stats lookup map
    let mut stats_by_community: HashMap<uuid::Uuid, Option<i64>> = HashMap::new();
    for stat in community_stats {
        stats_by_community.insert(stat.community_id, stat.members_count);
    }

    // Build active communities with all metadata
    let communities: Vec<CommunityWithPosts> = active_public_communities_raw
        .into_iter()
        .map(|community| {
            let recent_posts = posts_by_community
                .get(&community.id)
                .cloned()
                .unwrap_or_default();
            let members_count = stats_by_community
                .get(&community.id)
                .cloned()
                .flatten();

            CommunityWithPosts {
                id: community.id,
                name: community.name,
                slug: community.slug,
                description: community.description,
                visibility: community.visibility,
                owner_login_name: community.owner_login_name,
                posts_count: community.posts_count,
                members_count,
                recent_posts,
            }
        })
        .collect();

    Ok(Json(CommunityListResponse { communities }))
}

pub async fn get_latest_comments_json(
    _auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<Json<CommentListResponse>, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let recent_comments = find_latest_comments_from_public_communities(&mut tx, 10).await?;

    tx.commit().await?;

    let comments: Vec<CommentWithPost> = recent_comments
        .into_iter()
        .map(|comment| {
            let post_image_url = comment.post_image_filename.as_ref().map(|filename| {
                let image_prefix = &filename[..2];
                format!(
                    "{}/image/{}/{}",
                    state.config.r2_public_endpoint_url, image_prefix, filename
                )
            });

            CommentWithPost {
                id: comment.id,
                post_id: comment.post_id,
                actor_id: comment.actor_id,
                content: comment.content,
                content_html: comment.content_html,
                actor_name: comment.actor_name,
                actor_handle: comment.actor_handle,
                actor_login_name: comment.actor_login_name,
                is_local: comment.is_local,
                created_at: comment.created_at,
                post_title: comment.post_title,
                post_author_login_name: comment.post_author_login_name,
                post_image_url,
                post_image_width: comment.post_image_width,
                post_image_height: comment.post_image_height,
            }
        })
        .collect();

    Ok(Json(CommentListResponse { comments }))
}

/// Helper function to convert SerializableThreadedPost to ChildPostResponse
fn threaded_post_to_response(
    post: SerializableThreadedPost,
    r2_endpoint: &str,
) -> ChildPostResponse {
    let image_prefix = &post.image_filename[..2];
    ChildPostResponse {
        id: post.id,
        title: post.title,
        content: post.content,
        author_id: post.author_id,
        user_login_name: post.user_login_name,
        user_display_name: post.user_display_name,
        user_actor_handle: post.user_actor_handle,
        image_url: format!(
            "{}/image/{}/{}",
            r2_endpoint, image_prefix, post.image_filename
        ),
        image_width: post.image_width,
        image_height: post.image_height,
        published_at: post.published_at,
        comments_count: post.comments_count,
        children: post
            .children
            .into_iter()
            .map(|child| threaded_post_to_response(child, r2_endpoint))
            .collect(),
    }
}

pub async fn get_post_details_json(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(post_id): Path<Uuid>,
) -> Result<Json<PostDetailResponse>, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Get post details with proper types
    let post_data = find_post_detail_for_json(&mut tx, post_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Post not found"))?;

    // Get parent post if it exists
    let parent_post = if let Some(parent_id) = post_data.parent_post_id {
        let parent_data = find_post_detail_for_json(&mut tx, parent_id).await?;
        parent_data.map(|p| {
            let image_prefix = &p.image_filename[..2];
            ChildPostResponse {
                id: p.id,
                title: p.title,
                content: p.content,
                author_id: p.author_id,
                user_login_name: p.login_name.clone(),
                user_display_name: p.display_name,
                user_actor_handle: format!("{}@{}", p.login_name, state.config.domain),
                image_url: format!(
                    "{}/image/{}/{}",
                    state.config.r2_public_endpoint_url, image_prefix, p.image_filename
                ),
                image_width: p.image_width,
                image_height: p.image_height,
                published_at: p.published_at_utc.and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok().map(|dt| dt.with_timezone(&chrono::Utc))),
                comments_count: 0, // Not needed for parent display
                children: Vec::new(), // Parent post doesn't show its own children in this context
            }
        })
    } else {
        None
    };

    // Get child posts (replies) using threaded structure
    let child_posts = build_thread_tree(&mut tx, post_id).await?;

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

    // Get hashtags for this post
    let hashtags_data = get_hashtags_for_post(&mut tx, post_id).await?;
    let hashtags: Vec<String> = hashtags_data
        .into_iter()
        .map(|h| h.display_name)
        .collect();

    tx.commit().await?;

    let post = PostDetail {
        id: post_data.id,
        title: post_data.title,
        content: post_data.content,
        author_id: post_data.author_id,
        login_name: post_data.login_name,
        display_name: post_data.display_name,
        paint_duration: post_data.paint_duration,
        viewer_count: post_data.viewer_count,
        image_filename: post_data.image_filename,
        image_width: post_data.image_width,
        image_height: post_data.image_height,
        is_sensitive: post_data.is_sensitive,
        published_at_utc: post_data.published_at_utc,
        community_id: post_data.community_id,
        community_name: post_data.community_name,
        community_slug: post_data.community_slug,
        hashtags,
    };

    let child_posts_response: Vec<ChildPostResponse> = child_posts
        .into_iter()
        .map(|child| threaded_post_to_response(child, &state.config.r2_public_endpoint_url))
        .collect();

    let reactions_response: Vec<ReactionCount> = reactions
        .into_iter()
        .map(|r| ReactionCount {
            emoji: r.emoji,
            count: r.count,
            reacted_by_user: r.reacted_by_user,
        })
        .collect();

    Ok(Json(PostDetailResponse {
        post,
        parent_post,
        child_posts: child_posts_response,
        reactions: reactions_response,
    }))
}

pub async fn get_post_reactions_by_emoji_json(
    _auth_session: AuthSession,
    State(state): State<AppState>,
    Path((post_id, emoji)): Path<(Uuid, String)>,
) -> Result<Json<ReactionsDetailResponse>, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Get reactions for this post and emoji
    let reactions_data = find_reactions_by_post_id_and_emoji(&mut tx, post_id, &emoji).await?;

    tx.commit().await?;

    let reactions: Vec<Reactor> = reactions_data
        .into_iter()
        .map(|r| Reactor {
            iri: r.iri,
            post_id: r.post_id,
            actor_id: r.actor_id,
            emoji: r.emoji,
            created_at: r.created_at,
            actor_name: r.actor_name,
            actor_handle: r.actor_handle,
        })
        .collect();

    Ok(Json(ReactionsDetailResponse { reactions }))
}

pub async fn get_post_comments_api(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(post_id): Path<Uuid>,
    Query(query): Query<CommentsQuery>,
) -> Result<Json<CommentsListResponse>, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Validate and cap the limit
    let limit = query.limit.min(200).max(1);
    let offset = query.offset.max(0);

    // Get post's community_id to check visibility
    let post_community_id = sqlx::query_scalar!(
        r#"
        SELECT community_id
        FROM posts
        WHERE id = $1 AND deleted_at IS NULL
        "#,
        post_id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| anyhow::anyhow!("Post not found"))?;

    // Get the community to check visibility
    let community = sqlx::query_as!(
        Community,
        r#"
        SELECT id, slug, name, description, owner_id, visibility AS "visibility: _", created_at, updated_at, background_color, foreground_color
        FROM communities
        WHERE id = $1
        "#,
        post_community_id
    )
    .fetch_optional(&mut *tx)
    .await?;

    // Check authorization for private communities
    if let Some(ref community) = community {
        if community.visibility == crate::models::community::CommunityVisibility::Private {
            // For private communities, user must be logged in and be a member
            if let Some(ref user) = auth_session.user {
                let is_member = is_user_member(&mut tx, user.id, community.id).await?;
                if !is_member {
                    return Err(anyhow::anyhow!(
                        "You must be a member to view comments in this private community"
                    )
                    .into());
                }
            } else {
                return Err(
                    anyhow::anyhow!("Authentication required to view comments in private community")
                        .into(),
                );
            }
        }
    }

    // Get paginated comments
    let (comments_data, _total_count) =
        build_comment_thread_tree_paginated(&mut tx, post_id, limit, offset).await?;

    tx.commit().await?;

    // Convert to response format
    fn convert_to_response(comment: crate::models::comment::SerializableThreadedComment) -> ThreadedCommentResponse {
        ThreadedCommentResponse {
            id: comment.id,
            post_id: comment.post_id,
            parent_comment_id: comment.parent_comment_id,
            actor_id: comment.actor_id,
            content: comment.content,
            content_html: comment.content_html,
            actor_name: comment.actor_name,
            actor_handle: comment.actor_handle,
            actor_login_name: comment.actor_login_name,
            is_local: comment.is_local,
            created_at: comment.created_at,
            updated_at: comment.updated_at,
            children: comment.children.into_iter().map(convert_to_response).collect(),
        }
    }

    let comments: Vec<ThreadedCommentResponse> = comments_data
        .into_iter()
        .map(convert_to_response)
        .collect();

    // Determine if there are more comments
    let has_more = comments.len() as i64 == limit;

    Ok(Json(CommentsListResponse {
        comments,
        pagination: PaginationMeta {
            offset,
            limit,
            total: None,
            has_more,
        },
    }))
}

pub async fn create_comment_api(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(post_id): Path<Uuid>,
    Json(request): Json<CreateCommentRequest>,
) -> Result<Json<ThreadedCommentResponse>, AppError> {
    // Require authentication
    let user = auth_session
        .user
        .ok_or_else(|| anyhow::anyhow!("Authentication required"))?;

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Get the actor for this user
    let actor = Actor::find_by_user_id(&mut tx, user.id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No actor found for user"))?;

    // Parse parent_comment_id if provided
    let parent_comment_id = request
        .parent_comment_id
        .as_ref()
        .and_then(|id| Uuid::parse_str(id).ok());

    // Get the post to check access and get author
    let post = sqlx::query!(
        r#"
        SELECT author_id, community_id
        FROM posts
        WHERE id = $1
        "#,
        post_id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| anyhow::anyhow!("Post not found"))?;

    // Check if post is in a private community and if user has access
    let community = sqlx::query_as!(
        Community,
        r#"
        SELECT id, slug, name, description, owner_id, visibility AS "visibility: _", created_at, updated_at, background_color, foreground_color
        FROM communities
        WHERE id = $1
        "#,
        post.community_id
    )
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(ref comm) = community {
        if comm.visibility == crate::models::community::CommunityVisibility::Private {
            let is_member = is_user_member(&mut tx, user.id, comm.id).await?;
            if !is_member {
                return Err(anyhow::anyhow!("You must be a member to comment in this private community").into());
            }
        }
    }

    // Create the comment
    let comment = create_comment(
        &mut tx,
        CommentDraft {
            actor_id: actor.id,
            post_id,
            parent_comment_id,
            content: request.content,
            content_html: None,
        },
    )
    .await?;

    // Collect notification info for push notifications after commit
    let mut notification_info: Vec<(Uuid, Uuid)> = Vec::new();

    // If this is a reply to another comment, notify the parent comment author
    if let Some(parent_id) = parent_comment_id {
        let parent_comment = sqlx::query!(
            r#"
            SELECT actor_id
            FROM comments
            WHERE id = $1
            "#,
            parent_id
        )
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(parent) = parent_comment {
            let parent_actor = sqlx::query!(
                r#"
                SELECT user_id
                FROM actors
                WHERE id = $1
                "#,
                parent.actor_id
            )
            .fetch_optional(&mut *tx)
            .await?;

            if let Some(parent_actor_data) = parent_actor {
                if let Some(parent_user_id) = parent_actor_data.user_id {
                    if parent_user_id != user.id {
                        if let Ok(notification) = create_notification(
                            &mut tx,
                            CreateNotificationParams {
                                recipient_id: parent_user_id,
                                actor_id: actor.id,
                                notification_type: NotificationType::CommentReply,
                                post_id: Some(post_id),
                                comment_id: Some(comment.id),
                                reaction_iri: None,
                                guestbook_entry_id: None,
                            },
                        )
                        .await
                        {
                            notification_info.push((notification.id, parent_user_id));
                        }
                    }
                }
            }
        }
    } else {
        // Notify the post author for top-level comments
        if post.author_id != user.id {
            if let Ok(notification) = create_notification(
                &mut tx,
                CreateNotificationParams {
                    recipient_id: post.author_id,
                    actor_id: actor.id,
                    notification_type: NotificationType::Comment,
                    post_id: Some(post_id),
                    comment_id: Some(comment.id),
                    reaction_iri: None,
                    guestbook_entry_id: None,
                },
            )
            .await
            {
                notification_info.push((notification.id, post.author_id));
            }
        }
    }

    tx.commit().await?;

    // Send push notifications after successful commit
    if !notification_info.is_empty() {
        let push_service = state.push_service.clone();
        let db_pool = state.db_pool.clone();
        tokio::spawn(async move {
            for (notification_id, recipient_id) in notification_info {
                let mut tx = match db_pool.begin().await {
                    Ok(tx) => tx,
                    Err(e) => {
                        tracing::warn!(
                            "Failed to begin transaction for push notification: {:?}",
                            e
                        );
                        continue;
                    }
                };

                // Get the full notification with actor details
                if let Ok(Some(notification)) =
                    get_notification_by_id(&mut tx, notification_id, recipient_id).await
                {
                    // Get unread count for badge
                    let badge_count = get_unread_count(&mut tx, recipient_id)
                        .await
                        .ok()
                        .and_then(|count| u32::try_from(count).ok());

                    send_push_for_notification(&push_service, &notification, badge_count).await;
                }
                let _ = tx.commit().await;
            }
        });
    }

    // Return the created comment
    Ok(Json(ThreadedCommentResponse {
        id: comment.id,
        post_id: comment.post_id,
        parent_comment_id: comment.parent_comment_id,
        actor_id: comment.actor_id,
        content: comment.content,
        content_html: comment.content_html,
        actor_name: String::new(), // Will be populated by client from their cached data
        actor_handle: String::new(),
        actor_login_name: None,
        is_local: true,
        created_at: comment.created_at,
        updated_at: comment.updated_at,
        children: Vec::new(),
    }))
}

#[derive(Serialize)]
pub struct DeletePostResponse {
    pub success: bool,
}

pub async fn delete_post_api(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(post_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    // Require authentication
    let user = match auth_session.user {
        Some(u) => u,
        None => return Ok(StatusCode::UNAUTHORIZED.into_response()),
    };

    let post_uuid = Uuid::parse_str(&post_id)?;

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Find the post
    let post = find_post_by_id(&mut tx, post_uuid).await?;
    if post.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let post = post.unwrap();

    // Check if the user is the author
    let author_id = match post.get("author_id").and_then(|v| v.as_ref()) {
        Some(id) => id,
        None => return Ok(StatusCode::INTERNAL_SERVER_ERROR.into_response()),
    };

    if author_id != &user.id.to_string() {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    // Unlink hashtags before deleting post to properly decrement post_count
    let _ = unlink_post_hashtags(&mut tx, post_uuid).await;

    // Delete the post
    delete_post_with_activity(&mut tx, post_uuid, Some(&state)).await?;

    tx.commit().await?;

    Ok(Json(DeletePostResponse { success: true }).into_response())
}

#[derive(Deserialize)]
pub struct AddReactionRequest {
    // emoji comes from the URL path
}

#[derive(Serialize)]
pub struct ReactionResponse {
    pub reactions: Vec<ReactionCount>,
}

pub async fn add_reaction_api(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path((post_id, emoji)): Path<(Uuid, String)>,
) -> Result<impl IntoResponse, AppError> {
    // Require authentication
    let user = match auth_session.user {
        Some(u) => u,
        None => return Ok(StatusCode::UNAUTHORIZED.into_response()),
    };

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Find the user's actor
    let actor = Actor::find_by_user_id(&mut tx, user.id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No actor found for user"))?;

    // Check if user has already reacted with this emoji
    let existing_reaction = find_user_reaction(&mut tx, post_id, actor.id, &emoji).await?;
    if existing_reaction.is_some() {
        // Already reacted, just return current counts
        let user_actor_id = Some(actor.id);
        let reaction_counts = get_reaction_counts(&mut tx, post_id, user_actor_id).await?;
        tx.commit().await?;

        return Ok(Json(ReactionResponse {
            reactions: reaction_counts
                .into_iter()
                .map(|rc| ReactionCount {
                    emoji: rc.emoji,
                    count: rc.count,
                    reacted_by_user: rc.reacted_by_user,
                })
                .collect(),
        })
        .into_response());
    }

    // Create the reaction
    let reaction = create_reaction(
        &mut tx,
        ReactionDraft {
            post_id,
            actor_id: actor.id,
            emoji: emoji.clone(),
        },
        &state.config.domain,
    )
    .await?;

    // Get the post to find its author
    let post = find_post_by_id(&mut tx, post_id).await?;
    if let Some(post) = post {
        if let Some(author_id_str) = post.get("author_id").and_then(|v| v.as_ref()) {
            if let Ok(author_id) = Uuid::parse_str(author_id_str) {
                // Don't notify if reacting to own post
                if author_id != actor.id {
                    // Create notification for post author
                    let notification = create_notification(
                        &mut tx,
                        CreateNotificationParams {
                            recipient_id: author_id,
                            actor_id: actor.id,
                            post_id: Some(post_id),
                            comment_id: None,
                            notification_type: NotificationType::Reaction,
                            reaction_iri: Some(reaction.iri.clone()),
                            guestbook_entry_id: None,
                        },
                    )
                    .await?;

                    // Send push notification
                    let push_service = state.push_service.clone();
                    if let Ok(Some(notification_with_actor)) =
                        get_notification_by_id(&mut tx, notification.id, author_id).await
                    {
                        let badge_count = get_unread_count(&mut tx, author_id)
                            .await
                            .ok()
                            .and_then(|count| u32::try_from(count).ok());

                        send_push_for_notification(&push_service, &notification_with_actor, badge_count).await;
                    }
                }
            }
        }
    }

    // Get updated reaction counts
    let user_actor_id = Some(actor.id);
    let reaction_counts = get_reaction_counts(&mut tx, post_id, user_actor_id).await?;

    tx.commit().await?;

    Ok(Json(ReactionResponse {
        reactions: reaction_counts
            .into_iter()
            .map(|rc| ReactionCount {
                emoji: rc.emoji,
                count: rc.count,
                reacted_by_user: rc.reacted_by_user,
            })
            .collect(),
    })
    .into_response())
}

pub async fn remove_reaction_api(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path((post_id, emoji)): Path<(Uuid, String)>,
) -> Result<impl IntoResponse, AppError> {
    // Require authentication
    let user = match auth_session.user {
        Some(u) => u,
        None => return Ok(StatusCode::UNAUTHORIZED.into_response()),
    };

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Find the user's actor
    let actor = Actor::find_by_user_id(&mut tx, user.id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No actor found for user"))?;

    // Delete the reaction
    let _ = delete_reaction(&mut tx, post_id, actor.id, &emoji).await;

    // Get updated reaction counts
    let user_actor_id = Some(actor.id);
    let reaction_counts = get_reaction_counts(&mut tx, post_id, user_actor_id).await?;

    tx.commit().await?;

    Ok(Json(ReactionResponse {
        reactions: reaction_counts
            .into_iter()
            .map(|rc| ReactionCount {
                emoji: rc.emoji,
                count: rc.count,
                reacted_by_user: rc.reacted_by_user,
            })
            .collect(),
    })
    .into_response())
}
