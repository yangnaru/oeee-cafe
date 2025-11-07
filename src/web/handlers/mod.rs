use crate::app_error::AppError;
use crate::locale::LOCALES;
use crate::models::user::{AuthSession, Language};
use crate::web::context::CommonContext;
use anyhow;
use anyhow::Result;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse};
use axum::{
    async_trait,
    extract::FromRequestParts,
    http::{
        header::{HeaderValue, ACCEPT_LANGUAGE},
        request::Parts,
    },
};
use data_encoding::BASE64URL_NOPAD;
use uuid::Uuid;

use fluent::bundle::FluentBundle;
use fluent::FluentResource;
use fluent_langneg::convert_vec_str_to_langids_lossy;
use fluent_langneg::negotiate_languages;
use fluent_langneg::parse_accepted_languages;
use fluent_langneg::NegotiationStrategy;
use intl_memoizer::concurrent::IntlLangMemoizer;
use minijinja::context;

use super::state::AppState;

pub mod about;
pub mod account;
pub mod activitypub;
pub mod auth;
pub mod collaborate;
pub mod collaborate_cleanup;
pub mod community;
pub mod draw;
pub mod hashtag;
pub mod home;
pub mod notifications;
pub mod post;
pub mod privacy;
pub mod profile;
pub mod push_tokens;
pub mod search;
pub mod well_known;

pub async fn handler_404(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let common_ctx =
        CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("404.jinja")?;
    let rendered: String = template.render(context! {
        current_user => auth_session.user,
        default_community_id => state.config.default_community_id.clone(),
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        ftl_lang
    })?;

    Ok(Html(rendered).into_response())
}

pub struct ExtractAcceptLanguage(HeaderValue);

#[async_trait]
impl<S> FromRequestParts<S> for ExtractAcceptLanguage
where
    S: Send + Sync,
{
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        if let Some(accept_language) = parts.headers.get(ACCEPT_LANGUAGE) {
            Ok(ExtractAcceptLanguage(accept_language.clone()))
        } else {
            Ok(ExtractAcceptLanguage(HeaderValue::from_static("")))
        }
    }
}

/// Extractor that provides the computed locale string for templates
pub struct ExtractFtlLang(pub String);

#[async_trait]
impl<S> FromRequestParts<S> for ExtractFtlLang
where
    S: Send + Sync,
{
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        // Extract Accept-Language header
        let accept_language = if let Some(accept_language) = parts.headers.get(ACCEPT_LANGUAGE) {
            accept_language.clone()
        } else {
            HeaderValue::from_static("")
        };

        // Extract AuthSession to get user preferences
        let auth_session = AuthSession::from_request_parts(parts, state)
            .await
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to extract auth session",
                )
            })?;

        // Get user's preferred language
        let user_preferred_language = auth_session
            .user
            .as_ref()
            .and_then(|u| u.preferred_language.clone());

        // Get the bundle and extract locale
        let bundle = get_bundle(&accept_language, user_preferred_language);
        let ftl_lang = bundle.locales.first().unwrap().to_string();

        Ok(ExtractFtlLang(ftl_lang))
    }
}

fn get_bundle(
    accept_language: &HeaderValue,
    user_preferred_language: Option<Language>,
) -> FluentBundle<&FluentResource, IntlLangMemoizer> {
    match user_preferred_language {
        Some(lang) => {
            let language = match lang {
                Language::Ko => "ko",
                Language::Ja => "ja",
                Language::En => "en",
                Language::Zh => "zh",
            };
            let ftl = LOCALES
                .get(language)
                .unwrap_or_else(|| LOCALES.get("en").unwrap());

            let mut bundle = FluentBundle::new_concurrent(vec![language.parse().unwrap()]);
            bundle.add_resource(ftl).expect("Failed to add a resource.");

            bundle
        }
        None => {
            let requested = parse_accepted_languages(accept_language.to_str().unwrap());
            let available = convert_vec_str_to_langids_lossy(["ko", "ja", "en"]);
            let default = "en".parse().expect("Failed to parse a langid.");

            let supported = negotiate_languages(
                &requested,
                &available,
                Some(&default),
                NegotiationStrategy::Filtering,
            );

            let ftl = LOCALES
                .get(supported.first().unwrap().language.as_str())
                .unwrap_or_else(|| LOCALES.get("en").unwrap());

            let mut bundle = FluentBundle::new_concurrent(vec![supported
                .first()
                .unwrap()
                .language
                .as_str()
                .parse()
                .unwrap()]);
            bundle.add_resource(ftl).expect("Failed to add a resource.");

            bundle
        }
    }
}

/// Parse ID from URL path, supporting both UUID format and legacy base64 format.
/// Returns either the parsed UUID, a redirect response for legacy URLs, or an error response.
pub enum ParsedId {
    Uuid(Uuid),
    Redirect(axum::response::Redirect),
    InvalidId(axum::response::Response),
}

pub fn parse_id_with_legacy_support(
    id_str: &str,
    base_path: &str,
    state: &crate::web::state::AppState,
) -> Result<ParsedId, AppError> {
    // First try to parse as UUID directly
    if let Ok(uuid) = Uuid::parse_str(id_str) {
        return Ok(ParsedId::Uuid(uuid));
    }

    // If that fails, try to decode as base64 and then parse as UUID
    match BASE64URL_NOPAD.decode(id_str.as_bytes()) {
        Ok(decoded_bytes) => {
            // Try to parse bytes directly as UUID (16 bytes expected)
            if decoded_bytes.len() == 16 {
                if let Ok(uuid) = Uuid::from_slice(&decoded_bytes) {
                    // Create redirect to UUID version
                    let redirect_url = format!("{}/{}", base_path, uuid);
                    return Ok(ParsedId::Redirect(axum::response::Redirect::permanent(
                        &redirect_url,
                    )));
                }
            }
        }
        Err(_) => {
            // Not valid base64, continue to error handling
        }
    }

    // If neither UUID nor base64 decoding worked, render custom error page
    match state.env.get_template("invalid_id_error.jinja") {
        Ok(template) => {
            match template.render(context! {}) {
                Ok(rendered) => {
                    let response = axum::response::Html(rendered).into_response();
                    return Ok(ParsedId::InvalidId(response));
                }
                Err(_) => {
                    // If template rendering fails, fall back to generic error
                }
            }
        }
        Err(_) => {
            // If template not found, fall back to generic error
        }
    }

    // Fallback to generic error if template rendering fails
    Err(AppError::from(anyhow::anyhow!("Invalid ID format")))
}
