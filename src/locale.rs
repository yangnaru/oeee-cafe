use std::collections::HashMap;

use fluent::FluentResource;
use lazy_static::lazy_static;

lazy_static! {
    pub static ref LOCALES: HashMap<String, FluentResource> = {
        let mut locales = HashMap::new();
        locales.insert(
            "ko".to_string(),
            FluentResource::try_new(include_str!("../locales/ko.ftl").to_string()).unwrap(),
        );
        locales.insert(
            "ja".to_string(),
            FluentResource::try_new(include_str!("../locales/ja.ftl").to_string()).unwrap(),
        );
        locales.insert(
            "en".to_string(),
            FluentResource::try_new(include_str!("../locales/en.ftl").to_string()).unwrap(),
        );
        locales.insert(
            "zh".to_string(),
            FluentResource::try_new(include_str!("../locales/zh.ftl").to_string()).unwrap(),
        );
        locales
    };
}
