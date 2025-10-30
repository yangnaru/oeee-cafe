use serde::Serialize;

#[derive(Serialize, Debug)]
pub struct PaginationMeta {
    pub offset: i64,
    pub limit: i64,
    pub total: Option<i64>,
    pub has_more: bool,
}

#[derive(Serialize, Debug)]
pub struct PaginatedResponse<T> {
    pub items: Vec<T>,
    pub pagination: PaginationMeta,
}

#[derive(Serialize, Debug)]
pub struct ErrorResponse {
    pub error: ErrorDetail,
}

#[derive(Serialize, Debug)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
}

impl ErrorResponse {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            error: ErrorDetail {
                code: code.into(),
                message: message.into(),
            },
        }
    }
}
