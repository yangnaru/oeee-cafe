// This file has been refactored into a module structure
// All functionality is now available through the collaborate module

pub mod db;
pub mod http_handlers;
pub mod messages;
pub mod types;
pub mod utils;
pub mod websocket;

// Re-export the public interface
pub use http_handlers::*;
pub use types::*;
pub use websocket::websocket_collaborate_handler;