//! Oracle functions for the analyzer port (`tools/oracle_ffi_analyzer.cc`).

use crate::{take_result, OracleResult};
use std::os::raw::c_char;

extern "C" {
    fn dashql_oracle_analyze(
        catalog_text: *const c_char,
        catalog_length: usize,
        text: *const c_char,
        length: usize,
    ) -> OracleResult;
}

/// Analyze a script with the C++ analyzer, optionally against a catalog script, like the analyzer
/// snapshot test does. Returns YAML with the keys `catalog` (if any) and `script`.
pub fn analyze(catalog: Option<&str>, text: &str) -> Result<String, String> {
    let (catalog_ptr, catalog_len) = match catalog {
        Some(c) => (c.as_ptr() as *const c_char, c.len()),
        None => (std::ptr::null(), 0),
    };
    // SAFETY: the oracle reads `length` bytes of the texts and returns an unreleased result.
    unsafe { take_result(dashql_oracle_analyze(catalog_ptr, catalog_len, text.as_ptr() as *const c_char, text.len())) }
}
