use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, Serialize)]
pub struct ErrorItem {
    pub source: String,
    pub code: String,
    pub message: String,
}

impl ErrorItem {
    pub fn new(
        source: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            source: source.into(),
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ErrorItem {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

#[derive(Debug, Error)]
pub enum YceError {
    #[error("{0}")]
    InvalidArguments(String),
    #[error("{0}")]
    Configuration(String),
    #[error("{0}")]
    Tool(ErrorItem),
    #[error("{0}")]
    Internal(String),
}

impl YceError {
    pub fn tool(source: &str, code: &str, message: impl Into<String>) -> Self {
        Self::Tool(ErrorItem::new(source, code, message))
    }
}
