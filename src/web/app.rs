use super::handlers::{
    about, account, do_login, do_logout, do_signup, draw_finish, home, login, signup, start_draw,
};
use super::state::AppState;
use crate::models::user::Backend;
use crate::web::handlers::{
    community, create_community_form, do_create_community, draft_posts, edit_account,
    new_community_post, post_form, post_publish,
};
use anyhow::Result;
use axum::routing::{get, post};
use axum::Router;
use axum_login::{login_required, AuthManagerLayerBuilder};
use axum_messages::MessagesManagerLayer;
use sqlx::PgPool;
use std::net::SocketAddr;
use time::Duration;
use tokio::signal;
use tokio::task::AbortHandle;
use tower_http::services::ServeDir;
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

        let schema_name = self.state.config.db_url.rsplit("/").next().unwrap();
        let pool = PgPool::connect(&self.state.config.db_url).await?;
        let session_store = PostgresStore::new(pool)
            .with_table_name("sessions")
            .unwrap()
            .with_schema_name(schema_name)
            .unwrap();
        session_store.migrate().await?;

        let deletion_task = tokio::task::spawn(
            session_store
                .clone()
                .continuously_delete_expired(tokio::time::Duration::from_secs(60)),
        );

        let session_layer = SessionManagerLayer::new(session_store)
            .with_secure(false)
            .with_expiry(Expiry::OnInactivity(Duration::seconds(60 * 60 * 24 * 30)));

        let auth_layer = AuthManagerLayerBuilder::new(authn_backend, session_layer).build();

        let static_router = Router::new()
            .nest_service("/static/neo/dist", ServeDir::new("neo/dist"))
            .nest_service("/static", ServeDir::new("static"));

        let protected_router = Router::new()
            .route("/account", get(account))
            .route("/account", post(edit_account))
            .route("/communities/new", get(create_community_form))
            .route("/communities", post(do_create_community))
            .route("/communities/:id", get(community))
            .route("/communities/:id/draw", get(new_community_post))
            .route("/logout", post(do_logout))
            .route("/draw", post(start_draw))
            .route("/finish", post(draw_finish))
            .route("/posts/drafts", get(draft_posts))
            .route("/posts/:id", get(post_form))
            .route("/posts/publish", post(post_publish))
            .route_layer(login_required!(Backend, login_url = "/login"));

        let app = Router::new()
            .route("/", get(home))
            .route("/about", get(about))
            .route("/signup", get(signup))
            .route("/signup", post(do_signup))
            .route("/login", get(login))
            .route("/login", post(do_login))
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
