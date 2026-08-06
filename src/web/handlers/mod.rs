use crate::app_error::AppError;
use crate::locale::LOCALES;
use crate::models::user::{AuthSession, Language, User};
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
pub mod admin;
pub mod auth;
pub mod collaborate;
pub mod collaborate_cleanup;
pub mod community;
pub mod devices;
pub mod draw;
pub mod hashtag;
pub mod home;
pub mod notifications;
pub mod password_reset;
pub mod policy;
pub mod post;
pub mod privacy;
pub mod profile;
pub mod report;
pub mod search;
pub mod well_known;

pub async fn handler_404(
    auth_session: AuthSession,
    ExtractFtlLang(ftl_lang): ExtractFtlLang,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    // The header counts only exist for signed-in users, and this handler
    // absorbs every bot scan for /wp-admin and friends — so don't open a
    // transaction we have nothing to ask.
    let (draft_post_count, unread_notification_count) = match auth_session.user.as_ref() {
        Some(user) => {
            let mut tx = state.db_pool.begin().await?;
            let common_ctx = CommonContext::build(&mut tx, Some(user.id)).await?;
            (
                common_ctx.draft_post_count,
                common_ctx.unread_notification_count,
            )
        }
        None => (0, 0),
    };

    let template: minijinja::Template<'_, '_> = state.env.get_template("404.jinja")?;
    let rendered: String = template.render(context! {
        current_user => auth_session.user,
        draft_post_count,
        unread_notification_count,
        ftl_lang
    })?;

    Ok((StatusCode::NOT_FOUND, Html(rendered)).into_response())
}

/// Liveness/readiness probe. Checks that a connection can actually be taken
/// from the pool and used, so a wedged or exhausted pool fails the check
/// instead of reporting healthy because the process is still running.
pub async fn health(State(state): State<AppState>) -> impl IntoResponse {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.db_pool)
        .await
    {
        Ok(_) => (StatusCode::OK, "ok").into_response(),
        Err(e) => {
            tracing::error!("health check failed: {}", e);
            (StatusCode::SERVICE_UNAVAILABLE, "database unavailable").into_response()
        }
    }
}

pub async fn render_403(
    auth_session: &AuthSession,
    state: &AppState,
    ftl_lang: String,
) -> Result<impl IntoResponse, AppError> {
    let db = &state.db_pool;
    let mut tx = db.begin().await?;

    let common_ctx =
        CommonContext::build(&mut tx, auth_session.user.as_ref().map(|u| u.id)).await?;

    let template: minijinja::Template<'_, '_> = state.env.get_template("403.jinja")?;
    let rendered: String = template.render(context! {
        current_user => auth_session.user,
        draft_post_count => common_ctx.draft_post_count,
        unread_notification_count => common_ctx.unread_notification_count,
        ftl_lang
    })?;

    Ok((StatusCode::FORBIDDEN, Html(rendered)).into_response())
}

pub fn detect_preferred_language(accept_language: &HeaderValue) -> Option<Language> {
    let header_str = accept_language.to_str().ok()?;
    let requested = parse_accepted_languages(header_str);
    let available = convert_vec_str_to_langids_lossy(["ko", "ja", "en", "zh"]);

    let supported = negotiate_languages(
        &requested,
        &available,
        None, // No default - if no match, return None
        NegotiationStrategy::Filtering,
    );

    let lang_code = supported.first().map(|l| l.language.as_str())?;

    match lang_code {
        "ko" => Some(Language::Ko),
        "ja" => Some(Language::Ja),
        "en" => Some(Language::En),
        "zh" => Some(Language::Zh),
        _ => None, // No match - return None instead of defaulting
    }
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
        let ftl_lang = bundle
            .locales
            .first()
            .map(|l| l.to_string())
            .unwrap_or_else(|| "en".to_string());

        Ok(ExtractFtlLang(ftl_lang))
    }
}

/// Extractor that admits only site-wide admins.
///
/// Every handler that reads through the normal visibility rules (private
/// communities, drafts, soft-deleted posts) takes this, so the unfiltered
/// queries in `models::admin` are unreachable without it.
pub struct AdminUser(pub User);

