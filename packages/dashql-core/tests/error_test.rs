//! Tests of the errors of the core: status errors carry the variant name as message and the default
//! message of the C++ exception as `what()`, other errors carry their own message.

use dashql_buffers::status::StatusCode;
use dashql_core::error::{default_message, Error};

#[test]
fn status_errors_carry_the_variant_name() {
    let error = Error::status(StatusCode::SCRIPT_NOT_PARSED);
    assert_eq!(error.status, Some(StatusCode::SCRIPT_NOT_PARSED));
    assert_eq!(error.message, "SCRIPT_NOT_PARSED");
    assert_eq!(error.to_string(), "SCRIPT_NOT_PARSED");
    assert_eq!(error.what(), "Script is not parsed");
}

#[test]
fn invalid_arguments_carry_their_message() {
    let error = Error::invalid_argument("bad input");
    assert_eq!(error.status, None);
    assert_eq!(error.message, "bad input");
    assert_eq!(error.to_string(), "bad input");
    assert_eq!(error.what(), "bad input");
    let _: &dyn std::error::Error = &error;
}

#[test]
fn unknown_status_codes_have_no_variant_name() {
    let error = Error::status(StatusCode(200));
    assert_eq!(error.message, "");
    assert_eq!(error.what(), "Unknown error");
}

#[test]
fn every_status_code_has_a_default_message() {
    let expected = [
        (StatusCode::OK, ""),
        (StatusCode::CATALOG_NULL, "Catalog is null"),
        (StatusCode::CATALOG_MISMATCH, "Catalog is not matching"),
        (StatusCode::CATALOG_ID_OUT_OF_SYNC, "Catalog id is out of sync"),
        (StatusCode::CATALOG_SCRIPT_NOT_ANALYZED, "Unanalyzed scripts cannot be added to the catalog"),
        (StatusCode::CATALOG_SCRIPT_UNKNOWN, "Script is missing in catalog"),
        (StatusCode::CATALOG_DESCRIPTOR_POOL_UNKNOWN, "Schema descriptor pool is not known"),
        (StatusCode::CATALOG_DESCRIPTOR_TABLES_NULL, "Schema descriptor field `tables` is null or empty"),
        (StatusCode::CATALOG_DESCRIPTOR_TABLE_NAME_EMPTY, "Table name in schema descriptor is null or empty"),
        (StatusCode::CATALOG_DESCRIPTOR_TABLE_NAME_COLLISION, "Schema descriptor contains a duplicate table name"),
        (StatusCode::SCRIPT_NOT_PARSED, "Script is not parsed"),
        (StatusCode::SCRIPT_NOT_ANALYZED, "Script is not analyzed"),
        (StatusCode::SCRIPT_BUSY, "Script has an active asynchronous analysis job"),
        (StatusCode::EXTERNAL_ID_COLLISION, "Collision on external identifier"),
        (StatusCode::COMPLETION_MISSES_CURSOR, "Completion requires a script cursor"),
        (StatusCode::COMPLETION_MISSES_SCANNER_TOKEN, "Completion requires a scanner token"),
        (StatusCode::COMPLETION_STATE_INCOMPATIBLE, "Completion state is incompatible"),
        (StatusCode::COMPLETION_STRATEGY_UNKNOWN, "Completion strategy is unknown"),
        (StatusCode::COMPLETION_WITHOUT_CONTINUATION, "Completion has no continuation"),
        (StatusCode::COMPLETION_CANDIDATE_INVALID, "Completion candidate is invalid"),
        (StatusCode::COMPLETION_CATALOG_OBJECT_INVALID, "Completion catalog object is invalid"),
        (StatusCode::COMPLETION_TEMPLATE_INVALID, "Completion template is invalid"),
        (StatusCode::VIEWMODEL_INPUT_JSON_PARSER_ERROR, "Failed to parse JSON for ViewModel"),
    ];
    // The table covers every code of the schema
    assert_eq!(expected.len(), StatusCode::ENUM_VALUES.len());
    for (code, message) in expected {
        assert_eq!(default_message(code), message, "{code:?}");
        assert_eq!(Error::status(code).what(), message, "{code:?}");
    }
}
