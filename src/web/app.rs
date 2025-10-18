use super::state::AppState;
use crate::models::user::Backend;
use crate::web::handlers::about::about;
use crate::web::handlers::account::{
    account, edit_account, edit_password, request_email_verification_code, save_language,
    verify_email_verification_code,
};
use crate::web::handlers::activitypub::{
    activitypub_get_community, activitypub_get_post, activitypub_get_user,
    activitypub_post_community_inbox, activitypub_post_shared_inbox,
    activitypub_post_user_followers, activitypub_post_user_inbox, activitypub_webfinger,
};
use crate::web::handlers::auth::{do_login, do_logout, do_signup, login, signup};
use crate::web::handlers::collaborate::{
    collaborate_lobby, create_collaborative_session, get_auth_info, get_collaboration_meta,
    save_collaborative_session, serve_collaborative_app, websocket_collaborate_handler,
};
use crate::web::handlers::collaborate_cleanup::cleanup_collaborative_sessions;
use crate::web::handlers::community::{
    communities, community, community_comments, community_iframe, create_community_form,
    do_create_community, hx_do_edit_community, hx_edit_community,
};
use crate::web::handlers::draw::{
    banner_draw_finish, draw_finish, start_banner_draw, start_draw, start_draw_get,
};
use crate::web::handlers::handler_404;
use crate::web::handlers::hashtag::{hashtag_autocomplete, hashtag_discovery, hashtag_view};
use crate::web::handlers::home::{home, load_more_public_posts, my_timeline};
use crate::web::handlers::notifications::{
    delete_notification_handler, get_unread_notification_count, list_notifications,
    mark_all_notifications_read, mark_notification_read,
};
use crate::web::handlers::post::{
    add_reaction, do_create_comment, do_post_edit_community,
    draft_posts, hx_delete_post, hx_do_edit_post, hx_edit_post,
    post_edit_community, post_publish, post_publish_form, post_reactions_detail, post_relay_view,
    post_relay_view_by_login_name, post_replay_view, post_replay_view_by_login_name,
    post_view_by_login_name, redirect_post_to_login_name, remove_reaction,
};
use crate::web::handlers::profile::{
    do_add_link, do_delete_guestbook_entry, do_delete_link, do_follow_profile, do_move_link_down,
    do_move_link_up, do_reply_guestbook_entry, do_unfollow_profile, do_write_guestbook_entry,
    guestbook, profile, profile_banners_iframe, profile_iframe, profile_settings,
};
use activitypub_federation::config::{FederationConfig, FederationMiddleware};
use anyhow::Result;
use axum::extract::DefaultBodyLimit;
use axum::routing::{delete, get, post, put};
use axum::Router;
use axum_login::{login_required, AuthManagerLayerBuilder};
use axum_messages::MessagesManagerLayer;
use std::net::SocketAddr;
use time::Duration;
use tokio::signal;
use tokio::task::AbortHandle;
use tower_http::services::ServeDir;
use tower_sessions::cookie::SameSite;
use tower_sessions::{session_store::ExpiredDeletion, Expiry, SessionManagerLayer};
use tower_sessions_sqlx_store::PostgresStore;

pub struct App {
    state: AppState,
}

impl App {
    pub async fn new(state: AppState) -> Result<Self, Box<dyn std::error::Error>> {
        sqlx::migrate!().run(&state.db_pool).await?;

        Ok(Self { state })
    }

