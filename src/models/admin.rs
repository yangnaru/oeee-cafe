//! Post queries with **no visibility filtering at all**.
//!
//! Every query here deliberately omits the `communities.visibility = 'public'`
//! / `community_members` predicates and the `deleted_at IS NULL` guard that the
//! rest of `models` applies. They exist so admins can review private-community
//! posts, unpublished drafts and soft-deleted content.
//!
//! Keeping them in one module is the security boundary: nothing here may be
//! called from a handler that does not take the `AdminUser` extractor. Do not
//! add a `viewer_id` parameter to these — if a caller needs visibility rules,
//! it belongs in `models::post` instead.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{query, query_as, Postgres, Transaction};
use uuid::Uuid;

use crate::models::community::CommunityVisibility;
use crate::models::post::PostDeletionReason;
use crate::models::user::UserRole;

/// A post row as the admin views render it: author and community are joined in
/// so the global list needs no N+1 lookups.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AdminPost {
    pub id: Uuid,
    pub title: Option<String>,
    pub is_sensitive: bool,
    pub viewer_count: i32,
    pub author_id: Uuid,
    pub author_login_name: String,
    pub author_display_name: String,
    pub community_id: Option<Uuid>,
    pub community_slug: Option<String>,
    pub community_name: Option<String>,
    pub community_visibility: Option<CommunityVisibility>,
    pub image_filename: String,
    pub image_width: i32,
    pub image_height: i32,
    pub published_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub deletion_reason: Option<PostDeletionReason>,
}

impl AdminPost {
    /// Drafts have never been published, so nobody but the author has seen them.
    pub fn is_draft(&self) -> bool {
        self.published_at.is_none()
    }

    pub fn is_deleted(&self) -> bool {
        self.deleted_at.is_some()
    }
}

/// Which slice of the firehose to show. `None` on the id fields means "any";
/// the booleans default to excluding drafts and deleted posts so the global
/// list opens on live content.
#[derive(Clone, Copy, Debug, Default)]
pub struct AdminPostFilter {
    pub author_id: Option<Uuid>,
    pub community_id: Option<Uuid>,
    pub include_drafts: bool,
    pub include_deleted: bool,
}

/// Every post on the instance, newest first, regardless of community
/// visibility, membership, publication state or soft deletion.
///
/// Ordered by `COALESCE(published_at, created_at)` so drafts interleave by the
/// time they were drawn rather than sinking to the bottom on a NULL sort key.
pub async fn find_all_posts(
    tx: &mut Transaction<'_, Postgres>,
    filter: AdminPostFilter,
    limit: i64,
    offset: i64,
) -> Result<Vec<AdminPost>> {
    let rows = query_as!(
        AdminPost,
        r#"
        SELECT
            posts.id,
            posts.title,
            posts.is_sensitive,
            posts.viewer_count,
            posts.author_id,
            users.login_name AS author_login_name,
            users.display_name AS author_display_name,
            posts.community_id,
            communities.slug AS "community_slug?",
            communities.name AS "community_name?",
            communities.visibility AS "community_visibility?: CommunityVisibility",
            images.image_filename,
            images.width AS image_width,
            images.height AS image_height,
            posts.published_at,
            posts.created_at,
            posts.deleted_at,
            posts.deletion_reason AS "deletion_reason?: PostDeletionReason"
        FROM posts
        JOIN users ON posts.author_id = users.id
        JOIN images ON posts.image_id = images.id
        LEFT JOIN communities ON posts.community_id = communities.id
        WHERE ($1::uuid IS NULL OR posts.author_id = $1)
          AND ($2::uuid IS NULL OR posts.community_id = $2)
          AND ($3 OR posts.published_at IS NOT NULL)
          AND ($4 OR posts.deleted_at IS NULL)
        ORDER BY COALESCE(posts.published_at, posts.created_at) DESC
        LIMIT $5 OFFSET $6
        "#,
        filter.author_id,
        filter.community_id,
        filter.include_drafts,
        filter.include_deleted,
        limit,
        offset,
    );
    Ok(rows.fetch_all(&mut **tx).await?)
}

