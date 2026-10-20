//! Oracle functions for editor sessions and script executions (`tools/oracle_ffi_session.cc`).
//!
//! The C++ objects are stateful: a catalog owns nothing, sessions borrow a catalog and executions
//! borrow a session. The wrappers keep the borrows in their lifetimes, so that sessions are deleted
//! before their catalog and executions before their session.

use crate::{take_bytes, OracleResult};
use std::ffi::c_void;
use std::marker::PhantomData;
use std::os::raw::c_char;

extern "C" {
    fn dashql_oracle_session_catalog_new() -> *mut c_void;
    fn dashql_oracle_session_catalog_delete(catalog: *mut c_void);
    fn dashql_oracle_session_catalog_version(catalog: *mut c_void) -> u64;
    fn dashql_oracle_session_new(catalog: *mut c_void, offset_unit: u8) -> *mut c_void;
    fn dashql_oracle_session_delete(session: *mut c_void);
    fn dashql_oracle_session_state(session: *mut c_void) -> OracleResult;
    fn dashql_oracle_session_apply(session: *mut c_void, event: *const u8, length: usize) -> OracleResult;
    fn dashql_oracle_session_replace_text(
        session: *mut c_void,
        expected: u64,
        text: *const c_char,
        length: usize,
    ) -> OracleResult;
    fn dashql_oracle_session_set_primary_cursor(session: *mut c_void, expected: u64, offset: u64) -> OracleResult;
    fn dashql_oracle_session_analyze(session: *mut c_void) -> OracleResult;
    fn dashql_oracle_session_complete(session: *mut c_void, limit: usize, keyword_case: u8) -> OracleResult;
    fn dashql_oracle_session_compile(
        session: *mut c_void,
        config: *const u8,
        config_length: usize,
        allow_extensions: u8,
        parse_if_outdated: u8,
    ) -> OracleResult;
    fn dashql_oracle_session_format(
        session: *mut c_void,
        config: *const u8,
        config_length: usize,
        parse_if_outdated: u8,
    ) -> OracleResult;
    fn dashql_oracle_session_is_fully_formattable(
        session: *mut c_void,
        config: *const u8,
        config_length: usize,
        parse_if_outdated: u8,
    ) -> OracleResult;
    fn dashql_oracle_session_rewrite_dashboard(
        session: *mut c_void,
        row: i32,
        column: i32,
        width: i32,
        height: i32,
        parse_if_outdated: u8,
    ) -> OracleResult;
    fn dashql_oracle_session_diff(session: *mut c_void, target: *const c_char, length: usize) -> OracleResult;
    fn dashql_oracle_session_load(session: *mut c_void, rank: u32) -> OracleResult;
    fn dashql_oracle_session_drop(session: *mut c_void);
    fn dashql_oracle_session_statement_text(session: *mut c_void, parse_if_outdated: u8) -> OracleResult;
    fn dashql_oracle_execution_new(session: *mut c_void, config: *const u8, config_length: usize) -> *mut c_void;
    fn dashql_oracle_execution_delete(execution: *mut c_void);
    fn dashql_oracle_execution_start(execution: *mut c_void) -> OracleResult;
    fn dashql_oracle_execution_resume(execution: *mut c_void, result: *const u8, length: usize) -> OracleResult;
    fn dashql_oracle_execution_cancel(execution: *mut c_void) -> OracleResult;
}

/// A C++ catalog
pub struct OracleCatalog(*mut c_void);

impl Default for OracleCatalog {
    fn default() -> Self {
        Self::new()
    }
}

impl OracleCatalog {
    pub fn new() -> Self {
        // SAFETY: returns a new catalog, deleted in drop
        Self(unsafe { dashql_oracle_session_catalog_new() })
    }

    pub fn version(&self) -> u64 {
        // SAFETY: the catalog is alive
        unsafe { dashql_oracle_session_catalog_version(self.0) }
    }

