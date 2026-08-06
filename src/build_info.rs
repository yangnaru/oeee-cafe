use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Identifier for this build of the server, used to version static asset URLs.
///
/// In a release image this is the git SHA baked in at compile time (the
/// Dockerfile turns the `GIT_COMMIT` build-arg into an environment variable
/// that `option_env!` picks up). Without it — a plain `cargo build` — we fall
/// back to the process start time, which is still constant for the lifetime of
/// the process, so asset URLs stay stable between requests either way.
pub fn build_id() -> &'static str {
    static BUILD_ID: OnceLock<String> = OnceLock::new();
    BUILD_ID.get_or_init(|| match option_env!("GIT_COMMIT") {
        Some(sha) if !sha.is_empty() => sha.chars().take(12).collect(),
        _ => SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("System time is before UNIX_EPOCH")
            .as_secs()
            .to_string(),
    })
}
