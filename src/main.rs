use minijinja::{path_loader, Environment};
use minijinja_autoreload::AutoReloader;
use oeee::web::app::App;
use oeee::web::state::AppState;
use oeee::AppConfig;
use std::env::{self, args};
use std::path::PathBuf;
use std::process::exit;
use std::sync::Arc;
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

            // If DISABLE_AUTORELOAD is set, then the path tracking is disabled.
            let disable_autoreload = env::var("DISABLE_AUTORELOAD").as_deref() == Ok("1");

            // If FAST_AUTORELOAD is set, then fast reloading is enabled.
            let fast_autoreload = env::var("FAST_AUTORELOAD").as_deref() == Ok("1");

            // The closure is invoked every time the environment is outdated to
            // recreate it.
            let reloader = AutoReloader::new(move |notifier| {
                let template_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("templates");
                let mut env = Environment::new();
                minijinja_contrib::add_to_environment(&mut env);
                env.set_loader(path_loader(&template_path));

                if fast_autoreload {
                    notifier.set_fast_reload(true);
                }

                // if watch_path is never called, no fs watcher is created
                if !disable_autoreload {
                    notifier.watch_path(&template_path, true);
                }
                Ok(env)
            });

            let state = AppState {
                config: cfg.clone(),
                reloader: Arc::new(reloader),
            };

            App::new(state).await.unwrap().serve().await.unwrap()
        });
}
