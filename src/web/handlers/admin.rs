//! Staff-only views. Every handler here takes `AdminUser`, which is what makes
//! the unfiltered queries in `models::admin` safe to expose.
//!
//! Copy is intentionally untranslated: this surface is staff-only, so it is not
//! worth carrying through the four locale bundles.

use crate::app_error::AppError;
use crate::models::admin::{
    count_all_posts, find_all_communities, find_all_posts, find_all_users, find_community_by_slug,
    find_post_by_id, AdminCommunity, AdminPostFilter,
};
use crate::models::user::find_user_by_login_name;
use crate::web::context::CommonContext;
use crate::web::handlers::{AdminUser, ExtractFtlLang};
use crate::web::state::AppState;
use axum::extract::{Path, Query, State};
use axum::response::Html;
use minijinja::context;
use serde::Deserialize;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

const POSTS_PER_PAGE: i64 = 60;
const USERS_PER_PAGE: i64 = 100;

/// Filters for the global post list. `author` and `community` are the
/// human-readable identifiers so the URLs stay hand-editable.
///
/// `drafts` / `deleted` are `Option<String>` rather than `bool` because HTML
/// checkboxes submit `drafts=on` when ticked and omit the key entirely when
/// not; presence is the signal.
#[derive(Debug, Default, Deserialize)]
pub struct AdminPostsQuery {
    pub author: Option<String>,
    pub community: Option<String>,
    pub drafts: Option<String>,
    pub deleted: Option<String>,
    pub page: Option<i64>,
}

struct ResolvedFilter {
    filter: AdminPostFilter,
    author_login_name: Option<String>,
    community_slug: Option<String>,
}

/// Turns login_name/slug into ids. An unknown name yields a filter that matches
/// nothing rather than silently widening the list to every post.
async fn resolve_filter(
    tx: &mut Transaction<'_, Postgres>,
    query: &AdminPostsQuery,
) -> Result<ResolvedFilter, AppError> {
    let mut filter = AdminPostFilter {
        include_drafts: query.drafts.is_some(),
        include_deleted: query.deleted.is_some(),
        ..Default::default()
    };

    let mut author_login_name = None;
    if let Some(login_name) = query.author.as_deref().filter(|s| !s.is_empty()) {
        let user = find_user_by_login_name(tx, login_name)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("User @{}", login_name)))?;
        filter.author_id = Some(user.id);
        author_login_name = Some(user.login_name);
    }

    let mut community_slug = None;
    if let Some(slug) = query.community.as_deref().filter(|s| !s.is_empty()) {
        let community = find_community_by_slug(tx, slug)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Community @{}", slug)))?;
        filter.community_id = Some(community.id);
        community_slug = Some(community.slug);
    }

    Ok(ResolvedFilter {
        filter,
        author_login_name,
        community_slug,
    })
}

/// Shared renderer for the global list and its pre-filtered variants.
async fn render_posts(
    admin: AdminUser,
    state: &AppState,
    ftl_lang: String,
    query: AdminPostsQuery,
    resolved: ResolvedFilter,
    communities: Vec<AdminCommunity>,
    mut tx: Transaction<'_, Postgres>,
) -> Result<Html<String>, AppError> {
    let page = query.page.unwrap_or(1).max(1);
    let offset = (page - 1) * POSTS_PER_PAGE;

    let posts = find_all_posts(&mut tx, resolved.filter, POSTS_PER_PAGE, offset).await?;
    let total = count_all_posts(&mut tx, resolved.filter).await?;

    let common_ctx = CommonContext::build(&mut tx, Some(admin.0.id)).await?;
    tx.commit().await?;

    let total_pages = (total + POSTS_PER_PAGE - 1) / POSTS_PER_PAGE;

    let template = state.env.get_template("admin/posts.jinja")?;
    let rendered = template.render(context! {
        current_user => admin.0,
        posts => posts,
        communities => communities,
        total => total,
        page => page,
        total_pages => total_pages,
        filter_author => resolved.author_login_name,
        filter_community => resolved.community_slug,
        include_drafts => resolved.filter.include_drafts,
        include_deleted => resolved.filter.include_deleted,
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        ftl_lang,
    })?;

    Ok(Html(rendered))
}

/// GET /admin/posts — every post on the instance, across all users and
/// communities, with optional filters.
pub async fn admin_posts(
    admin: AdminUser,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Query(query): Query<AdminPostsQuery>,
) -> Result<Html<String>, AppError> {
    let mut tx = state.db_pool.begin().await?;
    let resolved = resolve_filter(&mut tx, &query).await?;
    let communities = find_all_communities(&mut tx).await?;
    render_posts(admin, &state, ftl_lang, query, resolved, communities, tx).await
}

