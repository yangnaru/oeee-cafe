use super::state::AppState;
use crate::models::user::Backend;
use crate::web::handlers::about::about;
use crate::web::handlers::account::{
    account, edit_account, edit_password, request_email_verification_code, save_language,
    verify_email_verification_code,
};
use crate::web::handlers::auth::{do_login, do_logout, do_signup, login, signup};
use crate::web::handlers::community::{
    communities, community, community_iframe, create_community_form, do_create_community,
};
use crate::web::handlers::draw::{
    banner_draw_finish, draw_finish, start_banner_draw, start_draw, start_draw_get,
};
use crate::web::handlers::handler_404;
use crate::web::handlers::home::{home, my_timeline};
use crate::web::handlers::notifications::list_notifications;
use crate::web::handlers::post::{
    do_create_comment, do_post_edit_community, draft_posts, hx_delete_post, hx_do_edit_post,
    hx_edit_post, post_edit_community, post_publish, post_publish_form, post_replay_view,
    post_view,
};
use crate::web::handlers::profile::{
    do_add_link, do_delete_guestbook_entry, do_delete_link, do_follow_profile, do_move_link_down,
    do_move_link_up, do_reply_guestbook_entry, do_unfollow_profile, do_write_guestbook_entry,
    guestbook, profile, profile_banners_iframe, profile_iframe, profile_settings,
};
use anyhow::Result;
use axum::extract::DefaultBodyLimit;
use axum::routing::{delete, get, post, put};
use axum::Router;
use axum_login::{login_required, AuthManagerLayerBuilder};
use axum_messages::MessagesManagerLayer;
use sqlx::PgPool;
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
        sqlx::migrate!()
            .run(&state.config.connect_database().await.unwrap())
            .await?;

        Ok(Self { state })
    }

    pub async fn serve(self) -> Result<(), Box<dyn std::error::Error>> {
        let db = self.state.config.connect_database().await.unwrap();
        let authn_backend: Backend = Backend { db: db.to_owned() };

        let pool = PgPool::connect(&self.state.config.db_url).await?;
        let session_store = PostgresStore::new(pool)
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

        let session_layer = SessionManagerLayer::new(session_store)
            .with_secure(self.state.config.env == "production")
            .with_same_site(SameSite::Lax)
            .with_expiry(Expiry::OnInactivity(Duration::seconds(60 * 60 * 24 * 30)));

        let auth_layer = AuthManagerLayerBuilder::new(authn_backend, session_layer).build();

        let static_router = Router::new()
            .nest_service("/static/neo/dist", ServeDir::new("neo/dist"))
            .nest_service("/static/tegaki/css", ServeDir::new("tegaki/css"))
            .nest_service("/static/tegaki/js", ServeDir::new("tegaki/js"))
            .nest_service("/static/tegaki/lib", ServeDir::new("tegaki/lib"))
            .nest_service("/static", ServeDir::new("static"));

        let protected_router = Router::new()
            .route("/home", get(my_timeline))
            .route("/notifications", get(list_notifications))
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

        let app = Router::new()
            .route("/", get(home))
            .route("/communities", get(communities))
            .route("/communities", post(do_create_community))
            .route("/communities/:id", get(community))
            .route("/communities/:id/embed", get(community_iframe))
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
            .route("/posts/:id", get(post_view))
            .route("/about", get(about))
            .route("/signup", get(signup))
            .route("/signup", post(do_signup))
            .route("/login", get(login))
            .route("/login", post(do_login))
            .fallback(handler_404)
            .merge(protected_router)
            .layer(MessagesManagerLayer)
            .layer(auth_layer)
            .with_state(self.state)
            .merge(static_router);

        // run our app with hyper, listening globally on port 3000
        let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        tracing::info!("listening on {}", addr);

        // Ensure we use a shutdown signal to abort the deletion task.
        axum::serve(listener, app.into_make_service())
            .with_graceful_shutdown(shutdown_signal(deletion_task.abort_handle()))
            .await?;

        deletion_task.await??;

        Ok(())
    }
}

async fn shutdown_signal(deletion_task_abort_handle: AbortHandle) {
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
        _ = ctrl_c => { deletion_task_abort_handle.abort() },
        _ = terminate => { deletion_task_abort_handle.abort() },
    }
}
