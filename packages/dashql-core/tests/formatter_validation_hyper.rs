//! Executes the formatted SQL of the formatter snapshots in Hyper.
//!
//! Every formatter case with a `hyper` validation block gets a fresh database: the setup script runs
//! first, then the formatted output of every expectation of the dialect, split into statements at
//! top-level semicolons. The formatted output must equal the snapshot before it runs.
//!
//! Hyper ships only a C++ SDK, `//packages/hyper-api:hyper_ffi` is a C ABI over it.

use dashql_core::formatter::{formatting_mode_to_string, Formatter};
use dashql_grammar::parser::parse;
use dashql_grammar::scanner::scan;
use dashql_snapshots::formatter::{load_formatter_cases, DialectExpectations};
use dashql_snapshots::{run, Arguments, Failed, Trial};
use std::ffi::{c_char, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

#[repr(C)]
struct DashQLHyperProcess {
    _private: [u8; 0],
}

#[repr(C)]
struct DashQLHyperConnection {
    _private: [u8; 0],
}

extern "C" {
    fn dashql_hyper_process_start(
        hyper_path: *const c_char,
        user_agent: *const c_char,
        parameter_names: *const *const c_char,
        parameter_values: *const *const c_char,
        parameter_count: usize,
        error: *mut *mut c_char,
    ) -> *mut DashQLHyperProcess;
    fn dashql_hyper_process_stop(process: *mut DashQLHyperProcess);
    fn dashql_hyper_connect(
        process: *mut DashQLHyperProcess,
        database_path: *const c_char,
        error: *mut *mut c_char,
    ) -> *mut DashQLHyperConnection;
    fn dashql_hyper_disconnect(connection: *mut DashQLHyperConnection);
    fn dashql_hyper_execute_command(
        connection: *mut DashQLHyperConnection,
        command: *const c_char,
        length: usize,
    ) -> *mut c_char;
    fn dashql_hyper_free_error(error: *mut c_char);
}

/// Take an error text of the shim, `None` for null
///
/// # Safety
/// `error` must be null or an unreleased error text of the shim.
unsafe fn take_error(error: *mut c_char) -> Option<String> {
    if error.is_null() {
        return None;
    }
    let text = CStr::from_ptr(error).to_string_lossy().into_owned();
    dashql_hyper_free_error(error);
    Some(text)
}

/// A running Hyper process
struct HyperProcess(*mut DashQLHyperProcess);

// SAFETY: the process is only used to read its endpoint when connecting.
unsafe impl Send for HyperProcess {}
unsafe impl Sync for HyperProcess {}

impl HyperProcess {
    fn start(hyper_path: &Path, user_agent: &str, parameters: &[(&str, &str)]) -> Result<Self, String> {
        let hyper_path = CString::new(hyper_path.to_string_lossy().as_bytes()).unwrap();
        let user_agent = CString::new(user_agent).unwrap();
        let names: Vec<CString> = parameters.iter().map(|(k, _)| CString::new(*k).unwrap()).collect();
        let values: Vec<CString> = parameters.iter().map(|(_, v)| CString::new(*v).unwrap()).collect();
        let name_ptrs: Vec<*const c_char> = names.iter().map(|s| s.as_ptr()).collect();
        let value_ptrs: Vec<*const c_char> = values.iter().map(|s| s.as_ptr()).collect();
        let mut error = std::ptr::null_mut();
        // SAFETY: all strings are NUL-terminated and outlive the call.
        let process = unsafe {
            dashql_hyper_process_start(
                hyper_path.as_ptr(),
                user_agent.as_ptr(),
                name_ptrs.as_ptr(),
                value_ptrs.as_ptr(),
                parameters.len(),
                &mut error,
            )
        };
        // SAFETY: the error is null or an unreleased error text.
        match unsafe { take_error(error) } {
            Some(error) => Err(error),
            None => Ok(HyperProcess(process)),
        }
    }

    /// Connect to a database, creating or replacing it
    fn connect(&self, database_path: &Path) -> Result<HyperConnection, String> {
        let path = CString::new(database_path.to_string_lossy().as_bytes()).unwrap();
        let mut error = std::ptr::null_mut();
        // SAFETY: the process is running and the path is NUL-terminated.
        let connection = unsafe { dashql_hyper_connect(self.0, path.as_ptr(), &mut error) };
        // SAFETY: the error is null or an unreleased error text.
        match unsafe { take_error(error) } {
            Some(error) => Err(error),
            None => Ok(HyperConnection(connection)),
        }
    }
}

impl Drop for HyperProcess {
    fn drop(&mut self) {
        // SAFETY: the process was started by the shim and all connections are closed.
        unsafe { dashql_hyper_process_stop(self.0) }
    }
}

/// A connection to a Hyper database
struct HyperConnection(*mut DashQLHyperConnection);

impl HyperConnection {
    fn execute_command(&mut self, command: &str) -> Result<(), String> {
        // SAFETY: the connection is open and the shim reads `len` bytes of the command.
        match unsafe {
            take_error(dashql_hyper_execute_command(self.0, command.as_ptr() as *const c_char, command.len()))
        } {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// Execute a script statement by statement.
    ///
    /// Splits at semicolons outside of quotes and comments. Statements are trimmed, blank ones are
    /// skipped.
    fn execute_script(&mut self, script: &str) -> Result<(), String> {
        let bytes = script.as_bytes();
        let mut statement_begin = 0;
        let mut quote = 0u8;
        let mut line_comment = false;
        let mut block_comment_depth = 0usize;

        let execute_statement = |connection: &mut Self, begin: usize, end: usize| {
            let statement = script[begin..end].trim_matches([' ', '\t', '\r', '\n']);
            if statement.is_empty() {
                return Ok(());
            }
            connection.execute_command(statement)
        };

        let mut i = 0;
        while i < bytes.len() {
            let current = bytes[i];
            let next = bytes.get(i + 1).copied().unwrap_or(0);
            if line_comment {
                if current == b'\n' {
                    line_comment = false;
                }
            } else if block_comment_depth > 0 {
                if current == b'/' && next == b'*' {
                    block_comment_depth += 1;
                    i += 1;
                } else if current == b'*' && next == b'/' {
                    block_comment_depth -= 1;
                    i += 1;
                }
            } else if quote != 0 {
                if current == quote {
                    if next == quote {
                        i += 1;
                    } else {
                        quote = 0;
                    }
                }
            } else if current == b'-' && next == b'-' {
                line_comment = true;
                i += 1;
            } else if current == b'/' && next == b'*' {
                block_comment_depth = 1;
                i += 1;
            } else if current == b'\'' || current == b'"' {
                quote = current;
            } else if current == b';' {
                execute_statement(self, statement_begin, i)?;
                statement_begin = i + 1;
            }
            i += 1;
        }
        execute_statement(self, statement_begin, bytes.len())
    }
}

impl Drop for HyperConnection {
    fn drop(&mut self) {
        // SAFETY: the connection was opened by the shim.
        unsafe { dashql_hyper_disconnect(self.0) }
    }
}

/// The Hyper process shared by all cases, started on first use
fn hyper_process(process: &OnceLock<HyperProcess>) -> &HyperProcess {
    process.get_or_init(|| {
        let hyperd = std::env::var_os("HYPERD_BINARY").expect("HYPERD_BINARY is not set");
        let hyper_path = Path::new(&hyperd).parent().expect("HYPERD_BINARY has no parent directory");
        HyperProcess::start(
            hyper_path,
            "dashql-formatter-validation",
            &[("default_database_version", "4"), ("enable_row_types", "true"), ("log_config", "")],
        )
        .unwrap_or_else(|e| panic!("cannot start Hyper: {e}"))
    })
}

/// A database file in a directory of its own, removed with the directory
struct TemporaryDatabase {
    path: PathBuf,
}

impl TemporaryDatabase {
    fn new(name: &str) -> Self {
        let tmpdir = std::env::var_os("TEST_TMPDIR").expect("TEST_TMPDIR is not set");
        let directory = Path::new(&tmpdir).join(name);
        std::fs::create_dir_all(&directory).unwrap_or_else(|e| panic!("cannot create {}: {e}", directory.display()));
        TemporaryDatabase { path: directory.join("memory.hyper") }
    }
}

impl Drop for TemporaryDatabase {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.path.parent().unwrap());
    }
}

fn check(
    process: &OnceLock<HyperProcess>,
    database_name: &str,
    input: &str,
    dialects: &[DialectExpectations],
) -> Result<(), String> {
    let parsed = parse(Arc::new(scan(input, 0, 2)));
    let mut formatter = Formatter::new(&parsed);
    for dialect in dialects.iter().filter(|d| !d.skip) {
        let Some(validation) = dialect.validation.as_ref().filter(|_| dialect.dialect == "hyper") else { continue };
        let database = TemporaryDatabase::new(database_name);
        let setup_failed = |e: String| format!("Dialect {}: Hyper setup failed: {e}", dialect.dialect);
        let mut connection = hyper_process(process).connect(&database.path).map_err(setup_failed)?;
        connection.execute_script(&validation.setup).map_err(setup_failed)?;

        for (i, expectation) in dialect.expectations.iter().enumerate() {
            let label = format!(
                "Dialect {} expectation {} (mode={})",
                dialect.dialect,
                i,
                formatting_mode_to_string(expectation.config.mode)
            );
            let formatted = formatter.format(&expectation.config);
            if formatted.is_empty() {
                return Err(format!("{label}: output must not be empty"));
            }
            if formatted != expectation.formatted {
                return Err(format!("{label}\nexpected:\n{}\nactual:\n{formatted}", expectation.formatted));
            }
            connection.execute_script(&formatted).map_err(|e| format!("{label}: Hyper execution failed: {e}"))?;
        }
    }
    Ok(())
}

fn main() {
    let args = Arguments::from_args();
    let cases = load_formatter_cases().unwrap_or_else(|e| panic!("cannot load formatter snapshots: {e}"));
    let process = Arc::new(OnceLock::new());
    let mut trials = Vec::new();
    for case in cases.into_iter().filter(|c| c.validation("hyper").is_some()) {
        let process = process.clone();
        let database_name = format!("{}.{}", case.case.file, case.case.name);
        trials.push(Trial::test(case.case.trial_name(), move || {
            check(&process, &database_name, &case.input, &case.dialects).map_err(Failed::from)
        }));
    }
    println!("{} formatter cases with a hyper validation", trials.len());
    let conclusion = run(&args, trials);
    // The trials are dropped, stop Hyper before exiting
    drop(Arc::try_unwrap(process).ok().and_then(OnceLock::into_inner));
    conclusion.exit();
}
