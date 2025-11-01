use crate::app_error::AppError;
use crate::models::actor::create_actor_for_community;
use crate::models::comment::find_latest_comments_in_community;
use crate::models::community::{
    accept_invitation, add_community_member, create_community, create_invitation,
    find_community_by_id, find_community_by_slug, get_communities_members_count,
    get_community_members_with_details, get_community_stats, get_invitation_by_id, get_own_communities,
    get_participating_communities, get_pending_invitations_with_invitee_details_for_community,
    get_public_communities, get_user_role_in_community,
    is_user_member, reject_invitation, remove_community_member, update_community_with_activity,
    CommunityDraft, CommunityMemberRole, CommunityVisibility,
};
use crate::models::post::{find_published_posts_by_community_id, find_recent_posts_by_communities};
use crate::models::user::{AuthSession, find_user_by_login_name};
use crate::web::handlers::home::LoadMoreQuery;
use crate::web::handlers::{parse_id_with_legacy_support, ParsedId};
use crate::web::responses::{
    CommunityComment, CommunityDetailResponse, CommunitiesListResponse, CommunityInfo,
    CommunityPostThumbnail, CommunityStats, CommunityWithPosts, PaginationMeta,
};
use crate::web::state::AppState;
use axum::extract::{Path, Query};
use axum::http::{HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Redirect};
use axum::{extract::State, http::StatusCode, response::{Html, Json}, Form};
use axum_messages::Messages;
use minijinja::context;
use serde::Deserialize;
use std::collections::HashMap;
use uuid::Uuid;

use crate::web::context::CommonContext;
use crate::web::handlers::{get_bundle, ExtractAcceptLanguage, ExtractFtlLang};

pub async fn community(
    auth_session: AuthSession,
    headers: HeaderMap,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let (community, community_id) = if id.starts_with('@') {
        // Handle @slug format
        let slug = id.strip_prefix('@').unwrap().to_string();
        let community = find_community_by_slug(&mut tx, slug).await?;
        if let Some(community) = community {
            (Some(community.clone()), community.id.to_string())
        } else {
            (None, id)
        }
    } else {
        // Handle UUID format - redirect to @slug
        let uuid = match parse_id_with_legacy_support(&id, "/communities", &state)? {
            ParsedId::Uuid(uuid) => uuid,
            ParsedId::Redirect(redirect) => return Ok(redirect.into_response()),
            ParsedId::InvalidId(error_response) => return Ok(error_response),
        };
        let community = find_community_by_id(&mut tx, uuid).await?;
        if let Some(community) = &community {
            // Redirect UUID to @slug format
            return Ok(Redirect::to(&format!("/communities/@{}", community.slug)).into_response());
        } else {
            (None, id)
        }
    };

    if community.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let community_ref = community.as_ref().unwrap();
    let community_uuid = community_ref.id;

    // Access control: For member_only communities, verify membership
    if community_ref.visibility == CommunityVisibility::Private {
        // Non-authenticated users cannot access member_only communities
        let user_id = match &auth_session.user {
            Some(user) => user.id,
            None => return Ok(StatusCode::NOT_FOUND.into_response()),
        };

        // Check if user is a member
        let is_member = is_user_member(&mut tx, user_id, community_uuid).await?;
        if !is_member {
            return Ok(StatusCode::NOT_FOUND.into_response());
        }
    }

    let posts = find_published_posts_by_community_id(&mut tx, community_uuid, 1000, 0).await?;
    let comments = find_latest_comments_in_community(&mut tx, community_uuid, 5).await?;
    let stats = get_community_stats(&mut tx, community_uuid).await?;
    let common_ctx = CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("community.jinja").unwrap();

    if headers.get("HX-Request") == Some(&HeaderValue::from_static("true")) {
        let rendered = template
            .eval_to_state(context! {
                current_user => auth_session.user,
                community => {
                    community.as_ref()
                },
                community_id => community.as_ref().map(|c| c.id.to_string()).unwrap_or_default(),
                domain => state.config.domain.clone(),
                ftl_lang
            })?
            .render_block("community_edit_block")
            .unwrap();
        Ok(Html(rendered).into_response())
    } else {
        let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        community => community,
        community_id => community_id,
        domain => state.config.domain.clone(),
        unread_notification_count => common_ctx.unread_notification_count,
        comments => comments,
        stats => stats,
        posts => posts.iter().map(|post| {
            HashMap::<String, String>::from_iter(vec![
                ("id".to_string(), post.id.to_string()),
                ("title".to_string(), post.title.clone().unwrap_or_default().to_string()),
                ("author_id".to_string(), post.author_id.to_string()),
                ("user_login_name".to_string(), post.user_login_name.clone().unwrap_or_default()),
                ("image_filename".to_string(), post.image_filename.to_string()),
                ("image_width".to_string(), post.image_width.to_string()),
                ("image_height".to_string(), post.image_height.to_string()),
                ("replay_filename".to_string(), post.replay_filename.clone().unwrap_or_default()),
                ("created_at".to_string(), post.created_at.to_string()),
                ("updated_at".to_string(), post.updated_at.to_string()),
                ])
            }).collect::<Vec<_>>(),
            draft_post_count => common_ctx.draft_post_count,
            ftl_lang,
    })?;
        Ok(Html(rendered).into_response())
    }
}

