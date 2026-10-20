//! Oracle function for the completion (`tools/oracle_ffi_completion.cc`).

use crate::{take_result, OracleResult};
use std::os::raw::c_char;

extern "C" {
    fn dashql_oracle_complete(
        catalog_text: *const c_char,
        catalog_length: usize,
        text: *const c_char,
        length: usize,
        cursor_offset: usize,
        limit: usize,
    ) -> OracleResult;
}

/// Complete at a cursor with the C++ core, optionally against a catalog script. Returns the YAML of
/// the `completions` node of the completion snapshots.
pub fn complete(catalog: Option<&str>, text: &str, cursor_offset: usize, limit: usize) -> Result<String, String> {
    let (catalog_ptr, catalog_len) = match catalog {
        Some(c) => (c.as_ptr() as *const c_char, c.len()),
        None => (std::ptr::null(), 0),
    };
    // SAFETY: the oracle reads `length` bytes of the texts and returns an unreleased result.
    unsafe {
        take_result(dashql_oracle_complete(
            catalog_ptr,
            catalog_len,
            text.as_ptr() as *const c_char,
            text.len(),
            cursor_offset,
            limit,
        ))
    }
}
