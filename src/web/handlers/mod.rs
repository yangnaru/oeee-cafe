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
pub mod password_reset;
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
        let ftl_lang = bundle.locales.first()
            .map(|l| l.to_string())
            .unwrap_or_else(|| "en".to_string());

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
                .or_else(|| LOCALES.get("en"))
                .expect("English locale must exist");

            let lang_id = language.parse().expect("Hardcoded language string should parse");
            let mut bundle = FluentBundle::new_concurrent(vec![lang_id]);
            bundle.add_resource(ftl).expect("Failed to add a resource.");

            bundle
        }
        None => {
            // Fallback to "en" if header is not valid UTF-8
            let header_str = accept_language.to_str().unwrap_or("en");
            let requested = parse_accepted_languages(header_str);
            let available = convert_vec_str_to_langids_lossy(["ko", "ja", "en"]);
            let default = "en".parse().expect("Failed to parse a langid.");

            let supported = negotiate_languages(
                &requested,
                &available,
                Some(&default),
                NegotiationStrategy::Filtering,
            );

            let lang_code = supported.first()
                .map(|l| l.language.as_str())
                .unwrap_or("en");

            let ftl = LOCALES
                .get(lang_code)
                .or_else(|| LOCALES.get("en"))
                .expect("English locale must exist");

            let lang_id = lang_code.parse().expect("Negotiated language should parse");
            let mut bundle = FluentBundle::new_concurrent(vec![lang_id]);
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

/// Helper function to safely get a Fluent message without panicking
/// Returns the translation key itself if the message is not found
pub fn safe_get_message(
    bundle: &FluentBundle<&FluentResource, IntlLangMemoizer>,
    key: &str,
) -> String {
    let message = match bundle.get_message(key) {
        Some(msg) => msg,
        None => {
            // Log missing translation key to Sentry
            sentry::capture_message(
                &format!("Missing translation key: {}", key),
                sentry::Level::Warning,
            );
            return key.to_string();
        }
    };

    let pattern = match message.value() {
        Some(p) => p,
        None => {
            // Log translation key with no value to Sentry
            sentry::capture_message(
                &format!("Translation key {} has no value", key),
                sentry::Level::Warning,
            );
            return key.to_string();
        }
    };

    let mut errors = vec![];
    let formatted = bundle.format_pattern(pattern, None, &mut errors);

    if !errors.is_empty() {
        // Log formatting errors to Sentry
        sentry::capture_message(
            &format!("Error formatting {}: {:?}", key, errors),
            sentry::Level::Warning,
        );
        return key.to_string();
    }

    formatted.to_string()
}

/// Helper function to safely format a Fluent message with arguments
/// Returns the translation key itself if the message is not found
pub fn safe_format_message(
    bundle: &FluentBundle<&FluentResource, IntlLangMemoizer>,
    key: &str,
    args: Option<&fluent::FluentArgs>,
) -> String {
    let message = match bundle.get_message(key) {
        Some(msg) => msg,
        None => {
            // Log missing translation key to Sentry
            sentry::capture_message(
                &format!("Missing translation key: {}", key),
                sentry::Level::Warning,
            );
            return key.to_string();
        }
    };

    let pattern = match message.value() {
        Some(p) => p,
        None => {
            // Log translation key with no value to Sentry
            sentry::capture_message(
                &format!("Translation key {} has no value", key),
                sentry::Level::Warning,
            );
            return key.to_string();
        }
    };

    let mut errors = vec![];
    let formatted = bundle.format_pattern(pattern, args, &mut errors);

    if !errors.is_empty() {
        // Log formatting errors to Sentry
        sentry::capture_message(
            &format!("Error formatting {}: {:?}", key, errors),
            sentry::Level::Warning,
        );
        return key.to_string();
    }

    formatted.to_string()
}

/// Helper function to safely parse a UUID string
pub fn safe_parse_uuid(s: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(s).map_err(|e| AppError::InvalidUuid(format!("{}: {}", s, e)))
}

/// Helper function to safely decode a hex hash string
pub fn safe_decode_hash(s: &str) -> Result<Vec<u8>, AppError> {
    data_encoding::HEXLOWER
        .decode(s.as_bytes())
        .map_err(|e| AppError::InvalidHash(format!("{}: {}", s, e)))
}

/// Helper function to safely parse an email address
pub fn safe_parse_email(s: &str) -> Result<lettre::Address, AppError> {
    s.parse()
        .map_err(|e| AppError::InvalidEmail(format!("{}: {}", s, e)))
}
