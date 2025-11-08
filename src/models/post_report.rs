use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction, Type};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Type, Serialize, Deserialize)]
#[sqlx(type_name = "post_report_reason", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum PostReportReason {
    Spam,
    Harassment,
    InappropriateContent,
    CopyrightViolation,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Type, Serialize, Deserialize)]
#[sqlx(type_name = "post_report_status", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum PostReportStatus {
    Pending,
    Reviewed,
    Actioned,
    Dismissed,
}

#[derive(Clone, Debug, Serialize)]
pub struct PostReport {
    pub id: Uuid,
    pub post_id: Uuid,
    pub reporter_id: Uuid,
    pub reason: PostReportReason,
    pub details: Option<String>,
    pub status: PostReportStatus,
    pub reviewed_by: Option<Uuid>,
    pub reviewed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PostReportDraft {
    pub post_id: Uuid,
    pub reporter_id: Uuid,
    pub reason: PostReportReason,
    pub details: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SerializablePostReport {
    pub id: Uuid,
    pub post_id: Uuid,
    pub post_title: Option<String>,
    pub post_author_login_name: String,
    pub reporter_id: Uuid,
    pub reporter_login_name: String,
    pub reason: PostReportReason,
    pub details: Option<String>,
    pub status: PostReportStatus,
    pub reviewed_by: Option<Uuid>,
    pub reviewed_by_login_name: Option<String>,
    pub reviewed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

pub async fn create_report(
    tx: &mut Transaction<'_, Postgres>,
    draft: PostReportDraft,
) -> Result<PostReport> {
    let report = sqlx::query_as!(
        PostReport,
        r#"
        INSERT INTO post_reports (post_id, reporter_id, reason, details)
        VALUES ($1, $2, $3, $4)
        RETURNING
            id,
            post_id,
            reporter_id,
            reason as "reason: _",
            details,
            status as "status: _",
            reviewed_by,
            reviewed_at,
            created_at
        "#,
        draft.post_id,
        draft.reporter_id,
        draft.reason as PostReportReason,
        draft.details
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(report)
}

pub async fn get_reports_for_community(
    tx: &mut Transaction<'_, Postgres>,
    community_id: Uuid,
    status_filter: Option<PostReportStatus>,
) -> Result<Vec<SerializablePostReport>> {
    let reports = if let Some(status) = status_filter {
        sqlx::query!(
            r#"
            SELECT
                pr.id,
                pr.post_id,
                p.title as post_title,
                post_author.login_name as post_author_login_name,
                pr.reporter_id,
                reporter.login_name as reporter_login_name,
                pr.reason as "reason: PostReportReason",
                pr.details,
                pr.status as "status: PostReportStatus",
                pr.reviewed_by,
                reviewer.login_name as reviewed_by_login_name,
                pr.reviewed_at,
                pr.created_at
            FROM post_reports pr
            JOIN posts p ON pr.post_id = p.id
            JOIN users reporter ON pr.reporter_id = reporter.id
            JOIN users post_author ON p.author_id = post_author.id
            LEFT JOIN users reviewer ON pr.reviewed_by = reviewer.id
            WHERE p.community_id = $1 AND pr.status = $2
            ORDER BY pr.created_at DESC
            "#,
            community_id,
            status as PostReportStatus
        )
        .fetch_all(&mut **tx)
        .await?
    } else {
        sqlx::query!(
            r#"
            SELECT
                pr.id,
                pr.post_id,
                p.title as post_title,
                post_author.login_name as post_author_login_name,
                pr.reporter_id,
                reporter.login_name as reporter_login_name,
                pr.reason as "reason: PostReportReason",
                pr.details,
                pr.status as "status: PostReportStatus",
                pr.reviewed_by,
                reviewer.login_name as reviewed_by_login_name,
                pr.reviewed_at,
                pr.created_at
            FROM post_reports pr
            JOIN posts p ON pr.post_id = p.id
            JOIN users reporter ON pr.reporter_id = reporter.id
            JOIN users post_author ON p.author_id = post_author.id
            LEFT JOIN users reviewer ON pr.reviewed_by = reviewer.id
            WHERE p.community_id = $1
            ORDER BY pr.created_at DESC
            "#,
            community_id
        )
        .fetch_all(&mut **tx)
        .await?
    };

    Ok(reports
        .into_iter()
        .map(|r| SerializablePostReport {
            id: r.id,
            post_id: r.post_id,
            post_title: r.post_title,
            post_author_login_name: r.post_author_login_name,
            reporter_id: r.reporter_id,
            reporter_login_name: r.reporter_login_name,
            reason: r.reason,
            details: r.details,
            status: r.status,
            reviewed_by: r.reviewed_by,
            reviewed_by_login_name: r.reviewed_by_login_name,
            reviewed_at: r.reviewed_at,
            created_at: r.created_at,
        })
        .collect())
}

pub async fn get_all_reports(
    tx: &mut Transaction<'_, Postgres>,
    status_filter: Option<PostReportStatus>,
) -> Result<Vec<SerializablePostReport>> {
    let reports = if let Some(status) = status_filter {
        sqlx::query!(
            r#"
            SELECT
                pr.id,
                pr.post_id,
                p.title as post_title,
                post_author.login_name as post_author_login_name,
                pr.reporter_id,
                reporter.login_name as reporter_login_name,
                pr.reason as "reason: PostReportReason",
                pr.details,
                pr.status as "status: PostReportStatus",
                pr.reviewed_by,
                reviewer.login_name as reviewed_by_login_name,
                pr.reviewed_at,
                pr.created_at
            FROM post_reports pr
            JOIN posts p ON pr.post_id = p.id
            JOIN users reporter ON pr.reporter_id = reporter.id
            JOIN users post_author ON p.author_id = post_author.id
            LEFT JOIN users reviewer ON pr.reviewed_by = reviewer.id
            WHERE pr.status = $1
            ORDER BY pr.created_at DESC
            "#,
            status as PostReportStatus
        )
        .fetch_all(&mut **tx)
        .await?
    } else {
        sqlx::query!(
            r#"
            SELECT
                pr.id,
                pr.post_id,
                p.title as post_title,
                post_author.login_name as post_author_login_name,
                pr.reporter_id,
                reporter.login_name as reporter_login_name,
                pr.reason as "reason: PostReportReason",
                pr.details,
                pr.status as "status: PostReportStatus",
                pr.reviewed_by,
                reviewer.login_name as reviewed_by_login_name,
                pr.reviewed_at,
                pr.created_at
            FROM post_reports pr
            JOIN posts p ON pr.post_id = p.id
            JOIN users reporter ON pr.reporter_id = reporter.id
            JOIN users post_author ON p.author_id = post_author.id
            LEFT JOIN users reviewer ON pr.reviewed_by = reviewer.id
            ORDER BY pr.created_at DESC
            "#
        )
        .fetch_all(&mut **tx)
        .await?
    };

    Ok(reports
        .into_iter()
        .map(|r| SerializablePostReport {
            id: r.id,
            post_id: r.post_id,
            post_title: r.post_title,
            post_author_login_name: r.post_author_login_name,
            reporter_id: r.reporter_id,
            reporter_login_name: r.reporter_login_name,
            reason: r.reason,
            details: r.details,
            status: r.status,
            reviewed_by: r.reviewed_by,
            reviewed_by_login_name: r.reviewed_by_login_name,
            reviewed_at: r.reviewed_at,
            created_at: r.created_at,
        })
        .collect())
}

pub async fn update_report_status(
    tx: &mut Transaction<'_, Postgres>,
    report_id: Uuid,
    status: PostReportStatus,
    reviewed_by: Uuid,
) -> Result<PostReport> {
    let report = sqlx::query_as!(
        PostReport,
        r#"
        UPDATE post_reports
        SET status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP
        WHERE id = $3
        RETURNING
            id,
            post_id,
            reporter_id,
            reason as "reason: _",
            details,
            status as "status: _",
            reviewed_by,
            reviewed_at,
            created_at
        "#,
        status as PostReportStatus,
        reviewed_by,
        report_id
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(report)
}

pub async fn get_report_by_id(
    tx: &mut Transaction<'_, Postgres>,
    report_id: Uuid,
) -> Result<Option<PostReport>> {
    let report = sqlx::query_as!(
        PostReport,
        r#"
        SELECT
            id,
            post_id,
            reporter_id,
            reason as "reason: _",
            details,
            status as "status: _",
            reviewed_by,
            reviewed_at,
            created_at
        FROM post_reports
        WHERE id = $1
        "#,
        report_id
    )
    .fetch_optional(&mut **tx)
    .await?;

    Ok(report)
}

pub async fn check_existing_report(
    tx: &mut Transaction<'_, Postgres>,
    post_id: Uuid,
    reporter_id: Uuid,
) -> Result<Option<PostReport>> {
    let report = sqlx::query_as!(
        PostReport,
        r#"
        SELECT
            id,
            post_id,
            reporter_id,
            reason as "reason: _",
            details,
            status as "status: _",
            reviewed_by,
            reviewed_at,
            created_at
        FROM post_reports
        WHERE post_id = $1 AND reporter_id = $2
        "#,
        post_id,
        reporter_id
    )
    .fetch_optional(&mut **tx)
    .await?;

    Ok(report)
}
