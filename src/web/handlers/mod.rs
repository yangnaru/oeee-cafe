use axum::http::StatusCode;
use axum::response::IntoResponse;

pub mod about;
pub mod account;
pub mod auth;
pub mod community;
pub mod draw;
pub mod home;
pub mod post;
pub mod profile;

pub async fn handler_404() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, "nothing to see here")
}