    pub async fn serve(self) -> Result<(), Box<dyn std::error::Error>> {
        let authn_backend: Backend = Backend {
            db: self.state.db_pool.clone(),
        };

        let session_store = PostgresStore::new(self.state.db_pool.clone())
            .with_table_name("sessions")
            .unwrap()
            .with_schema_name("public")
            .unwrap();
        session_store.migrate().await?;

        let deletion_task = tokio::task::spawn(
            session_store
                .clone()
                .continuously_delete_expired(tokio::time::Duration::from_secs(60)),
        );

        let cleanup_task = tokio::task::spawn(cleanup_collaborative_sessions(self.state.clone()));

        let session_layer = SessionManagerLayer::new(session_store)
            .with_secure(self.state.config.env == "production")
            .with_same_site(SameSite::Lax)
            .with_expiry(Expiry::OnInactivity(Duration::seconds(60 * 60 * 24 * 30)));

        let auth_layer = AuthManagerLayerBuilder::new(authn_backend, session_layer).build();

        let static_router = Router::new()
            .nest_service("/static/cucumber", ServeDir::new("cucumber"))
            .nest_service("/static/neo/dist", ServeDir::new("neo/dist"))
            .nest_service("/static/tegaki/css", ServeDir::new("tegaki/css"))
            .nest_service("/static/tegaki/js", ServeDir::new("tegaki/js"))
            .nest_service("/static/tegaki/lib", ServeDir::new("tegaki/lib"))
            .nest_service(
                "/collaborate/assets",
                ServeDir::new("neo-cucumber/dist/assets"),
            )
            .nest_service("/static", ServeDir::new("static"));

        let protected_router = Router::new()
            .route("/home", get(my_timeline))
            .route("/notifications", get(list_notifications))
            .route(
                "/notifications/unread-count",
                get(get_unread_notification_count),
            )
            .route(
                "/notifications/mark-all-read",
                post(mark_all_notifications_read),
            )
            .route(
                "/notifications/:notification_id/mark-read",
                post(mark_notification_read),
            )
            .route(
                "/notifications/:notification_id",
                delete(delete_notification_handler),
            )
            .route("/account", get(account))
            .route("/account", post(edit_account))
            .route("/account/password", post(edit_password))
            .route("/account/language", post(save_language))
            .route(
                "/account/request-verify-email",
                post(request_email_verification_code),
            )
            .route(
                "/account/verify-email",
                post(verify_email_verification_code),
            )
            .route("/comments", post(do_create_comment))
            .route("/posts/:post_id/reactions/add", post(add_reaction))
            .route("/posts/:post_id/reactions/remove", post(remove_reaction))
            .route("/communities/new", get(create_community_form))
            .route("/logout", post(do_logout))
            .route("/draw", get(start_draw_get))
            .route("/draw", post(start_draw))
            .route(
                "/draw/finish",
                post(draw_finish).layer(DefaultBodyLimit::max(10 * 1024 * 1024)),
            )
            .route("/posts/drafts", get(draft_posts))
            .route("/posts/publish", post(post_publish))
            .route("/posts/:id/edit", get(hx_edit_post))
            .route("/posts/:id/relay", get(post_relay_view))
            .route("/posts/:id", put(hx_do_edit_post))
            .route("/posts/:id", delete(hx_delete_post))
            .route("/posts/:id/edit/community", get(post_edit_community))
            .route("/posts/:id/edit/community", post(do_post_edit_community))
            .route("/banners/draw", get(start_banner_draw))
            .route("/banners/draw/finish", post(banner_draw_finish))
            .route("/posts/:id/publish", get(post_publish_form))
            .route("/posts/:id/replay", get(post_replay_view))
            .route("/@:login_name/follow", post(do_follow_profile))
            .route("/@:login_name/unfollow", post(do_unfollow_profile))
            .route("/@:login_name/guestbook", post(do_write_guestbook_entry))
            .route(
                "/@:login_name/guestbook/:entry_id",
                delete(do_delete_guestbook_entry),
            )
            .route(
                "/@:login_name/guestbook/:entry_id/reply",
                post(do_reply_guestbook_entry),
            )
            .route_layer(login_required!(Backend, login_url = "/login"));

        let state = self.state.clone();
        let domain = state.config.domain.clone();
        let activitypub_data = FederationConfig::builder()
            .domain(domain)
            .app_data(state)
            .build()
            .await?;

        let activitypub_router = Router::new()
            .route("/.well-known/webfinger", get(activitypub_webfinger))
            .route("/ap/users/:login_name", get(activitypub_get_user))
            .route("/ap/posts/:post_id", get(activitypub_get_post))
            .route(
                "/ap/communities/:community_id",
                get(activitypub_get_community),
            )
            .route(
                "/ap/users/:login_name/inbox",
                post(activitypub_post_user_inbox),
            )
            .route(
                "/ap/users/:login_name/followers",
                get(activitypub_post_user_followers),
            )
            .route(
                "/ap/communities/:community_id/inbox",
                post(activitypub_post_community_inbox),
            )
            .route("/ap/inbox", post(activitypub_post_shared_inbox))
            .layer(FederationMiddleware::new(activitypub_data));

        let app = Router::new()
            .route("/", get(home))
            .route("/api/home/posts", get(load_more_public_posts))
            .route("/communities", get(communities))
            .route("/communities", post(do_create_community))
            .route("/communities/:id", get(community))
            .route("/communities/:id", put(hx_do_edit_community))
            .route("/communities/:id/edit", get(hx_edit_community))
            .route("/communities/:id/comments", get(community_comments))
            .route("/communities/:id/embed", get(community_iframe))
            .route("/hashtags", get(hashtag_discovery))
            .route("/hashtags/:hashtag_name", get(hashtag_view))
            .route("/api/hashtags/autocomplete", get(hashtag_autocomplete))
            .route("/@:login_name", get(profile))
            .route("/@:login_name/embed", get(profile_iframe))
            .route("/@:login_name/banners/embed", get(profile_banners_iframe))
            .route("/@:login_name/settings/links", post(do_add_link))
            .route("/@:login_name/settings/links/:id", delete(do_delete_link))
            .route("/@:login_name/settings/links/:id/up", post(do_move_link_up))
            .route(
                "/@:login_name/settings/links/:id/down",
                post(do_move_link_down),
            )
            .route("/@:login_name/settings", get(profile_settings))
            .route("/@:login_name/guestbook", get(guestbook))
            .route("/@:login_name/:post_id", get(post_view_by_login_name))
            .route(
                "/@:login_name/:post_id/reactions",
                get(post_reactions_detail),
            )
            .route(
                "/@:login_name/:post_id/replay",
                get(post_replay_view_by_login_name),
            )
            .route(
                "/@:login_name/:post_id/relay",
                get(post_relay_view_by_login_name),
            )
            .route("/posts/:id", get(redirect_post_to_login_name))
            .route(
                "/collaborate",
                get(collaborate_lobby).post(create_collaborative_session),
            )
            .route(
                "/collaborate/:uuid",
                get(serve_collaborative_app).post(save_collaborative_session),
            )
            .route("/collaborate/:uuid/ws", get(websocket_collaborate_handler))
            .route("/api/auth", get(get_auth_info))
            .route("/collaboration/:uuid/meta", get(get_collaboration_meta))
            .route("/about", get(about))
            .route("/signup", get(signup))
            .route("/signup", post(do_signup))
            .route("/login", get(login))
            .route("/login", post(do_login))
            .fallback(handler_404)
            .merge(protected_router)
            .layer(MessagesManagerLayer)
            .layer(auth_layer)
            .with_state(self.state.clone())
            .merge(static_router)
            .merge(activitypub_router);

        // run our app with hyper, listening globally
        let addr = SocketAddr::from(([0, 0, 0, 0], self.state.config.port));
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        tracing::info!("listening on {}", addr);

        // Ensure we use a shutdown signal to abort the background tasks.
        axum::serve(listener, app.into_make_service())
            .with_graceful_shutdown(shutdown_signal(
                deletion_task.abort_handle(),
                cleanup_task.abort_handle(),
            ))
            .await?;

        deletion_task.await??;
        cleanup_task.await?;

        Ok(())
    }
}

async fn shutdown_signal(
    deletion_task_abort_handle: AbortHandle,
    cleanup_task_abort_handle: AbortHandle,
) {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            deletion_task_abort_handle.abort();
            cleanup_task_abort_handle.abort();
        },
        _ = terminate => {
            deletion_task_abort_handle.abort();
            cleanup_task_abort_handle.abort();
        },
    }
}