    /// Create a session (offset unit 0 = UTF-8 bytes, 1 = UTF-16 code units)
    pub fn session(&self, offset_unit: u8) -> OracleSession<'_> {
        // SAFETY: the catalog outlives the session through the lifetime
        OracleSession(unsafe { dashql_oracle_session_new(self.0, offset_unit) }, PhantomData)
    }
}

impl Drop for OracleCatalog {
    fn drop(&mut self) {
        // SAFETY: the sessions borrow the catalog and are gone
        unsafe { dashql_oracle_session_catalog_delete(self.0) }
    }
}

/// The text version, state revision, entry id and text of a session
#[derive(Debug, PartialEq, Eq)]
pub struct SessionState {
    pub text_version: u64,
    pub state_revision: u64,
    pub catalog_entry_id: u32,
    pub text: Vec<u8>,
}

/// A C++ script session
pub struct OracleSession<'c>(*mut c_void, PhantomData<&'c OracleCatalog>);

impl Drop for OracleSession<'_> {
    fn drop(&mut self) {
        // SAFETY: the executions borrow the session and are gone
        unsafe { dashql_oracle_session_delete(self.0) }
    }
}

/// Pass a byte slice
fn bytes(data: &[u8]) -> (*const u8, usize) {
    (data.as_ptr(), data.len())
}

impl<'c> OracleSession<'c> {
    pub fn state(&self) -> SessionState {
        // SAFETY: the session is alive, the result is unreleased
        let out = unsafe { take_bytes(dashql_oracle_session_state(self.0)) }.unwrap();
        SessionState {
            text_version: u64::from_le_bytes(out[0..8].try_into().unwrap()),
            state_revision: u64::from_le_bytes(out[8..16].try_into().unwrap()),
            catalog_entry_id: u32::from_le_bytes(out[16..20].try_into().unwrap()),
            text: out[20..].to_vec(),
        }
    }

    /// Apply a packed EditorEvent, returns the packed EditorUpdate
    pub fn apply(&mut self, event: &[u8]) -> Result<Vec<u8>, String> {
        let (ptr, len) = bytes(event);
        // SAFETY: the oracle reads `len` bytes and returns an unreleased result
        unsafe { take_bytes(dashql_oracle_session_apply(self.0, ptr, len)) }
    }

    pub fn replace_text(&mut self, expected_text_version: u64, text: &str) -> Result<Vec<u8>, String> {
        // SAFETY: as above
        unsafe {
            take_bytes(dashql_oracle_session_replace_text(
                self.0,
                expected_text_version,
                text.as_ptr() as *const c_char,
                text.len(),
            ))
        }
    }

    pub fn set_primary_cursor(&mut self, expected_text_version: u64, offset: u64) -> Result<Vec<u8>, String> {
        // SAFETY: as above
        unsafe { take_bytes(dashql_oracle_session_set_primary_cursor(self.0, expected_text_version, offset)) }
    }

    pub fn analyze(&mut self) -> Result<Vec<u8>, String> {
        // SAFETY: as above
        unsafe { take_bytes(dashql_oracle_session_analyze(self.0)) }
    }

    /// Complete at the cursor, returns the packed Completion
    pub fn complete(&mut self, limit: usize, keyword_case: u8) -> Result<Vec<u8>, String> {
        // SAFETY: as above
        unsafe { take_bytes(dashql_oracle_session_complete(self.0, limit, keyword_case)) }
    }

    /// Compile with a packed FormattingConfig, returns the packed ScriptCompilationResult
    pub fn compile(
        &mut self,
        config: &[u8],
        allow_extensions: bool,
        parse_if_outdated: bool,
    ) -> Result<Vec<u8>, String> {
        let (ptr, len) = bytes(config);
        // SAFETY: as above
        unsafe {
            take_bytes(dashql_oracle_session_compile(self.0, ptr, len, allow_extensions as u8, parse_if_outdated as u8))
        }
    }

