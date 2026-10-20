//! Oracle function for the FlatBuffer packing of scripts (`tools/oracle_ffi_pack.cc`).

use crate::{take_bytes, OracleResult};
use std::os::raw::c_char;

extern "C" {
    fn dashql_oracle_pack(
        catalog_text: *const c_char,
        catalog_length: usize,
        text: *const c_char,
        length: usize,
        what: u32,
    ) -> OracleResult;
}

/// What to pack
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Packed {
    ScannedScript = 0,
    ParsedScript = 1,
    AnalyzedScript = 2,
}

/// Analyze a script with the C++ core, optionally against a catalog script, and return the
/// FlatBuffer of its scanned, parsed or analyzed script
pub fn pack(catalog: Option<&str>, text: &str, what: Packed) -> Result<Vec<u8>, String> {
    let (catalog_ptr, catalog_len) = match catalog {
        Some(c) => (c.as_ptr() as *const c_char, c.len()),
        None => (std::ptr::null(), 0),
    };
    // SAFETY: the oracle reads `length` bytes of the texts and returns an unreleased result.
    unsafe { take_bytes(dashql_oracle_pack(catalog_ptr, catalog_len, text.as_ptr() as *const c_char, text.len(), what as u32)) }
}
