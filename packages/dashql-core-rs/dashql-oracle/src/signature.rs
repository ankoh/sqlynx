//! Oracle function for script signatures (`tools/oracle_ffi_signature.cc`).

use crate::{call, OracleResult};
use std::os::raw::c_char;

extern "C" {
    fn dashql_oracle_signature(text: *const c_char, length: usize) -> OracleResult;
}

/// Compute the signature of a script with the C++ core, or the status code name of the failure
pub fn signature(text: &str) -> Result<String, String> {
    call(dashql_oracle_signature, text)
}