    /// Format with a packed FormattingConfig, returns the entry id and the text of the new script
    pub fn format(&mut self, config: &[u8], parse_if_outdated: bool) -> Result<(u32, Vec<u8>), String> {
        let (ptr, len) = bytes(config);
        // SAFETY: as above
        let out = unsafe { take_bytes(dashql_oracle_session_format(self.0, ptr, len, parse_if_outdated as u8)) }?;
        Ok((u32::from_le_bytes(out[0..4].try_into().unwrap()), out[4..].to_vec()))
    }

    pub fn is_fully_formattable(&mut self, config: &[u8], parse_if_outdated: bool) -> Result<bool, String> {
        let (ptr, len) = bytes(config);
        // SAFETY: as above
        let out = unsafe {
            take_bytes(dashql_oracle_session_is_fully_formattable(self.0, ptr, len, parse_if_outdated as u8))
        }?;
        Ok(out == b"1")
    }

    /// Rewrite the dashboard clause, None is passed as -1
    pub fn rewrite_dashboard(
        &mut self,
        row: Option<i32>,
        column: Option<i32>,
        width: i32,
        height: i32,
        parse_if_outdated: bool,
    ) -> Result<Vec<u8>, String> {
        // SAFETY: as above
        unsafe {
            take_bytes(dashql_oracle_session_rewrite_dashboard(
                self.0,
                row.unwrap_or(-1),
                column.unwrap_or(-1),
                width,
                height,
                parse_if_outdated as u8,
            ))
        }
    }

    /// Diff against a new parsed script, returns the packed ScriptDiff
    pub fn diff(&mut self, target: &str) -> Result<Vec<u8>, String> {
        // SAFETY: as above
        unsafe { take_bytes(dashql_oracle_session_diff(self.0, target.as_ptr() as *const c_char, target.len())) }
    }

    pub fn load_into_catalog(&mut self, rank: u32) -> Result<(), String> {
        // SAFETY: as above
        unsafe { take_bytes(dashql_oracle_session_load(self.0, rank)) }.map(|_| ())
    }

    pub fn drop_from_catalog(&mut self) {
        // SAFETY: the session is alive
        unsafe { dashql_oracle_session_drop(self.0) }
    }

    pub fn statement_text(&mut self, parse_if_outdated: bool) -> Result<Vec<u8>, String> {
        // SAFETY: as above
        unsafe { take_bytes(dashql_oracle_session_statement_text(self.0, parse_if_outdated as u8)) }
    }

    /// Create an execution with a packed FormattingConfig
    pub fn execution<'s>(&'s mut self, config: &[u8]) -> Option<OracleExecution<'s>> {
        let (ptr, len) = bytes(config);
        // SAFETY: the session outlives the execution through the lifetime
        let execution = unsafe { dashql_oracle_execution_new(self.0, ptr, len) };
        (!execution.is_null()).then_some(OracleExecution(execution, PhantomData))
    }
}

/// A C++ script execution
pub struct OracleExecution<'s>(*mut c_void, PhantomData<&'s mut ()>);

impl Drop for OracleExecution<'_> {
    fn drop(&mut self) {
        // SAFETY: the execution is alive
        unsafe { dashql_oracle_execution_delete(self.0) }
    }
}

impl OracleExecution<'_> {
    pub fn start(&mut self) -> Result<Vec<u8>, String> {
        // SAFETY: as above
        unsafe { take_bytes(dashql_oracle_execution_start(self.0)) }
    }

    /// Resume with a packed StatementResult
    pub fn resume(&mut self, result: &[u8]) -> Result<Vec<u8>, String> {
        let (ptr, len) = bytes(result);
        // SAFETY: as above
        unsafe { take_bytes(dashql_oracle_execution_resume(self.0, ptr, len)) }
    }

    pub fn cancel(&mut self) -> Result<Vec<u8>, String> {
        // SAFETY: as above
        unsafe { take_bytes(dashql_oracle_execution_cancel(self.0)) }
    }
}
