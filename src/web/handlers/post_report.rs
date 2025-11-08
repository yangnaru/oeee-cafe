use crate::app_error::AppError;
use crate::models::community::get_user_role_in_community;
use crate::models::post::find_post_by_id;
use crate::models::post_report::{
    check_existing_report, create_report, get_all_reports, get_reports_for_community,
    update_report_status, PostReportDraft, PostReportReason, PostReportStatus,
    SerializablePostReport,
};
use crate::models::user::AuthSession;
use crate::web::state::AppState;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct CreateReportRequest {
    pub reason: PostReportReason,
    pub details: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CreateReportResponse {
    pub id: Uuid,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

#[derive(Debug, Deserialize)]
pub struct ReportsQueryParams {
    pub status: Option<PostReportStatus>,
}

#[derive(Debug, Serialize)]
pub struct ReportsListResponse {
    pub reports: Vec<SerializablePostReport>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateReportRequest {
    pub status: PostReportStatus,
}

#[derive(Debug, Serialize)]
pub struct UpdateReportResponse {
    pub id: Uuid,
    pub status: PostReportStatus,
    pub message: String,
}

/// Create a report for a post
pub async fn create_post_report(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(post_id): Path<Uuid>,
    Json(payload): Json<CreateReportRequest>,
) -> Result<impl IntoResponse, AppError> {
    let user = match &auth_session.user {
        Some(user) => user,
        None => {
            return Ok((
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    error: "Authentication required".to_string(),
                }),
            )
                .into_response());
        }
    };

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Check if the post exists
    let post = find_post_by_id(&mut tx, post_id).await?;
    if post.is_none() {
        return Ok((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Post not found".to_string(),
            }),
        )
            .into_response());
    }

    // Check if user has already reported this post
    let existing_report = check_existing_report(&mut tx, post_id, user.id).await?;
    if existing_report.is_some() {
        return Ok((
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                error: "You have already reported this post".to_string(),
            }),
        )
            .into_response());
    }

    // Create the report
    let draft = PostReportDraft {
        post_id,
        reporter_id: user.id,
        reason: payload.reason,
        details: payload.details,
    };

    let report = create_report(&mut tx, draft).await?;

    tx.commit().await?;

    Ok((
        StatusCode::CREATED,
        Json(CreateReportResponse {
            id: report.id,
            message: "Report submitted successfully".to_string(),
        }),
    )
        .into_response())
}

/// Get reports for a community (moderators and owners only)
pub async fn get_community_reports(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(community_id): Path<Uuid>,
    Query(params): Query<ReportsQueryParams>,
) -> Result<impl IntoResponse, AppError> {
    let user = match &auth_session.user {
        Some(user) => user,
        None => {
            return Ok((
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    error: "Authentication required".to_string(),
                }),
            )
                .into_response());
        }
    };

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Check if user is a moderator or owner of the community
    let user_role = get_user_role_in_community(&mut tx, community_id, user.id).await?;
    if user_role.is_none() {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "You are not authorized to view reports for this community".to_string(),
            }),
        )
            .into_response());
    }

    let role = user_role.unwrap();
    use crate::models::community::CommunityMemberRole;
    if role != CommunityMemberRole::Owner && role != CommunityMemberRole::Moderator {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "Only moderators and owners can view reports".to_string(),
            }),
        )
            .into_response());
    }

    // Fetch reports
    let reports = get_reports_for_community(&mut tx, community_id, params.status).await?;

    tx.commit().await?;

    Ok((StatusCode::OK, Json(ReportsListResponse { reports })).into_response())
}

/// Get all reports (site-wide admin view)
pub async fn get_all_reports_handler(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Query(params): Query<ReportsQueryParams>,
) -> Result<impl IntoResponse, AppError> {
    let _user = match &auth_session.user {
        Some(user) => user,
        None => {
            return Ok((
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    error: "Authentication required".to_string(),
                }),
            )
                .into_response());
        }
    };

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // For now, we'll allow any logged-in user to access this
    // In the future, you may want to add a site-wide admin role check
    // TODO: Add proper admin role check

    // Fetch all reports
    let reports = get_all_reports(&mut tx, params.status).await?;

    tx.commit().await?;

    Ok((StatusCode::OK, Json(ReportsListResponse { reports })).into_response())
}

/// Update report status (moderators and owners only)
pub async fn update_report_status_handler(
    auth_session: AuthSession,
    State(state): State<AppState>,
    Path(report_id): Path<Uuid>,
    Json(payload): Json<UpdateReportRequest>,
) -> Result<impl IntoResponse, AppError> {
    let user = match &auth_session.user {
        Some(user) => user,
        None => {
            return Ok((
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    error: "Authentication required".to_string(),
                }),
            )
                .into_response());
        }
    };

    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    // Get the report to find the community
    let report = crate::models::post_report::get_report_by_id(&mut tx, report_id).await?;
    if report.is_none() {
        return Ok((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Report not found".to_string(),
            }),
        )
            .into_response());
    }

    let report = report.unwrap();

    // Get the post to find the community
    let post = find_post_by_id(&mut tx, report.post_id).await?;
    if post.is_none() {
        return Ok((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Post not found".to_string(),
            }),
        )
            .into_response());
    }
    let post = post.unwrap();

    // Check if user is a moderator or owner of the community
    if let Some(community_id_str) = post.get("community_id").and_then(|v| v.as_ref()) {
        let community_id = match Uuid::parse_str(community_id_str) {
            Ok(id) => id,
            Err(_) => {
                return Ok((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: "Invalid community ID".to_string(),
                    }),
                )
                    .into_response());
            }
        };
        let user_role = get_user_role_in_community(&mut tx, community_id, user.id).await?;
        if user_role.is_none() {
            return Ok((
                StatusCode::FORBIDDEN,
                Json(ErrorResponse {
                    error: "You are not authorized to update this report".to_string(),
                }),
            )
                .into_response());
        }

        let role = user_role.unwrap();
        use crate::models::community::CommunityMemberRole;
        if role != CommunityMemberRole::Owner && role != CommunityMemberRole::Moderator {
            return Ok((
                StatusCode::FORBIDDEN,
                Json(ErrorResponse {
                    error: "Only moderators and owners can update reports".to_string(),
                }),
            )
                .into_response());
        }
    } else {
        // Post doesn't belong to a community - for now, allow any logged-in user
        // TODO: Add proper site-wide admin check
    }

    // Update the report status
    let updated_report = update_report_status(&mut tx, report_id, payload.status, user.id).await?;

    tx.commit().await?;

    Ok((
        StatusCode::OK,
        Json(UpdateReportResponse {
            id: updated_report.id,
            status: updated_report.status,
            message: "Report status updated successfully".to_string(),
        }),
    )
        .into_response())
}
