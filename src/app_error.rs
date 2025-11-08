use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Response;
use std::fmt;

// Application-specific errors with better context
#[derive(Debug)]
pub enum AppError {
    // Wrap anyhow errors for backward compatibility
    Anyhow(anyhow::Error),

    // Specific error types for better handling
    LocalizationError(String),
    InvalidFormData(String),
    InvalidHash(String),
    InvalidEmail(String),
    InvalidUuid(String),
    InvalidCommunityId(String),
    Unauthorized,
    NotFound(String),
    DatabaseError(String),
}

// Tell axum how to convert `AppError` into a response.
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message, sentry_level) = match &self {
            AppError::Anyhow(err) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Something went wrong: {}", err),
                sentry::Level::Error,
            ),
            AppError::LocalizationError(key) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Missing translation key: {}", key),
                sentry::Level::Warning,
            ),
            AppError::InvalidFormData(msg) => (
                StatusCode::BAD_REQUEST,
                format!("Invalid form data: {}", msg),
                sentry::Level::Info,
            ),
            AppError::InvalidHash(msg) => (
                StatusCode::BAD_REQUEST,
                format!("Invalid hash: {}", msg),
                sentry::Level::Info,
            ),
            AppError::InvalidEmail(msg) => (
                StatusCode::BAD_REQUEST,
                format!("Invalid email: {}", msg),
                sentry::Level::Info,
            ),
            AppError::InvalidUuid(msg) => (
                StatusCode::BAD_REQUEST,
                format!("Invalid UUID: {}", msg),
                sentry::Level::Info,
            ),
            AppError::InvalidCommunityId(msg) => (
                StatusCode::BAD_REQUEST,
                format!("Invalid community ID: {}", msg),
                sentry::Level::Info,
            ),
            AppError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "Unauthorized".to_string(),
                sentry::Level::Info,
            ),
            AppError::NotFound(resource) => (
                StatusCode::NOT_FOUND,
                format!("{} not found", resource),
                sentry::Level::Info,
            ),
            AppError::DatabaseError(msg) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Database error: {}", msg),
                sentry::Level::Error,
            ),
        };

        // Log all errors to Sentry
        sentry::capture_message(&message, sentry_level);

        (status, message).into_response()
    }
}

// Implement Display for AppError
impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Anyhow(err) => write!(f, "{}", err),
            AppError::LocalizationError(key) => write!(f, "Missing translation key: {}", key),
            AppError::InvalidFormData(msg) => write!(f, "Invalid form data: {}", msg),
            AppError::InvalidHash(msg) => write!(f, "Invalid hash: {}", msg),
            AppError::InvalidEmail(msg) => write!(f, "Invalid email: {}", msg),
            AppError::InvalidUuid(msg) => write!(f, "Invalid UUID: {}", msg),
            AppError::InvalidCommunityId(msg) => write!(f, "Invalid community ID: {}", msg),
            AppError::Unauthorized => write!(f, "Unauthorized"),
            AppError::NotFound(resource) => write!(f, "{} not found", resource),
            AppError::DatabaseError(msg) => write!(f, "Database error: {}", msg),
        }
    }
}

// This enables using `?` on functions that return `Result<_, anyhow::Error>` to turn them into
// `Result<_, AppError>`. That way you don't need to do that manually.
impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(err: E) -> Self {
        AppError::Anyhow(err.into())
    }
}
