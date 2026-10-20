//! Errors of the core (`include/dashql/exception.h`).

use dashql_buffers::status::StatusCode;
use std::fmt;

/// An error, either a status code of the C++ `dashql::Exception` or an invalid argument
#[derive(Clone, Debug, PartialEq)]
pub struct Error {
    /// The status code, None for invalid arguments (`std::invalid_argument`)
    pub status: Option<StatusCode>,
    pub message: String,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn status(status: StatusCode) -> Self {
        Self {
            status: Some(status),
            message: status.variant_name().unwrap_or("").to_string(),
        }
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self {
            status: None,
            message: message.into(),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}
