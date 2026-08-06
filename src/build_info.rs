use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Identifier for this build of the server, used to version static asset URLs.
///
/// Read from the `GIT_COMMIT` environment variable, which the Dockerfile sets
/// in the runtime image. Deliberately a runtime lookup rather than `option_env!`
/// at compile time, for two reasons: sccache does not include the variable in
/// its cache key, so a baked-in value silently came back stale from cache; and
/// a compile-time value would rebuild the whole crate on every deploy just to
/// change a version string.
///
/// Without the variable — a plain `cargo build`, or `cargo run` locally — it
/// falls back to the process start time. Still constant for the lifetime of the
/// process, so asset URLs stay stable between requests either way.
pub fn build_id() -> &'static str {
    static BUILD_ID: OnceLock<String> = OnceLock::new();
    BUILD_ID.get_or_init(|| match std::env::var("GIT_COMMIT") {
        Ok(sha) if !sha.is_empty() => sha.chars().take(12).collect(),
        _ => SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("System time is before UNIX_EPOCH")
            .as_secs()
            .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::build_id;

    #[test]
    fn build_id_is_stable_within_a_process() {
        assert_eq!(build_id(), build_id());
    }

    #[test]
    fn build_id_is_never_empty() {
        assert!(
            !build_id().is_empty(),
            "an empty id would produce `style.css?`"
        );
    }
}
