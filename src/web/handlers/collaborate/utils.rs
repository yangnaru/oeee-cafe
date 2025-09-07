use crate::models::user::Language;
use fluent_langneg::{
    convert_vec_str_to_langids_lossy, negotiate_languages, parse_accepted_languages,
    NegotiationStrategy,
};
use uuid::Uuid;

pub fn bytes_to_uuid(bytes: &[u8]) -> Result<Uuid, &'static str> {
    if bytes.len() != 16 {
        return Err("Invalid UUID byte length");
    }

    let mut uuid_bytes = [0u8; 16];
    uuid_bytes.copy_from_slice(bytes);
    Ok(Uuid::from_bytes(uuid_bytes))
}

pub fn read_u64_le(bytes: &[u8], offset: usize) -> u64 {
    if offset + 8 > bytes.len() {
        return 0;
    }

    u64::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7],
    ])
}

pub fn get_preferred_locale(
    user_preferred_language: Option<Language>,
    accept_language: &axum::http::HeaderValue,
) -> String {
    match user_preferred_language {
        Some(lang) => match lang {
            Language::Ko => "ko".to_string(),
            Language::Ja => "ja".to_string(),
            Language::En => "en".to_string(),
            Language::Zh => "zh".to_string(),
        },
        None => {
            if let Ok(accept_language_str) = accept_language.to_str() {
                let requested = parse_accepted_languages(accept_language_str);
                let available = convert_vec_str_to_langids_lossy(["ko", "ja", "en", "zh"]);
                let default = "en".parse().expect("Failed to parse default langid.");

                let supported = negotiate_languages(
                    &requested,
                    &available,
                    Some(&default),
                    NegotiationStrategy::Filtering,
                );

                supported
                    .first()
                    .map(|lang| lang.language.as_str().to_string())
                    .unwrap_or_else(|| "en".to_string())
            } else {
                "en".to_string()
            }
        }
    }
}