pub async fn community_iframe(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let community = if id.starts_with('@') {
        // Handle @slug format
        let slug = id.strip_prefix('@').unwrap().to_string();
        find_community_by_slug(&mut tx, slug).await?
    } else {
        // Handle UUID format - redirect to @slug
        let uuid = match parse_id_with_legacy_support(&id, "/communities", &state)? {
            ParsedId::Uuid(uuid) => uuid,
            ParsedId::Redirect(redirect) => return Ok(redirect.into_response()),
            ParsedId::InvalidId(error_response) => return Ok(error_response),
        };
        let community = find_community_by_id(&mut tx, uuid).await?;
        if let Some(community) = &community {
            // Redirect UUID to @slug format
            return Ok(
                Redirect::to(&format!("/communities/@{}/embed", community.slug)).into_response(),
            );
        } else {
            None
        }
    };

    if community.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let community_ref = community.as_ref().unwrap();
    let community_uuid = community_ref.id;

    // Access control: For member_only communities, verify membership
    if community_ref.visibility == CommunityVisibility::Private {
        let user_id = match &auth_session.user {
            Some(user) => user.id,
            None => return Ok(StatusCode::NOT_FOUND.into_response()),
        };

        let is_member = is_user_member(&mut tx, user_id, community_uuid).await?;
        if !is_member {
            return Ok(StatusCode::NOT_FOUND.into_response());
        }
    }

    let posts = find_published_posts_by_community_id(&mut tx, community_uuid, 1000, 0).await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("community_iframe.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        community => community,
        posts => posts.iter().map(|post| {
            HashMap::<String, String>::from_iter(vec![
                ("id".to_string(), post.id.to_string()),
                ("title".to_string(), post.title.clone().unwrap_or_default().to_string()),
                ("author_id".to_string(), post.author_id.to_string()),
                ("user_login_name".to_string(), post.user_login_name.clone().unwrap_or_default()),
                ("image_filename".to_string(), post.image_filename.to_string()),
                ("image_width".to_string(), post.image_width.to_string()),
                ("image_height".to_string(), post.image_height.to_string()),
                ("replay_filename".to_string(), post.replay_filename.clone().unwrap_or_default()),
                ("created_at".to_string(), post.created_at.to_string()),
                ("updated_at".to_string(), post.updated_at.to_string()),
            ])
        }).collect::<Vec<_>>(),
        ftl_lang,
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn communities(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    messages: Messages,
) -> Result<Html<String>, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Fetch all communities
    let own_communities_raw = match auth_session.user.clone() {
        Some(user) => get_own_communities(&mut tx, user.id).await?,
        None => vec![],
    };

    let public_communities_raw = get_public_communities(&mut tx).await?;

    let participating_communities_raw = match auth_session.user.clone() {
        Some(user) => get_participating_communities(&mut tx, user.id).await?,
        None => vec![],
    };

    // Collect all community IDs for batch queries
    let mut all_community_ids: Vec<Uuid> = Vec::new();
    all_community_ids.extend(own_communities_raw.iter().map(|c| c.id));
    all_community_ids.extend(public_communities_raw.iter().map(|c| c.id));
    all_community_ids.extend(participating_communities_raw.iter().map(|c| c.id));
    all_community_ids.sort();
    all_community_ids.dedup();

    // Fetch recent posts (3 per community) for all communities
    let recent_posts = find_recent_posts_by_communities(&mut tx, &all_community_ids, 3).await?;

    // Fetch members count (unique contributors) and posts count for all communities
    let members_stats = get_communities_members_count(&mut tx, &all_community_ids).await?;

    let community_stats = if !all_community_ids.is_empty() {
        sqlx::query!(
            r#"
            SELECT
                p.community_id,
                COUNT(p.id) as posts_count
            FROM posts p
            WHERE p.community_id = ANY($1)
                AND p.published_at IS NOT NULL
                AND p.deleted_at IS NULL
            GROUP BY p.community_id
            "#,
            &all_community_ids
        )
        .fetch_all(&mut *tx)
        .await?
    } else {
        Vec::new()
    };

    // Fetch owner login names for own and participating communities
    let owner_ids: Vec<Uuid> = own_communities_raw.iter()
        .chain(participating_communities_raw.iter())
        .map(|c| c.owner_id)
        .collect();

    let owner_logins = if !owner_ids.is_empty() {
        sqlx::query!(
            r#"
            SELECT id, login_name
            FROM users
            WHERE id = ANY($1)
            "#,
            &owner_ids
        )
        .fetch_all(&mut *tx)
        .await?
    } else {
        Vec::new()
    };

    // Group posts by community_id
    use std::collections::HashMap as StdHashMap;
    let mut posts_by_community: StdHashMap<Uuid, Vec<serde_json::Value>> = StdHashMap::new();
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

    // Create stats lookup maps
    let mut members_by_community: StdHashMap<Uuid, Option<i64>> = StdHashMap::new();
    for stat in members_stats {
        members_by_community.insert(stat.community_id, stat.members_count);
    }

    let mut posts_count_by_community: StdHashMap<Uuid, Option<i64>> = StdHashMap::new();
    for stat in community_stats {
        posts_count_by_community.insert(stat.community_id, stat.posts_count);
    }

    // Create owner login lookup map
    let mut owner_login_by_id: StdHashMap<Uuid, String> = StdHashMap::new();
    for owner in owner_logins {
        owner_login_by_id.insert(owner.id, owner.login_name);
    }

    // Build own_communities with all metadata
    let own_communities: Vec<serde_json::Value> = own_communities_raw
        .into_iter()
        .map(|community| {
            let recent_posts = posts_by_community.get(&community.id).cloned().unwrap_or_default();
            let members_count = members_by_community.get(&community.id).cloned().unwrap_or(None);
            let posts_count = posts_count_by_community.get(&community.id).cloned().unwrap_or(None);
            let owner_login_name = owner_login_by_id.get(&community.owner_id).cloned().unwrap_or_default();

            serde_json::json!({
                "id": community.id.to_string(),
                "name": community.name,
                "slug": community.slug,
                "description": community.description,
                "visibility": community.visibility,
                "owner_login_name": owner_login_name,
                "posts_count": posts_count,
                "members_count": members_count,
                "recent_posts": recent_posts,
            })
        })
        .collect();

    // Build public_communities with all metadata
    let public_communities: Vec<serde_json::Value> = public_communities_raw
        .iter()
        .map(|community| {
            let recent_posts = posts_by_community.get(&community.id).cloned().unwrap_or_default();
            let members_count = members_by_community.get(&community.id).cloned().unwrap_or(None);

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

    // Filter official communities
    let official_communities: Vec<serde_json::Value> = public_communities
        .iter()
        .filter(|c| {
            c.get("owner_login_name")
                .and_then(|v| v.as_str())
                .map(|name| name == state.config.official_account_login_name)
                .unwrap_or(false)
        })
        .cloned()
        .collect();

    // Build participating_communities with all metadata
    let participating_communities: Vec<serde_json::Value> = participating_communities_raw
        .into_iter()
        .map(|community| {
            let recent_posts = posts_by_community.get(&community.id).cloned().unwrap_or_default();
            let members_count = members_by_community.get(&community.id).cloned().unwrap_or(None);
            let posts_count = posts_count_by_community.get(&community.id).cloned().unwrap_or(None);
            let owner_login_name = owner_login_by_id.get(&community.owner_id).cloned().unwrap_or_default();

            serde_json::json!({
                "id": community.id.to_string(),
                "name": community.name,
                "slug": community.slug,
                "description": community.description,
                "visibility": community.visibility,
                "owner_login_name": owner_login_name,
                "posts_count": posts_count,
                "members_count": members_count,
                "recent_posts": recent_posts,
            })
        })
        .collect();

    let common_ctx = CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    tx.commit().await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("communities.jinja")?;
    let rendered = template.clone().render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        messages => messages.into_iter().collect::<Vec<_>>(),
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        official_communities,
        public_communities,
        participating_communities,
        own_communities,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        ftl_lang
    })?;

    Ok(Html(rendered))
}

#[derive(Deserialize)]
pub struct CreateCommunityForm {
    name: String,
    slug: String,
    description: String,
    visibility: String,
}

pub async fn do_create_community(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    messages: Messages,
    Form(form): Form<CreateCommunityForm>,
) -> Result<impl IntoResponse, AppError> {
    if form.name.is_empty() {
        return Ok(StatusCode::BAD_REQUEST.into_response());
    }

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Parse visibility from form
    let visibility = match form.visibility.as_str() {
        "public" => CommunityVisibility::Public,
        "unlisted" => CommunityVisibility::Unlisted,
        "private" => CommunityVisibility::Private,
        _ => CommunityVisibility::Public, // Default to public
    };

    let community = create_community(
        &mut tx,
        auth_session.user.clone().unwrap().id,
        CommunityDraft {
            name: form.name,
            slug: form.slug,
            description: form.description,
            visibility,
        },
    )
    .await?;

    // Create actor for the community (only for non-member_only communities)
    if visibility != CommunityVisibility::Private {
        match create_actor_for_community(&mut tx, &community, &state.config).await {
            Ok(_) => {
                let _ = tx.commit().await;
                Ok(Redirect::to(&format!("/communities/@{}", community.slug)).into_response())
            }
            Err(e) => {
                let _ = tx.rollback().await;
                // Check if it's a unique constraint violation (handle conflict)
                if let Some(db_error) = e.downcast_ref::<sqlx::Error>() {
                    if let sqlx::Error::Database(db_err) = db_error {
                        if db_err.constraint().is_some() {
                            let user_preferred_language = auth_session
                                .user
                                .clone()
                                .map(|u| u.preferred_language)
                                .unwrap_or_else(|| None);
                            let bundle = get_bundle(&accept_language, user_preferred_language);
                            let error_message = bundle.format_pattern(
                                bundle
                                    .get_message("community-slug-conflict-error")
                                    .unwrap()
                                    .value()
                                    .unwrap(),
                                None,
                                &mut vec![],
                            );
                            messages.error(error_message.to_string());
                            return Ok(Redirect::to("/communities/new").into_response());
                        }
                    }
                }
                // For other errors, re-throw
                Err(e.into())
            }
        }
    } else {
        // Member-only community, no actor needed
        let _ = tx.commit().await;
        Ok(Redirect::to(&format!("/communities/@{}", community.slug)).into_response())
    }
}

pub async fn create_community_form(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    messages: Messages,
) -> Result<Html<String>, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;
    let common_ctx = CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("create_community.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        messages => messages.into_iter().collect::<Vec<_>>(),
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        ftl_lang
    })?;

    Ok(Html(rendered))
}

