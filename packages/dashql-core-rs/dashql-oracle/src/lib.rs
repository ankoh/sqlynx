//! The C++ dashql-core as a differential test oracle.
//!
//! Links `//packages/dashql-core:oracle_ffi`, a C ABI over the C++ core that never throws and
//! answers in the serialization of the snapshot tests. Rust tests compare the Rust core against
//! it on arbitrary inputs, not only on the checked-in snapshots.

pub mod analyzer;
pub mod completion;
pub mod formatter;
pub mod pack;
pub mod script_diff;
pub mod signature;
pub mod view;

use std::os::raw::c_char;

/// The result of an oracle call (`DashQLOracleResult` in tools/oracle_ffi.cc)
#[repr(C)]
pub struct OracleResult {
    status: u32,
    data: *mut c_char,
    length: usize,
}

extern "C" {
    fn dashql_oracle_free(result: OracleResult);
    fn dashql_oracle_scan(text: *const c_char, length: usize) -> OracleResult;
    fn dashql_oracle_parse(text: *const c_char, length: usize) -> OracleResult;
    fn dashql_oracle_parse_raw(text: *const c_char, length: usize) -> OracleResult;
}

/// Take the output of an oracle call: Ok for status 0, Err with the message otherwise
///
/// # Safety
/// `result` must be returned by an oracle function and not be released yet.
pub unsafe fn take_result(result: OracleResult) -> Result<String, String> {
    let bytes = std::slice::from_raw_parts(result.data as *const u8, result.length);
    let out = String::from_utf8_lossy(bytes).into_owned();
    let status = result.status;
    dashql_oracle_free(result);
    if status == 0 {
        Ok(out)
    } else {
        Err(out)
    }
}

/// Call an oracle function that takes a text
pub fn call(f: unsafe extern "C" fn(*const c_char, usize) -> OracleResult, text: &str) -> Result<String, String> {
    // SAFETY: the oracle reads `length` bytes of `text` and returns an unreleased result.
    unsafe { take_result(f(text.as_ptr() as *const c_char, text.len())) }
}

/// Scan a script with the C++ scanner.
///
/// Returns the complete scanner output, one record per line (see `dashql_oracle_scan` in
/// `packages/dashql-core/tools/oracle_ffi.cc`). Symbol kinds are bison symbol kinds, see
/// `dashql_grammar::symbol_kind`.
pub fn scan(text: &str) -> Result<String, String> {
    call(dashql_oracle_scan, text)
}

/// Scan and parse a script with the C++ parser.
///
/// Returns the YAML the parser snapshot tests expect under `expected`.
pub fn parse(text: &str) -> Result<String, String> {
    call(dashql_oracle_parse, text)
}

/// Scan and parse a script with the C++ parser.
///
/// Returns the raw parser output, one record per line (see `dashql_oracle_parse_raw` in
/// `packages/dashql-core/tools/oracle_ffi.cc`).
pub fn parse_raw(text: &str) -> Result<String, String> {
    call(dashql_oracle_parse_raw, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans() {
        // select, 1, EOF
        let out = scan("select 1").unwrap();
        let tokens: Vec<&str> = out.lines().filter(|l| l.starts_with("T ")).collect();
        assert_eq!(tokens.len(), 3, "{out}");
        assert!(tokens[0].ends_with(" 0 6 6:select"), "{out}");
        assert!(tokens[1].ends_with(" 7 1"), "{out}");
        assert!(tokens[2].starts_with("T 0 "), "{out}");
    }

    #[test]
    fn parses() {
        let yaml = parse("select 1").unwrap();
        assert!(yaml.contains("OBJECT_SQL_SELECT"), "{yaml}");
    }
}

/// Take the bytes of an oracle call: Ok for status 0, Err with the message otherwise
///
/// # Safety
/// `result` must be returned by an oracle function and not be released yet.
pub unsafe fn take_bytes(result: OracleResult) -> Result<Vec<u8>, String> {
    let bytes = std::slice::from_raw_parts(result.data as *const u8, result.length).to_vec();
    let status = result.status;
    crate::dashql_oracle_free(result);
    if status == 0 {
        Ok(bytes)
    } else {
        Err(String::from_utf8_lossy(&bytes).into_owned())
    }
}
