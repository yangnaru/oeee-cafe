use crate::app_error::AppError;
use crate::locale::LOCALES;
use crate::models::post::get_draft_post_count;
use crate::models::user::{AuthSession, Language};
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
use fluent::bundle::FluentBundle;
use fluent::FluentResource;
use fluent_langneg::convert_vec_str_to_langids_lossy;
use fluent_langneg::negotiate_languages;
use fluent_langneg::parse_accepted_languages;
use fluent_langneg::NegotiationStrategy;
use intl_memoizer::concurrent::IntlLangMemoizer;
use minijinja::{context, Value};

use super::state::AppState;

pub mod about;
pub mod account;
pub mod auth;
pub mod community;
pub mod draw;
pub mod home;
pub mod post;
pub mod profile;

pub async fn handler_404(
    auth_session: AuthSession,
    ExtractAcceptLanguage(accept_language): ExtractAcceptLanguage,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    let db: sqlx::Pool<sqlx::Postgres> = state.config.connect_database().await?;
    let mut tx = db.begin().await?;
    let draft_post_count = match auth_session.user.clone() {
        Some(user) => get_draft_post_count(&mut tx, user.id)
            .await
            .unwrap_or_default(),
        None => 0,
    };

    let user_preferred_language = auth_session
        .user
        .clone()
        .map(|u| u.preferred_language)
        .unwrap_or_else(|| None);
    let bundle = get_bundle(&accept_language, user_preferred_language);
    let template: minijinja::Template<'_, '_> = state.env.get_template("404.html")?;
    let rendered: String = template.render(context! {
        current_user => auth_session.user,
        draft_post_count,
        ..create_base_ftl_context(&bundle)
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

fn create_base_ftl_context(bundle: &FluentBundle<&FluentResource, IntlLangMemoizer>) -> Value {
    context! {
        ftl_lang => bundle.locales.get(0).unwrap().to_string(),

        ftl_brand => bundle.format_pattern(bundle.get_message("brand").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_about => bundle.format_pattern(bundle.get_message("about").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_error_404 => bundle.format_pattern(bundle.get_message("error-404").unwrap().value().unwrap(), None, &mut vec![]),

        ftl_timeline => bundle.format_pattern(bundle.get_message("timeline").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_timeline_public => bundle.format_pattern(bundle.get_message("timeline-public").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_timeline_my => bundle.format_pattern(bundle.get_message("timeline-my").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_timeline_empty => bundle.format_pattern(bundle.get_message("timeline-empty").unwrap().value().unwrap(), None, &mut vec![]),

        ftl_home => bundle.format_pattern(bundle.get_message("home").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_drafts => bundle.format_pattern(bundle.get_message("drafts").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_profile => bundle.format_pattern(bundle.get_message("profile").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_community => bundle.format_pattern(bundle.get_message("community").unwrap().value().unwrap(), None, &mut vec![]),

        ftl_sign_up => bundle.format_pattern(bundle.get_message("sign-up").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_sign_in => bundle.format_pattern(bundle.get_message("sign-in").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_sign_out => bundle.format_pattern(bundle.get_message("sign-out").unwrap().value().unwrap(), None, &mut vec![]),

        ftl_account => bundle.format_pattern(bundle.get_message("account").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_email_not_verified => bundle.format_pattern(bundle.get_message("email-not-verified").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_login_name => bundle.format_pattern(bundle.get_message("login-name").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_password => bundle.format_pattern(bundle.get_message("password").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_password_repeat => bundle.format_pattern(bundle.get_message("password-repeat").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_display_name => bundle.format_pattern(bundle.get_message("display-name").unwrap().value().unwrap(), None, &mut vec![]),

        ftl_latest_active_public_community => bundle.format_pattern(bundle.get_message("latest-active-public-community").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_recent_drawings => bundle.format_pattern(bundle.get_message("recent-drawings").unwrap().value().unwrap(), None, &mut vec![]),

        ftl_post_created_at => bundle.format_pattern(bundle.get_message("post-created-at").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_post_published_at => bundle.format_pattern(bundle.get_message("post-published-at").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_post_duration => bundle.format_pattern(bundle.get_message("post-duration").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_post_replay => bundle.format_pattern(bundle.get_message("post-replay").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_post_author => bundle.format_pattern(bundle.get_message("post-author").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_post_title => bundle.format_pattern(bundle.get_message("post-title").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_post_no_title => bundle.format_pattern(bundle.get_message("post-no-title").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_post_description => bundle.format_pattern(bundle.get_message("post-description").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_post_comments => bundle.format_pattern(bundle.get_message("post-comments").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_post_comment => bundle.format_pattern(bundle.get_message("post-comment").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_post_publish => bundle.format_pattern(bundle.get_message("post-publish").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_post_edit => bundle.format_pattern(bundle.get_message("post-edit").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_post_save => bundle.format_pattern(bundle.get_message("post-save").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_post_edit_cancel => bundle.format_pattern(bundle.get_message("post-edit-cancel").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_post_delete => bundle.format_pattern(bundle.get_message("post-delete").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_post_delete_confirm => bundle.format_pattern(bundle.get_message("post-delete-confirm").unwrap().value().unwrap(), None, &mut vec![]),

        ftl_comment_created_at => bundle.format_pattern(bundle.get_message("comment-created-at").unwrap().value().unwrap(), None, &mut vec![]),

        ftl_draft_post => bundle.format_pattern(bundle.get_message("draft-post").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_sensitive => bundle.format_pattern(bundle.get_message("sensitive").unwrap().value().unwrap(), None, &mut vec![]),

        ftl_active_communities_nil => bundle.format_pattern(bundle.get_message("active-communities-nil").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_my_communities => bundle.format_pattern(bundle.get_message("my-communities").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_my_communities_nil => bundle.format_pattern(bundle.get_message("my-communities-nil").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_create_community => bundle.format_pattern(bundle.get_message("create-community").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_new_community => bundle.format_pattern(bundle.get_message("new-community").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_community_name => bundle.format_pattern(bundle.get_message("community-name").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_community_description => bundle.format_pattern(bundle.get_message("community-description").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_private_community => bundle.format_pattern(bundle.get_message("private-community").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_private_community_description => bundle.format_pattern(bundle.get_message("private-community-description").unwrap().value().unwrap(), None, &mut vec![]),

        ftl_community_drawing_tool => bundle.format_pattern(bundle.get_message("community-drawing-tool").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_community_drawing_width => bundle.format_pattern(bundle.get_message("community-drawing-width").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_community_drawing_height => bundle.format_pattern(bundle.get_message("community-drawing-height").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_community_drawing_new => bundle.format_pattern(bundle.get_message("community-drawing-new").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_community_no_posts => bundle.format_pattern(bundle.get_message("community-no-posts").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_community_drawing_post_error => bundle.format_pattern(bundle.get_message("community-drawing-post-error").unwrap().value().unwrap(), None, &mut vec![]),

        ftl_profile_link => bundle.format_pattern(bundle.get_message("profile-link").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_profile_manage => bundle.format_pattern(bundle.get_message("profile-manage").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_profile_draw_banner => bundle.format_pattern(bundle.get_message("profile-draw-banner").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_profile_guestbook => bundle.format_pattern(bundle.get_message("profile-guestbook").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_profile_following => bundle.format_pattern(bundle.get_message("profile-following").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_profile_public_community_posts => bundle.format_pattern(bundle.get_message("profile-public-community-posts").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_profile_public_community_posts_nil => bundle.format_pattern(bundle.get_message("profile-public-community-posts-nil").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_profile_settings => bundle.format_pattern(bundle.get_message("profile-settings").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_profile_link_management => bundle.format_pattern(bundle.get_message("profile-link-management").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_profile_link_requires_verified_email => bundle.format_pattern(bundle.get_message("profile-link-requires-verified-email").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_profile_link_order => bundle.format_pattern(bundle.get_message("profile-link-order").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_profile_link_move_up => bundle.format_pattern(bundle.get_message("profile-link-move-up").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_profile_link_move_down => bundle.format_pattern(bundle.get_message("profile-link-move-down").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_profile_link_delete => bundle.format_pattern(bundle.get_message("profile-link-delete").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_profile_link_delete_confirm => bundle.format_pattern(bundle.get_message("profile-link-delete-confirm").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_profile_link_add => bundle.format_pattern(bundle.get_message("profile-link-add").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_profile_link_description => bundle.format_pattern(bundle.get_message("profile-link-description").unwrap().value().unwrap(), None, &mut vec![]),

        ftl_follow => bundle.format_pattern(bundle.get_message("follow").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_unfollow => bundle.format_pattern(bundle.get_message("unfollow").unwrap().value().unwrap(), None, &mut vec![]),

        ftl_guestbook => bundle.format_pattern(bundle.get_message("guestbook").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_guestbook_write => bundle.format_pattern(bundle.get_message("guestbook-write").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_guestbook_empty => bundle.format_pattern(bundle.get_message("guestbook-empty").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_guestbook_delete => bundle.format_pattern(bundle.get_message("guestbook-delete").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_guestbook_delete_confirm => bundle.format_pattern(bundle.get_message("guestbook-delete-confirm").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_guestbook_reply => bundle.format_pattern(bundle.get_message("guestbook-reply").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_guestbook_reply_write => bundle.format_pattern(bundle.get_message("guestbook-reply-write").unwrap().value().unwrap(), None, &mut vec![]),

        ftl_account_info => bundle.format_pattern(bundle.get_message("account-info").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_account_created_at => bundle.format_pattern(bundle.get_message("account-created-at").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_account_info_edit => bundle.format_pattern(bundle.get_message("account-info-edit").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_account_change_password => bundle.format_pattern(bundle.get_message("account-change-password").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_account_change_password_current => bundle.format_pattern(bundle.get_message("account-change-password-current").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_account_change_password_new => bundle.format_pattern(bundle.get_message("account-change-password-new").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_account_change_password_new_repeat => bundle.format_pattern(bundle.get_message("account-change-password-new-repeat").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_account_change_email => bundle.format_pattern(bundle.get_message("account-change-email").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_account_change_email_email => bundle.format_pattern(bundle.get_message("account-change-email-email").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_account_change_email_verified_at => bundle.format_pattern(bundle.get_message("account-change-email-verified-at").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_account_verify_email_request => bundle.format_pattern(bundle.get_message("account-verify-email-request").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_account_email_not_verified_warning => bundle.format_pattern(bundle.get_message("account-email-not-verified-warning").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_account_change_email_token => bundle.format_pattern(bundle.get_message("account-change-email-token").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_account_change_email_verify => bundle.format_pattern(bundle.get_message("account-change-email-verify").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_account_language_settings => bundle.format_pattern(bundle.get_message("account-language-settings").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_account_language_settings_save => bundle.format_pattern(bundle.get_message("account-language-settings-save").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_account_language_current => bundle.format_pattern(bundle.get_message("account-language-current").unwrap().value().unwrap(), None, &mut vec![]),
        ftl_account_language_auto => bundle.format_pattern(bundle.get_message("account-language-auto").unwrap().value().unwrap(), None, &mut vec![]),
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
            };
            let ftl = LOCALES
                .get(language)
                .unwrap_or_else(|| LOCALES.get("ko").unwrap());

            let mut bundle = FluentBundle::new_concurrent(vec![language.parse().unwrap()]);
            bundle.add_resource(ftl).expect("Failed to add a resource.");

            return bundle;
        }
        None => {
            let requested = parse_accepted_languages(accept_language.to_str().unwrap());
            let available = convert_vec_str_to_langids_lossy(&["ko", "ja", "en"]);
            let default = "ko".parse().expect("Failed to parse a langid.");

            let supported = negotiate_languages(
                &requested,
                &available,
                Some(&default),
                NegotiationStrategy::Filtering,
            );

            let ftl = LOCALES
                .get(supported.get(0).unwrap().language.as_str())
                .unwrap_or_else(|| LOCALES.get("ko").unwrap());

            let mut bundle = FluentBundle::new_concurrent(vec![supported
                .get(0)
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
