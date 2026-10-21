//! Errors of the core (`include/dashql/exception.h`).

use dashql_buffers::status::StatusCode;
use std::fmt;

/// An error, either a status code of the C++ `dashql::Exception` or an invalid argument
#[derive(Clone, Debug, PartialEq)]
pub struct Error {
    /// The status code, None for invalid arguments (`std::invalid_argument`)
    pub status: Option<StatusCode>,
    /// The error message, the variant name of the status code for status errors
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

    /// The message that `what()` of the C++ exception returns: the default message of the status
    /// code (`Exception::GetDefaultMessage`), or the message of other errors
    pub fn what(&self) -> &str {
        match self.status {
            Some(status) => default_message(status),
            None => &self.message,
        }
    }
}

/// The default message of a status code (`Exception::GetDefaultMessage`)
pub fn default_message(status: StatusCode) -> &'static str {
    match status {
        StatusCode::CATALOG_NULL => "Catalog is null",
        StatusCode::CATALOG_MISMATCH => "Catalog is not matching",
        StatusCode::CATALOG_ID_OUT_OF_SYNC => "Catalog id is out of sync",
        StatusCode::SCRIPT_NOT_PARSED => "Script is not parsed",
        StatusCode::SCRIPT_NOT_ANALYZED => "Script is not analyzed",
        StatusCode::SCRIPT_BUSY => "Script has an active asynchronous analysis job",
        StatusCode::CATALOG_SCRIPT_NOT_ANALYZED => "Unanalyzed scripts cannot be added to the catalog",
        StatusCode::CATALOG_SCRIPT_UNKNOWN => "Script is missing in catalog",
        StatusCode::CATALOG_DESCRIPTOR_POOL_UNKNOWN => "Schema descriptor pool is not known",
        StatusCode::CATALOG_DESCRIPTOR_TABLES_NULL => "Schema descriptor field `tables` is null or empty",
        StatusCode::CATALOG_DESCRIPTOR_TABLE_NAME_EMPTY => "Table name in schema descriptor is null or empty",
        StatusCode::CATALOG_DESCRIPTOR_TABLE_NAME_COLLISION => "Schema descriptor contains a duplicate table name",
        StatusCode::COMPLETION_MISSES_CURSOR => "Completion requires a script cursor",
        StatusCode::COMPLETION_MISSES_SCANNER_TOKEN => "Completion requires a scanner token",
        StatusCode::COMPLETION_STATE_INCOMPATIBLE => "Completion state is incompatible",
        StatusCode::COMPLETION_STRATEGY_UNKNOWN => "Completion strategy is unknown",
        StatusCode::COMPLETION_WITHOUT_CONTINUATION => "Completion has no continuation",
        StatusCode::COMPLETION_CANDIDATE_INVALID => "Completion candidate is invalid",
        StatusCode::COMPLETION_CATALOG_OBJECT_INVALID => "Completion catalog object is invalid",
        StatusCode::COMPLETION_TEMPLATE_INVALID => "Completion template is invalid",
        StatusCode::EXTERNAL_ID_COLLISION => "Collision on external identifier",
        StatusCode::VIEWMODEL_INPUT_JSON_PARSER_ERROR => "Failed to parse JSON for ViewModel",
        StatusCode::OK => "",
        _ => "Unknown error",
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}
