//! Oracle function for the script compiler (`tools/oracle_ffi_compiler.cc`).

use crate::{take_bytes, OracleResult};
use std::os::raw::c_char;

extern "C" {
    fn dashql_oracle_compile(
        catalog_text: *const c_char,
        catalog_length: usize,
        text: *const c_char,
        length: usize,
        analyze: u8,
        allow_extensions: u8,
    ) -> OracleResult;
}

/// Compile a script with the C++ core and return the packed ScriptCompilationResult
pub fn compile(catalog: Option<&str>, text: &str, analyze: bool, allow_extensions: bool) -> Result<Vec<u8>, String> {
    let (catalog_ptr, catalog_len) = match catalog {
        Some(c) => (c.as_ptr() as *const c_char, c.len()),
        None => (std::ptr::null(), 0),
    };
    // SAFETY: the oracle reads `length` bytes of the texts and returns an unreleased result.
    unsafe {
        take_bytes(dashql_oracle_compile(
            catalog_ptr,
            catalog_len,
            text.as_ptr() as *const c_char,
            text.len(),
            analyze as u8,
            allow_extensions as u8,
        ))
    }
}
