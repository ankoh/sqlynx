//! A port of the C++ `test/script_execution_test.cc` and the execution part of
//! `ApiTest.SessionAndExecutionExpose64BitTextVersions`.

use dashql_buffers::editor::EditorOffsetUnit;
use dashql_buffers::execution::{
    ScriptExecutionPhase, ScriptExecutionProtocolError, StatementResultStatus, StatementResultT,
};
use dashql_buffers::formatting::{FormattingConfigT, FormattingDialect, FormattingMode};
use dashql_core::catalog::Catalog;
use dashql_core::script_execution::ScriptExecution;
use dashql_core::script_session::ScriptSession;
use std::cell::RefCell;
use std::rc::Rc;

fn execution_config() -> FormattingConfigT {
    let mut config = FormattingConfigT::default();
    config.mode = FormattingMode::INLINE;
    config.dialect = FormattingDialect::HYPER;
    config
}

fn session_with(text: &str) -> ScriptSession {
    let catalog = Rc::new(RefCell::new(Catalog::new()));
    let mut session = ScriptSession::new(catalog, EditorOffsetUnit::UTF8_BYTES).unwrap();
    session.replace_text(0, text);
    session
}

fn result(pending_statement_id: u64, status: StatementResultStatus, error: Option<&str>) -> StatementResultT {
    let mut result = StatementResultT::default();
    result.pending_statement_id = pending_statement_id;
    result.status = status;
    result.error = error.map(str::to_string);
    result
}

#[test]
fn steers_statements_in_order() {
    let mut session = session_with("create table t (v int); insert into t values (1); select * from t;");
    let mut execution = ScriptExecution::new(&mut session, execution_config());

    let mut operation = execution.start();
    assert_eq!(operation.protocol_error, ScriptExecutionProtocolError::NONE);
    let pending = operation.pending_statement.as_ref().unwrap();
    assert_eq!(pending.index, 1);
    assert_eq!(pending.statement_count, 3);
    assert!(!pending.produces_output);
    assert_eq!(pending.sql.as_deref(), Some("create table t (v int)"));

    for index in 2..=3 {
        let id = operation.pending_statement.as_ref().unwrap().id;
        operation = execution.resume(&result(id, StatementResultStatus::SUCCEEDED, None));
        let pending = operation.pending_statement.as_ref().unwrap();
        assert_eq!(pending.index, index);
        if index == 2 {
            assert_eq!(pending.sql.as_deref(), Some("insert into t values (1)"));
        }
    }
    let pending = operation.pending_statement.as_ref().unwrap();
    assert!(pending.produces_output);
    assert_eq!(pending.sql.as_deref(), Some("select * from t"));

    let operation = execution.resume(&result(pending.id, StatementResultStatus::SUCCEEDED, None));
    assert_eq!(operation.snapshot.as_ref().unwrap().phase, ScriptExecutionPhase::SUCCEEDED);
    assert!(operation.pending_statement.is_none());
}

#[test]
fn stops_after_statement_error() {
    let mut session = session_with("set x = 1; select 1");
    let mut execution = ScriptExecution::new(&mut session, execution_config());
    let operation = execution.start();
    let id = operation.pending_statement.as_ref().unwrap().id;
    let operation = execution.resume(&result(id, StatementResultStatus::FAILED, Some("nope")));

    let snapshot = operation.snapshot.as_ref().unwrap();
    assert_eq!(snapshot.phase, ScriptExecutionPhase::FAILED);
    assert_eq!(snapshot.error.as_deref(), Some("nope"));
    assert!(operation.pending_statement.is_none());
}

#[test]
fn captures_immutable_64bit_text_version() {
    let catalog = Rc::new(RefCell::new(Catalog::new()));
    let mut session = ScriptSession::new(catalog, EditorOffsetUnit::UTF8_BYTES).unwrap();
    let version = (1u64 << 32) + 42;
    session.script_mut().set_text_version(version - 1);
    session.script_mut().replace_text("select 1");
    let mut execution = ScriptExecution::new(&mut session, execution_config());
    session.script_mut().replace_text("select 2");

    let update = execution.start();
    assert_eq!(update.snapshot.as_ref().unwrap().text_version, version);
    let pending = update.pending_statement.as_ref().unwrap();
    assert_eq!(pending.sql.as_deref(), Some("select 1"));
    assert_eq!(session.text_version(), version + 1);

    let update = execution.resume(&result(pending.id, StatementResultStatus::SUCCEEDED, None));
    assert_eq!(update.snapshot.as_ref().unwrap().text_version, version);
}

#[test]
fn sends_unparseable_sql_to_remote_as_one_output_statement() {
    let sql = "SELECT * FROM remote_table QUALIFY rank() OVER (ORDER BY id) = 1;";
    let mut session = session_with(sql);
    let mut execution = ScriptExecution::new(&mut session, execution_config());

    let operation = execution.start();
    assert_eq!(operation.protocol_error, ScriptExecutionProtocolError::NONE);
    let pending = operation.pending_statement.as_ref().unwrap();
    assert_eq!(pending.sql.as_deref(), Some(sql));
    assert_eq!(pending.statement_count, 1);
    assert!(pending.produces_output);
}

#[test]
fn does_not_run_invalid_compilation_without_pass_through_sql() {
    let mut session = session_with("SELECT 1; CREATE TABLE t (v INT);");
    let mut execution = ScriptExecution::new(&mut session, execution_config());
    let operation = execution.start();
    assert_eq!(operation.protocol_error, ScriptExecutionProtocolError::INVALID_ARGUMENT);
    assert!(operation.pending_statement.is_none());
}

#[test]
fn reports_protocol_errors() {
    let mut session = session_with("set x = 1; select 2");
    let mut execution = ScriptExecution::new(&mut session, execution_config());
    // Nothing is pending before the start
    let update = execution.cancel();
    assert_eq!(update.protocol_error, ScriptExecutionProtocolError::NONE);
    assert_eq!(update.snapshot.as_ref().unwrap().phase, ScriptExecutionPhase::IDLE);
    let update = execution.start();
    let id = update.pending_statement.as_ref().unwrap().id;
    assert_eq!(execution.start().protocol_error, ScriptExecutionProtocolError::BUSY);
    let stale = execution.resume(&result(id + 1, StatementResultStatus::SUCCEEDED, None));
    assert_eq!(stale.protocol_error, ScriptExecutionProtocolError::STALE_EFFECT);
    let invalid = execution.resume(&result(id, StatementResultStatus(9), None));
    assert_eq!(invalid.protocol_error, ScriptExecutionProtocolError::INVALID_ARGUMENT);
    let cancelled = execution.cancel();
    assert_eq!(cancelled.snapshot.as_ref().unwrap().phase, ScriptExecutionPhase::CANCELLED);
    assert_eq!(execution.start().protocol_error, ScriptExecutionProtocolError::BUSY);
    let stale = execution.resume(&result(id, StatementResultStatus::SUCCEEDED, None));
    assert_eq!(stale.protocol_error, ScriptExecutionProtocolError::STALE_EFFECT);
}
