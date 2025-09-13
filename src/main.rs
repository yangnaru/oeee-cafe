use fluent::bundle::FluentBundle;
use minijinja::{path_loader, Environment, State};
use oeee_cafe::locale::LOCALES;
use oeee_cafe::web::app::App;
use oeee_cafe::web::handlers::collaborate::redis_state::RedisStateManager;
use oeee_cafe::web::state::AppState;
use oeee_cafe::AppConfig;
use std::env::args;
use std::path::PathBuf;
use std::process::exit;
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

            fn ftl_get_message(state: &State, message_id: String) -> String {
                // Get the current language from template context
                let lang = match state.lookup("ftl_lang") {
                    Some(lang_val) => lang_val.as_str().unwrap_or("ko").to_string(),
                    None => "ko".to_string(),
                };

                // Get the appropriate Fluent resource
                let ftl = LOCALES
                    .get(&lang)
                    .unwrap_or_else(|| LOCALES.get("ko").unwrap());

                // Create bundle
                let mut bundle = FluentBundle::new_concurrent(vec![lang.parse().unwrap()]);
                bundle.add_resource(ftl).expect("Failed to add a resource.");

                // Get and format the message
                match bundle.get_message(&message_id) {
                    Some(message) => match message.value() {
                        Some(pattern) => bundle
                            .format_pattern(pattern, None, &mut vec![])
                            .to_string(),
                        None => message_id,
                    },
                    None => message_id,
                }
            }
            env.add_function("ftl_get_message", ftl_get_message);

            env.set_loader(path_loader(&template_path));

            let db_pool = cfg.connect_database().await.unwrap_or_else(|e| {
                eprintln!("error connecting to database: {}", e);
                exit(1);
            });

            let redis_pool = cfg.connect_redis().await.unwrap_or_else(|e| {
                eprintln!("error connecting to redis: {}", e);
                exit(1);
            });

            let redis_state = RedisStateManager::new(redis_pool.clone());

            let state = AppState {
                config: cfg.clone(),
                env,
                db_pool,
                redis_pool,
                redis_state,
            };

            App::new(state).await.unwrap().serve().await.unwrap()
        });
}