#[async_trait]
impl<S> FromRequestParts<S> for AdminUser
where
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let auth_session = AuthSession::from_request_parts(parts, state)
            .await
            .map_err(|_| AppError::Anyhow(anyhow::anyhow!("Failed to extract auth session")))?;

        let user = auth_session.user.ok_or(AppError::Unauthorized)?;

        if !user.is_admin() {
            return Err(AppError::Forbidden);
        }

        Ok(AdminUser(user))
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

            let lang_id = language
                .parse()
                .expect("Hardcoded language string should parse");
            let mut bundle = FluentBundle::new_concurrent(vec![lang_id]);
            bundle.add_resource(ftl).expect("Failed to add a resource.");

            bundle
        }
        None => {
            // Fallback to "en" if header is not valid UTF-8
            let header_str = accept_language.to_str().unwrap_or("en");
            let requested = parse_accepted_languages(header_str);
            let available = convert_vec_str_to_langids_lossy(["ko", "ja", "en", "zh"]);
            let default = "en".parse().expect("Failed to parse a langid.");

            let supported = negotiate_languages(
                &requested,
                &available,
                Some(&default),
                NegotiationStrategy::Filtering,
            );

            let lang_code = supported
                .first()
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

#[cfg(test)]
pub(crate) mod test_support {
    //! Shared minijinja environment for template render tests.
    //!
    //! Must mirror the setup in `main.rs` — most importantly the autoescape
    //! callback, or tests would pass while production rendered unescaped.

    use minijinja::{path_loader, Environment, State};
    use std::path::PathBuf;

    pub fn env() -> Environment<'static> {
        let mut env = Environment::new();
        env.set_auto_escape_callback(|_| minijinja::AutoEscape::Html);
        minijinja_contrib::add_to_environment(&mut env);
        env.add_filter("cachebuster", |value: String| value);
        env.add_filter("markdown", |value: String| value);
        env.add_function("ftl_get_message", |_state: &State, id: String| id);
        env.add_function(
            "ftl_format_pattern",
            |_state: &State, id: String, _args: minijinja::Value| id,
        );
        env.add_global("r2_public_endpoint_url", "https://example.test");
        env.add_global("base_url", "https://oeee.test");
        env.set_loader(path_loader(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("templates"),
        ));
        env
    }
}

#[cfg(test)]
mod social_meta_tests {
    //! The link-preview card lives in `base.jinja` and is overridden per page.
    //! These render the real templates because the failure mode is silent —
    //! a typo'd variable renders as an empty `content=""`, not an error.

    use super::test_support;
    use minijinja::context;
    use serde_json::json;

    fn chrome() -> minijinja::Value {
        context! {
            current_user => json!(null),
            messages => Vec::<serde_json::Value>::new(),
            draft_post_count => 0,
            unread_notification_count => 0,
            ftl_lang => "en",
        }
    }