/// GET /admin/users/:login_name/posts — the global list scoped to one author,
/// including their unpublished drafts.
pub async fn admin_user_posts(
    admin: AdminUser,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path(login_name): Path<String>,
    Query(query): Query<AdminPostsQuery>,
) -> Result<Html<String>, AppError> {
    let query = AdminPostsQuery {
        author: Some(login_name),
        // A per-author view that hid their drafts and removed posts would defeat
        // the point of opening it.
        drafts: query.drafts.or_else(|| Some("on".to_string())),
        deleted: query.deleted.or_else(|| Some("on".to_string())),
        ..query
    };

    let mut tx = state.db_pool.begin().await?;
    let resolved = resolve_filter(&mut tx, &query).await?;
    let communities = find_all_communities(&mut tx).await?;
    render_posts(admin, &state, ftl_lang, query, resolved, communities, tx).await
}

/// GET /admin/communities/:slug/posts — scoped to one community regardless of
/// its visibility or the admin's membership.
pub async fn admin_community_posts(
    admin: AdminUser,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(query): Query<AdminPostsQuery>,
) -> Result<Html<String>, AppError> {
    let query = AdminPostsQuery {
        community: Some(slug),
        drafts: query.drafts.or_else(|| Some("on".to_string())),
        deleted: query.deleted.or_else(|| Some("on".to_string())),
        ..query
    };

    let mut tx = state.db_pool.begin().await?;
    let resolved = resolve_filter(&mut tx, &query).await?;
    let communities = find_all_communities(&mut tx).await?;
    render_posts(admin, &state, ftl_lang, query, resolved, communities, tx).await
}

