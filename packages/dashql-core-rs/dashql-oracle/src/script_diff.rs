//! Oracle functions for the port of the script diff (tools/oracle_ffi_script_diff.cc).

use crate::{take_result, OracleResult};
use std::os::raw::c_char;

extern "C" {
    fn dashql_oracle_script_diff(
        source: *const c_char,
        source_length: usize,
        target: *const c_char,
        target_length: usize,
    ) -> OracleResult;
}

/// Diff two scripts with the C++ core. Returns one line per op:
/// `<code> <source statement> <target statement> <source span> <target span> <change count> <changes...>`
pub fn script_diff(source: &str, target: &str) -> Result<String, String> {
    // SAFETY: the oracle reads the given number of bytes of both texts.
    unsafe {
        take_result(dashql_oracle_script_diff(
            source.as_ptr() as *const c_char,
            source.len(),
            target.as_ptr() as *const c_char,
            target.len(),
        ))
    }
}