    /// The `<head>` with runs of whitespace collapsed. Templates are formatted
    /// by djlint, which wraps long tags across lines, so asserting on raw
    /// output would break on reformatting rather than on behaviour. Scoping to
    /// the head also keeps body text from satisfying a meta-tag assertion.
    fn head(rendered: &str) -> String {
        let start = rendered.find("<head>").expect("page has a head");
        let end = rendered.find("</head>").expect("head is closed");
        rendered[start..end]
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn pages_without_an_override_get_the_site_card() {
        let env = test_support::env();
        let rendered = env
            .get_template("404.jinja")
            .expect("404 template loads")
            .render(chrome())
            .expect("404 renders");

        let head = head(&rendered);
        assert!(head.contains(r#"<meta property="og:title" content="brand" />"#));
        assert!(head.contains(r#"<meta property="og:description" content="about" />"#));
        assert!(
            head.contains(r#"<meta property="og:url" content="https://oeee.test/" />"#),
            "site card should point at the site root"
        );
        assert!(head.contains(r#"<meta name="twitter:card" content="summary" />"#));
    }

    #[test]
    fn public_community_gets_a_card_and_stays_indexable() {
        let env = test_support::env();
        let rendered = env
            .get_template("community.jinja")
            .expect("community template loads")
            .render(context! {
                community => json!({
                    "id": "00000000-0000-0000-0000-000000000001",
                    "name": "Open Studio",
                    "description": "Draw with us",
                    "slug": "open",
                    "visibility": "public",
                    "owner_id": "00000000-0000-0000-0000-000000000002",
                }),
                community_id => "00000000-0000-0000-0000-000000000001",
                domain => "oeee.test",
                posts => Vec::<serde_json::Value>::new(),
                comments => Vec::<serde_json::Value>::new(),
                ..chrome()
            })
            .expect("community renders");

        let head = head(&rendered);
        assert!(head.contains(r#"<meta property="og:title" content="Open Studio" />"#));
        assert!(head.contains(r#"<meta property="og:url" content="https://oeee.test/@open" />"#));
        assert!(
            !head.contains("noindex"),
            "a public community should be indexable"
        );
    }

    #[test]
    fn private_community_is_noindexed_and_leaks_no_preview() {
        let env = test_support::env();
        let rendered = env
            .get_template("community.jinja")
            .expect("community template loads")
            .render(context! {
                community => json!({
                    "id": "00000000-0000-0000-0000-000000000001",
                    "name": "Secret Studio",
                    "description": "Members only",
                    "slug": "secret",
                    "visibility": "private",
                    "owner_id": "00000000-0000-0000-0000-000000000002",
                }),
                community_id => "00000000-0000-0000-0000-000000000001",
                domain => "oeee.test",
                posts => Vec::<serde_json::Value>::new(),
                comments => Vec::<serde_json::Value>::new(),
                ..chrome()
            })
            .expect("community renders");

        let head = head(&rendered);
        assert!(head.contains(r#"<meta name="robots" content="noindex, nofollow" />"#));
        assert!(
            !head.contains("og:title"),
            "a private community must not emit a preview card"
        );
        assert!(
            !head.contains("Members only"),
            "the description must not leak into meta tags"
        );
    }

    #[test]
    fn profile_card_uses_the_banner_when_there_is_one() {
        let env = test_support::env();
        let user = json!({
            "id": "00000000-0000-0000-0000-000000000001",
            "login_name": "artist",
            "display_name": "An Artist",
        });
        let ctx = context! {
            user => user,
            domain => "oeee.test",
            banner => json!({
                "image_filename": "abcdef.png",
                "width": 200,
                "height": 40,
            }),
            followings => Vec::<serde_json::Value>::new(),
            links => Vec::<serde_json::Value>::new(),
            public_community_posts => Vec::<serde_json::Value>::new(),
            private_community_posts => Vec::<serde_json::Value>::new(),
            is_following => false,
            ..chrome()
        };

        let rendered = env
            .get_template("profile.jinja")
            .expect("profile template loads")
            .render(ctx)
            .expect("profile renders");

        let head = head(&rendered);
        assert!(head.contains(r#"<meta property="og:title" content="An Artist (@artist)" />"#));
        assert!(head.contains(r#"<meta property="og:url" content="https://oeee.test/@artist" />"#));
        assert!(
            head.contains(
                r#"<meta property="og:image" content="https://example.test/image/ab/abcdef.png" />"#
            ),
            "the banner is the profile's own image and should be the preview"
        );
    }
}

#[cfg(test)]
mod locale_tests {
    use super::{get_bundle, Language};
    use axum::http::header::HeaderValue;

    /// Building a bundle panics on a duplicate message id, and it happens per
    /// request — a duplicate key takes every page down with a 502 while
    /// `cargo check` and every template test stay green, because the template
    /// tests stub ftl_get_message and never load the real bundles.
    #[test]
    fn every_locale_bundle_builds() {
        let empty = HeaderValue::from_static("");
        for lang in [Language::Ko, Language::Ja, Language::En, Language::Zh] {
            let bundle = get_bundle(&empty, Some(lang.clone()));
            assert!(
                !bundle.locales.is_empty(),
                "{lang:?} bundle built with no locale"
            );
        }
        // The header-negotiated path builds its own bundle; cover it too.
        for header in ["ko", "ja", "en", "zh", "", "xx"] {
            let value = HeaderValue::from_str(header).expect("valid header");
            let _ = get_bundle(&value, None);
        }
    }
}
