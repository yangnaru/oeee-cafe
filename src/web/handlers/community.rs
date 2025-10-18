use crate::app_error::AppError;
use crate::models::actor::create_actor_for_community;
use crate::models::comment::find_latest_comments_in_community;
use crate::models::community::{
    create_community, find_community_by_id, find_community_by_slug, get_community_stats,
    get_own_communities, get_participating_communities, get_public_communities,
    update_community_with_activity, CommunityDraft,
};
use crate::models::post::find_published_posts_by_community_id;
use crate::models::user::AuthSession;
use crate::web::handlers::{parse_id_with_legacy_support, ParsedId};
use crate::web::state::AppState;
use axum::extract::Path;
use axum::http::{HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Redirect};
use axum::{extract::State, http::StatusCode, response::Html, Form};
use axum_messages::Messages;
use minijinja::context;
use serde::Deserialize;
use std::collections::HashMap;
use uuid::Uuid;

use crate::web::context::CommonContext;
use crate::web::handlers::ExtractFtlLang;

use super::{get_bundle, ExtractAcceptLanguage};

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

    let community_uuid = community.as_ref().unwrap().id;
    let posts = find_published_posts_by_community_id(&mut tx, community_uuid).await?;
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

    let community_uuid = community.as_ref().unwrap().id;
    let posts = find_published_posts_by_community_id(&mut tx, community_uuid).await?;

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

    // Fetch recent posts (3 per community) for all communities in a single batch query
    let recent_posts = if !all_community_ids.is_empty() {
        sqlx::query!(
            r#"
            SELECT
                ranked.id,
                ranked.community_id,
                ranked.image_filename,
                ranked.image_width,
                ranked.image_height,
                ranked.author_login_name
            FROM (
                SELECT
                    p.id,
                    p.community_id,
                    i.image_filename,
                    i.width as image_width,
                    i.height as image_height,
                    u.login_name as author_login_name,
                    ROW_NUMBER() OVER (PARTITION BY p.community_id ORDER BY p.published_at DESC) as rn
                FROM posts p
                INNER JOIN images i ON p.image_id = i.id
                INNER JOIN users u ON p.author_id = u.id
                WHERE p.community_id = ANY($1)
                    AND p.published_at IS NOT NULL
                    AND p.deleted_at IS NULL
            ) ranked
            WHERE ranked.rn <= 3
            ORDER BY ranked.community_id, ranked.rn
            "#,
            &all_community_ids
        )
        .fetch_all(&mut *tx)
        .await?
    } else {
        Vec::new()
    };

    // Fetch members count (unique contributors) and posts count for all communities
    let community_stats = if !all_community_ids.is_empty() {
        sqlx::query!(
            r#"
            SELECT
                p.community_id,
                COUNT(DISTINCT p.author_id) as members_count,
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

    // Create stats lookup map
    let mut stats_by_community: StdHashMap<Uuid, (Option<i64>, Option<i64>)> = StdHashMap::new();
    for stat in community_stats {
        stats_by_community.insert(stat.community_id, (stat.members_count, stat.posts_count));
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
            let (members_count, posts_count) = stats_by_community.get(&community.id).cloned().unwrap_or((None, None));
            let owner_login_name = owner_login_by_id.get(&community.owner_id).cloned().unwrap_or_default();

            serde_json::json!({
                "id": community.id.to_string(),
                "name": community.name,
                "slug": community.slug,
                "description": community.description,
                "is_private": community.is_private,
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
            let (members_count, _) = stats_by_community.get(&community.id).cloned().unwrap_or((None, None));

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
            let (members_count, posts_count) = stats_by_community.get(&community.id).cloned().unwrap_or((None, None));
            let owner_login_name = owner_login_by_id.get(&community.owner_id).cloned().unwrap_or_default();

            serde_json::json!({
                "id": community.id.to_string(),
                "name": community.name,
                "slug": community.slug,
                "description": community.description,
                "is_private": community.is_private,
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
    is_private: Option<String>,
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
    let community = create_community(
        &mut tx,
        auth_session.user.clone().unwrap().id,
        CommunityDraft {
            name: form.name,
            slug: form.slug,
            description: form.description,
            is_private: form.is_private == Some("on".to_string()),
        },
    )
    .await?;

    // Create actor for the community
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
    let community_draft = CommunityDraft {
        name: form.name.clone(),
        slug: form.slug.clone(),
        description: form.description.clone(),
        is_private: form.is_private == Some("on".to_string()),
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

    let community_uuid = community.as_ref().unwrap().id;
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
