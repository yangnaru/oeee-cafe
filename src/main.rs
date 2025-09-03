use dashmap::DashMap;
use minijinja::{path_loader, Environment};
use oeee_cafe::web::app::App;
use oeee_cafe::web::state::AppState;
use oeee_cafe::AppConfig;
use std::env::args;
use std::path::PathBuf;
use std::process::exit;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::Level;

fn main() {
    let _guard = sentry::init(("https://6f202f7747ec1610bddefdb78d0d771d@o4506172058959872.ingest.us.sentry.io/4506955685298176", sentry::ClientOptions {
        release: sentry::release_name!(),
        ..Default::default()
      }));

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let args: Vec<String> = args().collect();
            if args.len() < 2 {
                println!("usage: {} CFG", args.first().unwrap_or(&"oeee".to_string()));
                exit(1);
            }

            let cfg: AppConfig =
                AppConfig::new_from_file_and_env(args[1].as_ref()).unwrap_or_else(|e| {
                    eprintln!("error: {}", e);
                    exit(1);
                });

            // initialize tracing
            let subscriber = tracing_subscriber::fmt()
                .with_max_level(Level::DEBUG)
                .finish();
            let _ = tracing::subscriber::set_global_default(subscriber);

            tracing::debug!("config: {:?}", cfg);

            let template_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("templates");
            let mut env = Environment::new();
            minijinja_contrib::add_to_environment(&mut env);

            fn cachebuster(value: String) -> String {
                let timestamp = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs();
                format!("{}?{}", value, timestamp)
            }
            env.add_filter("cachebuster", cachebuster);

            fn markdown_to_html(value: String) -> String {
                oeee_cafe::markdown_utils::process_markdown_content(&value)
            }
            env.add_filter("markdown", markdown_to_html);
            env.set_loader(path_loader(&template_path));

            let state = AppState {
                config: cfg.clone(),
                env,
                collaboration_rooms: Arc::new(DashMap::new()),
                message_history: Arc::new(DashMap::new()),
                last_activity_cache: Arc::new(DashMap::new()),
                snapshot_request_tracker: Arc::new(DashMap::new()),
                connection_user_mapping: Arc::new(DashMap::new()),
            };

            App::new(state).await.unwrap().serve().await.unwrap()
        });
}