/// Total matching `filter`, for pagination. Mirrors `find_all_posts`' WHERE
/// clause exactly — change both together.
pub async fn count_all_posts(
    tx: &mut Transaction<'_, Postgres>,
    filter: AdminPostFilter,
) -> Result<i64> {
    let row = query!(
        r#"
        SELECT COUNT(*) AS "count!"
        FROM posts
        WHERE ($1::uuid IS NULL OR posts.author_id = $1)
          AND ($2::uuid IS NULL OR posts.community_id = $2)
          AND ($3 OR posts.published_at IS NOT NULL)
          AND ($4 OR posts.deleted_at IS NULL)
        "#,
        filter.author_id,
        filter.community_id,
        filter.include_drafts,
        filter.include_deleted,
    )
    .fetch_one(&mut **tx)
    .await?;
    Ok(row.count)
}

/// A single post, including soft-deleted ones. `models::post::find_post_by_id`
/// hides those, which is exactly what moderation review needs to see.
pub async fn find_post_by_id(
    tx: &mut Transaction<'_, Postgres>,
    post_id: Uuid,
) -> Result<Option<AdminPost>> {
    let row = query_as!(
        AdminPost,
        r#"
        SELECT
            posts.id,
            posts.title,
            posts.is_sensitive,
            posts.viewer_count,
            posts.author_id,
            users.login_name AS author_login_name,
            users.display_name AS author_display_name,
            posts.community_id,
            communities.slug AS "community_slug?",
            communities.name AS "community_name?",
            communities.visibility AS "community_visibility?: CommunityVisibility",
            images.image_filename,
            images.width AS image_width,
            images.height AS image_height,
            posts.published_at,
            posts.created_at,
            posts.deleted_at,
            posts.deletion_reason AS "deletion_reason?: PostDeletionReason"
        FROM posts
        JOIN users ON posts.author_id = users.id
        JOIN images ON posts.image_id = images.id
        LEFT JOIN communities ON posts.community_id = communities.id
        WHERE posts.id = $1
        "#,
        post_id,
    );
    Ok(row.fetch_optional(&mut **tx).await?)
}

/// Community summary for the filter dropdown and the per-community header.
/// Includes private and unlisted communities.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AdminCommunity {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub visibility: CommunityVisibility,
    pub deleted_at: Option<DateTime<Utc>>,
}

pub async fn find_all_communities(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<Vec<AdminCommunity>> {
    let rows = query_as!(
        AdminCommunity,
        r#"
        SELECT
            id,
            slug,
            name,
            visibility AS "visibility: CommunityVisibility",
            deleted_at
        FROM communities
        ORDER BY name ASC
        "#,
    );
    Ok(rows.fetch_all(&mut **tx).await?)
}

pub async fn find_community_by_slug(
    tx: &mut Transaction<'_, Postgres>,
    slug: &str,
) -> Result<Option<AdminCommunity>> {
    let row = query_as!(
        AdminCommunity,
        r#"
        SELECT
            id,
            slug,
            name,
            visibility AS "visibility: CommunityVisibility",
            deleted_at
        FROM communities
        WHERE slug = $1
        "#,
        slug,
    );
    Ok(row.fetch_optional(&mut **tx).await?)
}

/// User summary for the admin user list, including deleted accounts.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AdminUserSummary {
    pub id: Uuid,
    pub login_name: String,
    pub display_name: String,
    pub role: UserRole,
    pub post_count: i64,
    pub created_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

pub async fn find_all_users(
    tx: &mut Transaction<'_, Postgres>,
    limit: i64,
    offset: i64,
) -> Result<Vec<AdminUserSummary>> {
    let rows = query_as!(
        AdminUserSummary,
        r#"
        SELECT
            users.id,
            users.login_name,
            users.display_name,
            users.role AS "role: UserRole",
            users.created_at,
            users.deleted_at,
            COUNT(posts.id) AS "post_count!"
        FROM users
        LEFT JOIN posts ON posts.author_id = users.id AND posts.deleted_at IS NULL
        GROUP BY users.id
        ORDER BY users.created_at DESC
        LIMIT $1 OFFSET $2
        "#,
        limit,
        offset,
    );
    Ok(rows.fetch_all(&mut **tx).await?)
}
