//! Oracle function for batch processing (`tools/oracle_ffi_batch.cc`).

use crate::{take_bytes, OracleResult};

extern "C" {
    fn dashql_oracle_batch(request: *const u8, length: usize) -> OracleResult;
}

/// Process a batch request with the C++ core and return the BatchResult bytes
pub fn process_batch(request: &[u8]) -> Result<Vec<u8>, String> {
    // SAFETY: the oracle reads `length` bytes of the request and returns an unreleased result.
    unsafe { take_bytes(dashql_oracle_batch(request.as_ptr(), request.len())) }
}
