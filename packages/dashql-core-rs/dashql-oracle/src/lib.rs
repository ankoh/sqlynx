//! The C++ dashql-core as a differential test oracle.
//!
//! Links `//packages/dashql-core:oracle_ffi`, a C ABI over the C++ core that never throws and
//! answers in the serialization of the snapshot tests. Rust tests compare the Rust core against
//! it on arbitrary inputs, not only on the checked-in snapshots.

use std::os::raw::c_char;

#[repr(C)]
struct DashQLOracleResult {
    status: u32,
    data: *mut c_char,
    length: usize,
}

extern "C" {
    fn dashql_oracle_free(result: DashQLOracleResult);
    fn dashql_oracle_scan(text: *const c_char, length: usize) -> DashQLOracleResult;
    fn dashql_oracle_parse(text: *const c_char, length: usize) -> DashQLOracleResult;
}

fn call(f: unsafe extern "C" fn(*const c_char, usize) -> DashQLOracleResult, text: &str) -> Result<String, String> {
    // SAFETY: the oracle reads `length` bytes of `text`, and returns a buffer of `length` bytes
    // that stays valid until it is released with dashql_oracle_free.
    unsafe {
        let result = f(text.as_ptr() as *const c_char, text.len());
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
}

/// Scan a script with the C++ scanner.
///
/// Returns one line per symbol: `<kind> <offset> <length>`, followed by the name id for
/// identifiers. Symbol kinds are bison symbol kinds, see `dashql_grammar::symbol_kind`.
pub fn scan(text: &str) -> Result<String, String> {
    call(dashql_oracle_scan, text)
}

/// Scan and parse a script with the C++ parser.
///
/// Returns the YAML the parser snapshot tests expect under `expected`.
pub fn parse(text: &str) -> Result<String, String> {
    call(dashql_oracle_parse, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans() {
        // select, 1, EOF
        let tokens = scan("select 1").unwrap();
        let lines: Vec<&str> = tokens.lines().collect();
        assert_eq!(lines.len(), 3, "{tokens}");
        assert!(lines[0].ends_with(" 0 6"), "{tokens}");
        assert!(lines[1].ends_with(" 7 1"), "{tokens}");
        assert!(lines[2].starts_with("0 "), "{tokens}");
    }

    #[test]
    fn parses() {
        let yaml = parse("select 1").unwrap();
        assert!(yaml.contains("OBJECT_SQL_SELECT"), "{yaml}");
    }
}