/// GET /admin/posts/:post_id — full detail for one post, soft-deleted included.
pub async fn admin_post_detail(
    admin: AdminUser,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Path(post_id): Path<Uuid>,
) -> Result<Html<String>, AppError> {
    let mut tx = state.db_pool.begin().await?;

    let post = find_post_by_id(&mut tx, post_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Post".to_string()))?;

    let common_ctx = CommonContext::build(&mut tx, Some(admin.0.id)).await?;
    tx.commit().await?;

    let template = state.env.get_template("admin/post_detail.jinja")?;
    let rendered = template.render(context! {
        current_user => admin.0,
        post => post,
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        r2_public_endpoint_url => state.config.r2_public_endpoint_url.clone(),
        ftl_lang,
    })?;

    Ok(Html(rendered))
}

#[derive(Debug, Deserialize)]
pub struct AdminUsersQuery {
    pub page: Option<i64>,
}

/// GET /admin/users — every account, deleted ones included.
pub async fn admin_users(
    admin: AdminUser,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
    Query(query): Query<AdminUsersQuery>,
) -> Result<Html<String>, AppError> {
    let page = query.page.unwrap_or(1).max(1);
    let offset = (page - 1) * USERS_PER_PAGE;

    let mut tx = state.db_pool.begin().await?;
    let users = find_all_users(&mut tx, USERS_PER_PAGE, offset).await?;
    let common_ctx = CommonContext::build(&mut tx, Some(admin.0.id)).await?;
    tx.commit().await?;

    let template = state.env.get_template("admin/users.jinja")?;
    let rendered = template.render(context! {
        current_user => admin.0,
        users => users,
        page => page,
        has_next => users_len_is_full(&users),
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        ftl_lang,
    })?;

    Ok(Html(rendered))
}

fn users_len_is_full<T>(users: &[T]) -> bool {
    users.len() as i64 == USERS_PER_PAGE
}

/// GET /admin/communities — every community, private and unlisted included.
pub async fn admin_communities(
    admin: AdminUser,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
) -> Result<Html<String>, AppError> {
    let mut tx = state.db_pool.begin().await?;
    let communities = find_all_communities(&mut tx).await?;
    let common_ctx = CommonContext::build(&mut tx, Some(admin.0.id)).await?;
    tx.commit().await?;

    let template = state.env.get_template("admin/communities.jinja")?;
    let rendered = template.render(context! {
        current_user => admin.0,
        communities => communities,
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        ftl_lang,
    })?;

    Ok(Html(rendered))
}

#[cfg(test)]
mod tests {
    //! `cargo check` validates the handlers but not the Jinja, so render every
    //! admin template against representative context. Catches syntax errors,
    //! broken inheritance and unknown filters.

    use minijinja::{context, path_loader, Environment, State};
    use serde_json::json;
    use std::path::PathBuf;

    fn test_env() -> Environment<'static> {
        let mut env = Environment::new();
        minijinja_contrib::add_to_environment(&mut env);
        env.add_filter("cachebuster", |value: String| value);
        env.add_filter("markdown", |value: String| value);
        env.add_function("ftl_get_message", |_state: &State, id: String| id);
        env.add_global("r2_public_endpoint_url", "https://example.test");
        env.set_loader(path_loader(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("templates"),
        ));
        env
    }

    fn sample_post() -> serde_json::Value {
        json!({
            "id": "00000000-0000-0000-0000-000000000001",
            "title": "A drawing",
            "is_sensitive": false,
            "viewer_count": 12,
            "author_id": "00000000-0000-0000-0000-000000000002",
            "author_login_name": "someone",
            "author_display_name": "Some One",
            "community_id": "00000000-0000-0000-0000-000000000003",
            "community_slug": "secret",
            "community_name": "Secret Club",
            "community_visibility": "private",
            "image_filename": "abcdef.png",
            "image_width": 300,
            "image_height": 300,
            "published_at": "2026-01-02T03:04:05Z",
            "created_at": "2026-01-01T03:04:05Z",
            "deleted_at": "2026-02-01T03:04:05Z",
            "deletion_reason": "Moderation",
        })
    }

    fn sample_communities() -> serde_json::Value {
        json!([{
            "id": "00000000-0000-0000-0000-000000000003",
            "slug": "secret",
            "name": "Secret Club",
            "visibility": "private",
            "deleted_at": null,
        }])
    }

    fn current_user() -> serde_json::Value {
        json!({
            "id": "00000000-0000-0000-0000-000000000009",
            "login_name": "admin",
            "display_name": "Admin",
            "email_verified_at": "2026-01-01T00:00:00Z",
            "role": "admin",
        })
    }

    #[test]
    fn renders_posts_list() {
        let env = test_env();
        let template = env.get_template("admin/posts.jinja").expect("template loads");
        template
            .render(context! {
                current_user => current_user(),
                posts => vec![sample_post()],
                communities => sample_communities(),
                total => 1,
                page => 1,
                total_pages => 1,
                filter_author => "someone",
                filter_community => "secret",
                include_drafts => true,
                include_deleted => true,
                draft_post_count => 0,
                unread_notification_count => 0,
                ftl_lang => "en",
            })
            .expect("posts.jinja renders");
    }

    #[test]
    fn renders_posts_list_when_empty() {
        let env = test_env();
        let template = env.get_template("admin/posts.jinja").expect("template loads");
        let rendered = template
            .render(context! {
                current_user => current_user(),
                posts => Vec::<serde_json::Value>::new(),
                communities => sample_communities(),
                total => 0,
                page => 1,
                total_pages => 0,
                filter_author => None::<String>,
                filter_community => None::<String>,
                include_drafts => false,
                include_deleted => false,
                draft_post_count => 0,
                unread_notification_count => 0,
                ftl_lang => "en",
            })
            .expect("posts.jinja renders with no results");
        assert!(rendered.contains("No posts match this filter."));
    }

    #[test]
    fn renders_post_detail() {
        let env = test_env();
        let template = env
            .get_template("admin/post_detail.jinja")
            .expect("template loads");
        template
            .render(context! {
                current_user => current_user(),
                post => sample_post(),
                draft_post_count => 0,
                unread_notification_count => 0,
                ftl_lang => "en",
            })
            .expect("post_detail.jinja renders");
    }

    #[test]
    fn renders_users_list() {
        let env = test_env();
        let template = env.get_template("admin/users.jinja").expect("template loads");
        template
            .render(context! {
                current_user => current_user(),
                users => json!([{
                    "id": "00000000-0000-0000-0000-000000000002",
                    "login_name": "someone",
                    "display_name": "Some One",
                    "role": "user",
                    "post_count": 4,
                    "created_at": "2026-01-01T00:00:00Z",
                    "deleted_at": null,
                }]),
                page => 1,
                has_next => false,
                draft_post_count => 0,
                unread_notification_count => 0,
                ftl_lang => "en",
            })
            .expect("users.jinja renders");
    }

    #[test]
    fn renders_communities_list() {
        let env = test_env();
        let template = env
            .get_template("admin/communities.jinja")
            .expect("template loads");
        template
            .render(context! {
                current_user => current_user(),
                communities => sample_communities(),
                draft_post_count => 0,
                unread_notification_count => 0,
                ftl_lang => "en",
            })
            .expect("communities.jinja renders");
    }
}
