//! Statement-wise execution of a compiled script, a port of `src/script_execution.cc`.
//!
//! The C++ execution runs the statements in a coroutine that suspends at every statement until the
//! host resumes it with the statement result. Here the coroutine is an explicit state machine: the
//! phase, the 1-based index of the current statement and the id of the pending statement. The
//! update protocol (`Start`, `Resume`, `Cancel` and their protocol errors) is the same.

use crate::catalog::PROTO_NULL_U32;
use crate::compiler::{compile, CompilationOptions};
use crate::script::TextVersion;
use crate::script_session::ScriptSession;
use dashql_buffers::execution::{
    CompiledScriptStatementKind, PendingStatementT, ScriptCompilationResultT, ScriptExecutionPhase as Phase,
    ScriptExecutionProtocolError as ProtocolError, ScriptExecutionSnapshotT, ScriptExecutionUpdateT,
    StatementResultStatus, StatementResultT,
};
use dashql_buffers::formatting::FormattingConfigT;

/// The execution of the statements of a script (`ScriptExecution`)
pub struct ScriptExecution {
    /// The text version of the compiled script
    text_version: TextVersion,
    /// The compiled script
    compilation: ScriptCompilationResultT,
    /// The id of the next pending statement
    next_pending_statement_id: u64,
    /// The 1-based index of the current statement, 0 before the start
    statement_index: u32,
    /// The index of the statement that produces the output
    output_statement_index: u32,
    phase: Phase,
    /// The error of a failed execution
    error: String,
    /// The id of the statement the host is executing
    pending_statement_id: Option<u64>,
}

/// A string the C++ object API leaves out when empty
fn non_empty_string(s: String) -> Option<String> {
    (!s.is_empty()).then_some(s)
}

impl ScriptExecution {
    /// Compile the current text of a session and capture the plan
    pub fn new(session: &mut ScriptSession, formatting_config: FormattingConfigT) -> Self {
        let text_version = session.text_version();
        let catalog = session.catalog().clone();
        let compilation =
            compile(session.script_mut(), &catalog.borrow(), &formatting_config, CompilationOptions::default());
        let mut output_statement_index = PROTO_NULL_U32;
        for (i, statement) in compilation.statements.iter().flatten().enumerate() {
            if statement.kind != CompiledScriptStatementKind::COMMAND {
                output_statement_index = i as u32;
            }
        }
        Self {
            text_version,
            compilation,
            next_pending_statement_id: 1,
            statement_index: 0,
            output_statement_index,
            phase: Phase::IDLE,
            error: String::new(),
            pending_statement_id: None,
        }
    }

    fn statement_count(&self) -> u32 {
        self.compilation.statements.as_ref().map_or(0, |s| s.len() as u32)
    }

    /// An update with the protocol status and a snapshot of the progress (`MakeUpdate`)
    fn make_update(&self, error: ProtocolError, message: &str) -> ScriptExecutionUpdateT {
        let mut snapshot = ScriptExecutionSnapshotT::default();
        snapshot.phase = self.phase;
        snapshot.text_version = self.text_version;
        snapshot.statement_index = self.statement_index;
        snapshot.statement_count = self.statement_count();
        snapshot.output_statement_index = self.output_statement_index;
        snapshot.error = non_empty_string(self.error.clone());
        let mut update = ScriptExecutionUpdateT::default();
        update.protocol_error = error;
        update.protocol_error_message = non_empty_string(message.to_string());
        update.snapshot = Some(Box::new(snapshot));
        update
    }

    /// Finish the execution (`Complete`)
    fn complete(&mut self, phase: Phase, error: String) -> ScriptExecutionUpdateT {
        self.phase = phase;
        self.error = error;
        self.make_update(ProtocolError::NONE, "")
    }

    /// Hand out the statement at `index` (0-based), or complete if all statements succeeded
    /// (the loop of `Run` up to its next suspension)
    fn run_from(&mut self, index: u32) -> ScriptExecutionUpdateT {
        let statement_count = self.statement_count();
        if index >= statement_count {
            return self.complete(Phase::SUCCEEDED, String::new());
        }
        self.statement_index = index + 1;
        let statement = &self.compilation.statements.as_ref().unwrap()[index as usize];
        let mut pending = PendingStatementT::default();
        pending.id = self.next_pending_statement_id;
        pending.source_statement_id = statement.statement_id;
        pending.index = self.statement_index;
        pending.statement_count = statement_count;
        pending.sql = statement.sql.clone().filter(|s| !s.is_empty());
        pending.produces_output = index == self.output_statement_index;
        self.next_pending_statement_id += 1;
        self.pending_statement_id = Some(pending.id);
        let mut update = self.make_update(ProtocolError::NONE, "");
        update.pending_statement = Some(Box::new(pending));
        update
    }

    /// Start the execution and return the first pending statement or the terminal update (`Start`)
    pub fn start(&mut self) -> ScriptExecutionUpdateT {
        if self.phase != Phase::IDLE || self.pending_statement_id.is_some() {
            return self.make_update(ProtocolError::BUSY, "the script execution has already started");
        }
        // Syntax errors can accompany a raw SQL pass-through plan. Other compiler errors leave no
        // executable SQL and stop the execution.
        let errors = self.compilation.errors.as_deref().unwrap_or(&[]);
        if !errors.is_empty() && self.compilation.sql.as_deref().unwrap_or("").is_empty() {
            let message = errors[0].message.clone().unwrap_or_default();
            return self.make_update(ProtocolError::INVALID_ARGUMENT, &message);
        }
        self.phase = Phase::RUNNING;
        self.run_from(0)
    }

    /// Resume with the result of the pending statement (`Resume`)
    pub fn resume(&mut self, result: &StatementResultT) -> ScriptExecutionUpdateT {
        if self.pending_statement_id != Some(result.pending_statement_id) {
            return self.make_update(ProtocolError::STALE_EFFECT, "statement is no longer pending");
        }
        if !matches!(
            result.status,
            StatementResultStatus::SUCCEEDED | StatementResultStatus::FAILED | StatementResultStatus::CANCELLED
        ) {
            return self.make_update(ProtocolError::INVALID_ARGUMENT, "invalid statement result status");
        }
        self.pending_statement_id = None;
        match result.status {
            StatementResultStatus::CANCELLED => self.complete(Phase::CANCELLED, String::new()),
            StatementResultStatus::FAILED => {
                let error = result
                    .error
                    .clone()
                    .filter(|e| !e.is_empty())
                    .unwrap_or_else(|| "statement execution failed".to_string());
                self.complete(Phase::FAILED, error)
            }
            _ => self.run_from(self.statement_index),
        }
    }

    /// Cancel the pending statement and the rest of the plan (`Cancel`)
    pub fn cancel(&mut self) -> ScriptExecutionUpdateT {
        let Some(id) = self.pending_statement_id else {
            return self.make_update(ProtocolError::NONE, "");
        };
        let mut result = StatementResultT::default();
        result.pending_statement_id = id;
        result.status = StatementResultStatus::CANCELLED;
        self.resume(&result)
    }
}