pub async fn hx_edit_community(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let community = if id.starts_with('@') {
        // Handle @slug format
        let slug = id.strip_prefix('@').unwrap().to_string();
        find_community_by_slug(&mut tx, slug).await?
    } else {
        // Handle UUID format - redirect to @slug
        let community_uuid = Uuid::parse_str(&id)?;
        let community = find_community_by_id(&mut tx, community_uuid).await?;
        if let Some(community) = &community {
            // Redirect UUID to @slug format
            return Ok(
                Redirect::to(&format!("/communities/@{}/edit", community.slug)).into_response(),
            );
        } else {
            None
        }
    };

    if community.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    if community.clone().unwrap().owner_id != auth_session.user.clone().unwrap().id {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    let common_ctx = CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("community_edit.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        community,
        community_id => id,
        domain => state.config.domain.clone(),
        unread_notification_count => common_ctx.unread_notification_count,
        ftl_lang
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn hx_do_edit_community(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Form(form): Form<CreateCommunityForm>,
) -> Result<impl IntoResponse, AppError> {
    if form.name.is_empty() {
        return Ok(StatusCode::BAD_REQUEST.into_response());
    }

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let (community_uuid, original_slug) = if id.starts_with('@') {
        // Handle @slug format
        let slug = id.strip_prefix('@').unwrap().to_string();
        let community = find_community_by_slug(&mut tx, slug.clone()).await?;
        if let Some(community) = community {
            (community.id, community.slug)
        } else {
            return Ok(StatusCode::NOT_FOUND.into_response());
        }
    } else {
        // Handle UUID format - redirect to @slug
        let uuid = Uuid::parse_str(&id)?;
        let community = find_community_by_id(&mut tx, uuid).await?;
        if let Some(_community) = &community {
            // Redirect UUID to @slug format for PUT request
            return Ok(StatusCode::PERMANENT_REDIRECT.into_response());
        } else {
            return Ok(StatusCode::NOT_FOUND.into_response());
        }
    };

    // Update the community (with ActivityPub Update activity)
    // Parse visibility from form
    let visibility = match form.visibility.as_str() {
        "public" => CommunityVisibility::Public,
        "unlisted" => CommunityVisibility::Unlisted,
        "private" => CommunityVisibility::Private,
        _ => CommunityVisibility::Public, // Default to public
    };

    let community_draft = CommunityDraft {
        name: form.name.clone(),
        slug: form.slug.clone(),
        description: form.description.clone(),
        visibility,
    };

    match update_community_with_activity(
        &mut tx,
        community_uuid,
        community_draft,
        &state.config,
        Some(&state),
    )
    .await
    {
        Ok(updated_community) => {
            // Success - commit transaction
            let _ = tx.commit().await;

            // Check if slug changed - if so, redirect entire page to new URL
            if form.slug != original_slug {
                // Use HTMX redirect to navigate to new slug URL
                Ok(([(
                    "HX-Redirect",
                    format!("/communities/@{}", form.slug).as_str(),
                )],)
                    .into_response())
            } else {
                // Slug didn't change - return updated content block
                let template = state.env.get_template("community.jinja")?;
                let user_preferred_language = auth_session
                    .user
                    .clone()
                    .map(|u| u.preferred_language)
                    .unwrap_or_else(|| None);
                let bundle = get_bundle(&accept_language, user_preferred_language);
                let ftl_lang = bundle.locales.first().unwrap().to_string();
                let rendered = template
                    .eval_to_state(context! {
                        current_user => auth_session.user,
                        community => updated_community,
                        community_id => updated_community.id.to_string(),
                        domain => state.config.domain.clone(),
                        ftl_lang
                    })?
                    .render_block("community_edit_block")?;

                Ok(Html(rendered).into_response())
            }
        }
        Err(e) => {
            // Error - rollback transaction and return edit form with error
            let _ = tx.rollback().await;

            // Check if it's a constraint violation (slug conflict)
            let error_message = if let Some(db_error) = e.downcast_ref::<sqlx::Error>() {
                if let sqlx::Error::Database(db_err) = db_error {
                    if db_err.constraint().is_some() {
                        let user_preferred_language = auth_session
                            .user
                            .clone()
                            .map(|u| u.preferred_language)
                            .unwrap_or_else(|| None);
                        let bundle = get_bundle(&accept_language, user_preferred_language);
                        Some(
                            bundle
                                .format_pattern(
                                    bundle
                                        .get_message("community-slug-conflict-error")
                                        .unwrap()
                                        .value()
                                        .unwrap(),
                                    None,
                                    &mut vec![],
                                )
                                .to_string(),
                        )
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };

            // Get current community data to show in the form
            let mut tx = db.begin().await?;
            let current_community = find_community_by_id(&mut tx, community_uuid).await?;

            let template = state.env.get_template("community_edit.jinja")?;
            let user_preferred_language = auth_session
                .user
                .clone()
                .map(|u| u.preferred_language)
                .unwrap_or_else(|| None);
            let bundle = get_bundle(&accept_language, user_preferred_language);
            let ftl_lang = bundle.locales.first().unwrap().to_string();
            let rendered = template.render(context! {
                current_user => auth_session.user,
                community => current_community,
                community_id => id,
                domain => state.config.domain.clone(),
                error_message => error_message,
                ftl_lang
            })?;

            Ok(Html(rendered).into_response())
        }
    }
}

pub async fn community_comments(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let community = if id.starts_with('@') {
        // Handle @slug format
        let slug = id.strip_prefix('@').unwrap().to_string();
        find_community_by_slug(&mut tx, slug).await?
    } else {
        // Handle UUID format - redirect to @slug
        let uuid = match parse_id_with_legacy_support(&id, "/communities", &state)? {
            ParsedId::Uuid(uuid) => uuid,
            ParsedId::Redirect(redirect) => return Ok(redirect.into_response()),
            ParsedId::InvalidId(error_response) => return Ok(error_response),
        };
        let community = find_community_by_id(&mut tx, uuid).await?;
        if let Some(community) = &community {
            // Redirect UUID to @slug format
            return Ok(
                Redirect::to(&format!("/communities/@{}/comments", community.slug)).into_response(),
            );
        } else {
            None
        }
    };

    if community.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let community_ref = community.as_ref().unwrap();
    let community_uuid = community_ref.id;

    // Access control: For member_only communities, verify membership
    if community_ref.visibility == CommunityVisibility::Private {
        let user_id = match &auth_session.user {
            Some(user) => user.id,
            None => return Ok(StatusCode::NOT_FOUND.into_response()),
        };

        let is_member = is_user_member(&mut tx, user_id, community_uuid).await?;
        if !is_member {
            return Ok(StatusCode::NOT_FOUND.into_response());
        }
    }

    // Get more comments for the dedicated comments page (100 instead of 5)
    let comments = find_latest_comments_in_community(&mut tx, community_uuid, 100).await?;
    let common_ctx = CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("community_comments.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        community => community,
        comments => comments,
        domain => state.config.domain.clone(),
        unread_notification_count => common_ctx.unread_notification_count,
        draft_post_count => common_ctx.draft_post_count,
        ftl_lang,
    })?;

    Ok(Html(rendered).into_response())
}

// ========== Member Management Endpoints ==========

/// List community members
pub async fn get_members(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let community = find_community_by_slug(&mut tx, slug.strip_prefix('@').unwrap_or(&slug).to_string()).await?;

    if community.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let community = community.unwrap();

    // Only members can view member list
    let user = match auth_session.user {
        Some(user) => user,
        None => return Ok(StatusCode::UNAUTHORIZED.into_response()),
    };

    let is_member = is_user_member(&mut tx, user.id, community.id).await?;
    if !is_member {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    // Fetch members with user details in a single query (no N+1)
    let members = get_community_members_with_details(&mut tx, community.id).await?;

    let members_with_details: Vec<serde_json::Value> = members
        .into_iter()
        .map(|member| {
            serde_json::json!({
                "id": member.id,
                "user_id": member.user_id,
                "login_name": member.login_name,
                "display_name": member.display_name,
                "role": member.role,
                "joined_at": member.joined_at,
            })
        })
        .collect();

    tx.commit().await?;

    Ok(axum::Json(members_with_details).into_response())
}

/// Invite a user to a community
#[derive(Deserialize)]
pub struct InviteUserForm {
    login_name: String,
}

pub async fn invite_user(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(slug): Path<String>,
    messages: Messages,
    Form(form): Form<InviteUserForm>,
) -> Result<impl IntoResponse, AppError> {
    let user_preferred_language = auth_session
        .user
        .as_ref()
        .and_then(|u| u.preferred_language.clone());
    let bundle = get_bundle(&accept_language, user_preferred_language);

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let community = find_community_by_slug(&mut tx, slug.strip_prefix('@').unwrap_or(&slug).to_string()).await?;

    if community.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let community = community.unwrap();

    // Must be logged in
    let inviter = match auth_session.user {
        Some(user) => user,
        None => return Ok(StatusCode::UNAUTHORIZED.into_response()),
    };

    // Check if user is owner or moderator
    let role = get_user_role_in_community(&mut tx, inviter.id, community.id).await?;
    match role {
        Some(CommunityMemberRole::Owner) | Some(CommunityMemberRole::Moderator) => {},
        _ => return Ok(StatusCode::FORBIDDEN.into_response()),
    }

    // Find the invitee by login_name
    let invitee = find_user_by_login_name(&mut tx, &form.login_name).await?;
    if invitee.is_none() {
        messages.error(
            bundle.format_pattern(
                bundle.get_message("community-invite-user-not-found").unwrap().value().unwrap(),
                None,
                &mut vec![],
            ),
        );
        return Ok(Redirect::to(&format!("/communities/@{}/members", community.slug)).into_response());
    }
    let invitee = invitee.unwrap();

    // Check if user is already a member
    let already_member = is_user_member(&mut tx, invitee.id, community.id).await?;
    if already_member {
        messages.error(
            bundle.format_pattern(
                bundle.get_message("community-invite-already-member").unwrap().value().unwrap(),
                None,
                &mut vec![],
            ),
        );
        return Ok(Redirect::to(&format!("/communities/@{}/members", community.slug)).into_response());
    }

    // Create invitation
    match create_invitation(&mut tx, community.id, inviter.id, invitee.id).await {
        Ok(_invitation) => {
            tx.commit().await?;

            messages.success(
                bundle.format_pattern(
                    bundle.get_message("community-invite-success").unwrap().value().unwrap(),
                    None,
                    &mut vec![],
                ),
            );

            Ok(Redirect::to(&format!("/communities/@{}/members", community.slug)).into_response())
        }
        Err(e) => {
            // Check if this is a duplicate key constraint error
            if let Some(db_err) = e.downcast_ref::<sqlx::Error>() {
                if let sqlx::Error::Database(ref err) = db_err {
                    if err.is_unique_violation() {
                        messages.error(
                            bundle.format_pattern(
                                bundle.get_message("community-invite-already-invited").unwrap().value().unwrap(),
                                None,
                                &mut vec![],
                            ),
                        );
                        return Ok(Redirect::to(&format!("/communities/@{}/members", community.slug)).into_response());
                    }
                }
            }
            // For other errors, propagate them
            Err(e.into())
        }
    }
}

/// Remove a member from a community
pub async fn remove_member(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path((slug, user_id)): Path<(String, Uuid)>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let community = find_community_by_slug(&mut tx, slug.strip_prefix('@').unwrap_or(&slug).to_string()).await?;

    if community.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let community = community.unwrap();

    // Must be logged in
    let current_user = match auth_session.user {
        Some(user) => user,
        None => return Ok(StatusCode::UNAUTHORIZED.into_response()),
    };

    // Check if current user is owner or moderator
    let current_role = get_user_role_in_community(&mut tx, current_user.id, community.id).await?;
    match current_role {
        Some(CommunityMemberRole::Owner) | Some(CommunityMemberRole::Moderator) => {},
        _ => return Ok(StatusCode::FORBIDDEN.into_response()),
    }

    // Cannot remove the owner
    let target_role = get_user_role_in_community(&mut tx, user_id, community.id).await?;
    if target_role == Some(CommunityMemberRole::Owner) {
        return Ok((StatusCode::BAD_REQUEST, "Cannot remove community owner").into_response());
    }

    // Remove the member
    remove_community_member(&mut tx, community.id, user_id).await?;

    tx.commit().await?;

    // Return empty HTML for HTMX to remove the row
    Ok(Html(String::new()).into_response())
}

// ========== Invitation Endpoints ==========

/// Accept an invitation
pub async fn do_accept_invitation(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(invitation_id): Path<Uuid>,
    messages: Messages,
) -> Result<impl IntoResponse, AppError> {
    let user = match &auth_session.user {
        Some(user) => user,
        None => return Ok(StatusCode::UNAUTHORIZED.into_response()),
    };

    let user_preferred_language = user.preferred_language.clone();
    let bundle = get_bundle(&accept_language, user_preferred_language);

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Get the invitation
    let invitation = get_invitation_by_id(&mut tx, invitation_id).await?;
    if invitation.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let invitation = invitation.unwrap();

    // Verify the invitation is for the current user
    if invitation.invitee_id != user.id {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    // Get community info for validation
    let _community = find_community_by_id(&mut tx, invitation.community_id).await?;
    let _community = _community.ok_or_else(|| anyhow::anyhow!("Community not found"))?;

    // Accept the invitation
    accept_invitation(&mut tx, invitation_id).await?;

    // Add user as a member
    add_community_member(
        &mut tx,
        invitation.community_id,
        user.id,
        CommunityMemberRole::Member,
        Some(invitation.inviter_id),
    ).await?;

    tx.commit().await?;

    messages.success(
        bundle.format_pattern(
            bundle.get_message("invitation-accepted").unwrap().value().unwrap(),
            None,
            &mut vec![],
        ),
    );

    Ok(Redirect::to("/notifications").into_response())
}

/// Reject an invitation
pub async fn do_reject_invitation(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
    Path(invitation_id): Path<Uuid>,
    messages: Messages,
) -> Result<impl IntoResponse, AppError> {
    let user = match &auth_session.user {
        Some(user) => user,
        None => return Ok(StatusCode::UNAUTHORIZED.into_response()),
    };

    let user_preferred_language = user.preferred_language.clone();
    let bundle = get_bundle(&accept_language, user_preferred_language);

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Get the invitation
    let invitation = get_invitation_by_id(&mut tx, invitation_id).await?;
    if invitation.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let invitation = invitation.unwrap();

    // Verify the invitation is for the current user
    if invitation.invitee_id != user.id {
        return Ok(StatusCode::FORBIDDEN.into_response());
    }

    // Reject the invitation
    reject_invitation(&mut tx, invitation_id).await?;

    tx.commit().await?;

    messages.success(
        bundle.format_pattern(
            bundle.get_message("invitation-rejected").unwrap().value().unwrap(),
            None,
            &mut vec![],
        ),
    );

    Ok(Redirect::to("/notifications").into_response())
}

/// Retract/cancel a pending invitation
pub async fn retract_invitation(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path((slug, invitation_id)): Path<(String, Uuid)>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let community = find_community_by_slug(&mut tx, slug.strip_prefix('@').unwrap_or(&slug).to_string()).await?;

    if community.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let community = community.unwrap();

    // Must be logged in
    let user = match &auth_session.user {
        Some(user) => user,
        None => return Ok(StatusCode::UNAUTHORIZED.into_response()),
    };

    // Check if user is owner or moderator
    let user_role = get_user_role_in_community(&mut tx, user.id, community.id).await?;
    match user_role {
        Some(CommunityMemberRole::Owner) | Some(CommunityMemberRole::Moderator) => {},
        _ => return Ok(StatusCode::FORBIDDEN.into_response()),
    }

    // Delete the invitation
    sqlx::query!(
        "DELETE FROM community_invitations WHERE id = $1 AND community_id = $2 AND status = 'pending'",
        invitation_id,
        community.id
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // Return empty HTML for HTMX to remove the row
    Ok(Html(String::new()).into_response())
}

/// Render members management page
pub async fn members_page(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(slug): Path<String>,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    messages: Messages,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let community = find_community_by_slug(&mut tx, slug.strip_prefix('@').unwrap_or(&slug).to_string()).await?;

    if community.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }

    let community = community.unwrap();

    // For private/unlisted communities, only members can view member list
    // For public communities, anyone can view
    let user_role = if community.visibility != crate::models::community::CommunityVisibility::Public {
        // Private or unlisted community - require membership
        let user = match &auth_session.user {
            Some(user) => user,
            None => return Ok(StatusCode::UNAUTHORIZED.into_response()),
        };

        let is_member = is_user_member(&mut tx, user.id, community.id).await?;
        if !is_member {
            return Ok(StatusCode::FORBIDDEN.into_response());
        }

        // Get user's role to determine permissions
        get_user_role_in_community(&mut tx, user.id, community.id).await?
    } else {
        // Public community - anyone can view, but only logged-in members have roles
        match &auth_session.user {
            Some(user) => get_user_role_in_community(&mut tx, user.id, community.id).await?,
            None => None,
        }
    };

    // Fetch members with user details in a single query (no N+1)
    let members = get_community_members_with_details(&mut tx, community.id).await?;

    let members_with_details: Vec<serde_json::Value> = members
        .into_iter()
        .map(|member| {
            serde_json::json!({
                "id": member.id,
                "user_id": member.user_id,
                "login_name": member.login_name,
                "display_name": member.display_name,
                "role": member.role,
                "joined_at": member.joined_at,
            })
        })
        .collect();

    // Fetch pending invitations with invitee details in a single query (no N+1)
    let pending_invitations = match user_role {
        Some(CommunityMemberRole::Owner) | Some(CommunityMemberRole::Moderator) => {
            let invitations = get_pending_invitations_with_invitee_details_for_community(&mut tx, community.id).await?;
            invitations
                .into_iter()
                .map(|invitation| {
                    serde_json::json!({
                        "id": invitation.id,
                        "invitee_login_name": invitation.invitee_login_name,
                        "invitee_display_name": invitation.invitee_display_name,
                        "created_at": invitation.created_at,
                    })
                })
                .collect()
        },
        _ => Vec::new(),
    };

    let common_ctx = CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    tx.commit().await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("community_members.jinja")?;
    let rendered = template.render(context! {
        current_user => auth_session.user,
        community,
        members => members_with_details,
        pending_invitations,
        user_role,
        can_invite => matches!(user_role, Some(CommunityMemberRole::Owner) | Some(CommunityMemberRole::Moderator)),
        can_remove => matches!(user_role, Some(CommunityMemberRole::Owner) | Some(CommunityMemberRole::Moderator)),
        messages => messages.into_iter().collect::<Vec<_>>(),
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        ftl_lang,
    })?;

    Ok(Html(rendered).into_response())
}

pub async fn community_detail_json(
    _auth_session: AuthSession,
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(query): Query<LoadMoreQuery>,
) -> Result<Json<CommunityDetailResponse>, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Strip @ prefix if present
    let slug = slug.strip_prefix('@').unwrap_or(&slug);

    let community = find_community_by_slug(&mut tx, slug.to_string())
        .await?
        .ok_or_else(|| anyhow::anyhow!("Community not found"))?;

    // Access control: For private communities, return 404 for unauthenticated users
    // Note: We're not checking membership here, just returning public info
    // The iOS app can show "private community" UI
    if community.visibility == CommunityVisibility::Private {
        // For now, return basic info but no posts/comments for private communities
    }

    let posts = find_published_posts_by_community_id(&mut tx, community.id, query.limit, query.offset).await?;
    let comments = find_latest_comments_in_community(&mut tx, community.id, 5).await?;
    let stats = get_community_stats(&mut tx, community.id).await?;

    tx.commit().await?;

    // Convert posts to typed structs with minimal fields for thumbnails
    let posts_typed: Vec<CommunityPostThumbnail> = posts
        .into_iter()
        .map(|post| {
            let image_prefix = &post.image_filename[..2];
            CommunityPostThumbnail {
                id: post.id,
                image_url: format!(
                    "{}/image/{}/{}",
                    state.config.r2_public_endpoint_url, image_prefix, post.image_filename
                ),
                image_width: post.image_width,
                image_height: post.image_height,
                is_sensitive: post.is_sensitive.unwrap_or(false),
            }
        })
        .collect();

    // Convert comments to typed structs
    let comments_typed: Vec<CommunityComment> = comments
        .into_iter()
        .map(|comment| {
            let post_image_url = comment.post_image_filename.as_ref().map(|filename| {
                let image_prefix = &filename[..2];
                format!(
                    "{}/image/{}/{}",
                    state.config.r2_public_endpoint_url, image_prefix, filename
                )
            });

            CommunityComment {
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

    let has_more = posts_typed.len() as i64 == query.limit;

    Ok(Json(CommunityDetailResponse {
        community: CommunityInfo {
            id: community.id,
            name: community.name,
            slug: community.slug,
            description: community.description,
            visibility: community.visibility,
            owner_id: community.owner_id,
            background_color: community.background_color,
            foreground_color: community.foreground_color,
        },
        stats: CommunityStats {
            total_posts: stats.total_posts,
            total_contributors: stats.total_contributors,
            total_comments: stats.total_comments,
        },
        posts: posts_typed,
        pagination: PaginationMeta {
            offset: query.offset + query.limit,
            limit: query.limit,
            total: None,
            has_more,
        },
        comments: comments_typed,
    }))
}

/// Get communities list for mobile apps (my communities + public communities)
pub async fn get_communities_list_json(
    auth_session: AuthSession,
    State(state): State<AppState>,
) -> Result<Json<CommunitiesListResponse>, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Fetch user's own communities and participating communities if authenticated
    let (own_communities_raw, participating_communities_raw) = if let Some(user) = &auth_session.user {
        let own = get_own_communities(&mut tx, user.id).await?;
        let participating = get_participating_communities(&mut tx, user.id).await?;
        (own, participating)
    } else {
        (vec![], vec![])
    };

    // Combine own and participating communities
    let mut my_communities_raw = own_communities_raw;
    my_communities_raw.extend(participating_communities_raw);

    // Fetch public communities (with at least 10 posts)
    let public_communities_raw = get_public_communities(&mut tx).await?;
    let public_communities_raw: Vec<_> = public_communities_raw
        .into_iter()
        .filter(|c| c.posts_count.unwrap_or(0) >= 10)
        .take(20) // Return more communities for the dedicated communities tab
        .collect();

    // Collect all community IDs for batch queries
    let mut all_community_ids: Vec<Uuid> = Vec::new();
    all_community_ids.extend(my_communities_raw.iter().map(|c| c.id));
    all_community_ids.extend(public_communities_raw.iter().map(|c| c.id));
    all_community_ids.sort();
    all_community_ids.dedup();

    // Fetch recent posts (3 per community) for all communities
    let recent_posts = find_recent_posts_by_communities(&mut tx, &all_community_ids, 3).await?;

    // Fetch members count for all communities
    let members_stats = get_communities_members_count(&mut tx, &all_community_ids).await?;

    // Fetch owner login names for my communities
    let owner_ids: Vec<Uuid> = my_communities_raw.iter().map(|c| c.owner_id).collect();
    let owner_logins = if !owner_ids.is_empty() {
        sqlx::query!(
            r#"
            SELECT id, login_name
            FROM users
            WHERE id = ANY($1)
            "#,
            &owner_ids
        )
        .fetch_all(&mut *tx)
        .await?
    } else {
        Vec::new()
    };

    tx.commit().await?;

    // Group posts by community_id
    use std::collections::HashMap as StdHashMap;
    let mut posts_by_community: StdHashMap<Uuid, Vec<CommunityPostThumbnail>> = StdHashMap::new();
    for post in recent_posts {
        let posts = posts_by_community.entry(post.community_id).or_insert_with(Vec::new);
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
    let mut members_by_community: StdHashMap<Uuid, Option<i64>> = StdHashMap::new();
    for stat in members_stats {
        members_by_community.insert(stat.community_id, stat.members_count);
    }

    // Create owner login lookup map
    let mut owner_login_by_id: StdHashMap<Uuid, String> = StdHashMap::new();
    for owner in owner_logins {
        owner_login_by_id.insert(owner.id, owner.login_name);
    }

    // Build my_communities with all metadata
    let my_communities: Vec<CommunityWithPosts> = my_communities_raw
        .into_iter()
        .map(|community| {
            let recent_posts = posts_by_community.get(&community.id).cloned().unwrap_or_default();
            let members_count = members_by_community.get(&community.id).cloned().unwrap_or(None);
            let posts_count = recent_posts.len() as i64;
            let owner_login_name = owner_login_by_id.get(&community.owner_id).cloned().unwrap_or_default();

            CommunityWithPosts {
                id: community.id,
                name: community.name,
                slug: community.slug,
                description: community.description,
                visibility: community.visibility,
                owner_login_name,
                posts_count: Some(posts_count),
                members_count,
                recent_posts,
            }
        })
        .collect();

    // Build public_communities with all metadata
    let public_communities: Vec<CommunityWithPosts> = public_communities_raw
        .into_iter()
        .map(|community| {
            let recent_posts = posts_by_community.get(&community.id).cloned().unwrap_or_default();
            let members_count = members_by_community.get(&community.id).cloned().unwrap_or(None);

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

    Ok(Json(CommunitiesListResponse {
        my_communities,
        public_communities,
    }))
}

