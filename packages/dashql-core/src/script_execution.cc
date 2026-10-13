#include "dashql/script_execution.h"

#include <stdexcept>

#include "dashql/script_session.h"

namespace dashql::execution {

ScriptExecution::ScriptExecution(ScriptSession& session,
                                 buffers::formatting::FormattingConfigT formatting_config)
    : formatting_config_{std::move(formatting_config)},
      text_version_{session.GetTextVersion()} {
    compilation_ = ScriptCompiler::Compile(session.GetScript(), formatting_config_);
    for (uint32_t i = 0; i < compilation_.statements.size(); ++i) {
        if (compilation_.statements[i].kind != buffers::execution::CompiledScriptStatementKind::COMMAND) {
            output_statement_index_ = i;
        }
    }
}

ScriptExecution::~ScriptExecution() {
    if (pending_statement_state_) pending_statement_state_->coroutine.destroy();
}

ScriptExecution::Update ScriptExecution::Start() {
    if (phase_ != Phase::IDLE || pending_statement_state_) {
        return MakeUpdate(ProtocolError::BUSY, "the script execution has already started");
    }
    // Syntax diagnostics can accompany a raw SQL pass-through plan. Other compiler errors
    // do not produce executable SQL and must still stop execution.
    if (!compilation_.errors.empty() && compilation_.sql.empty()) {
        return MakeUpdate(ProtocolError::INVALID_ARGUMENT, compilation_.errors.front().message);
    }
    auto task = Run();
    return ResumeCoroutine(task.Release());
}

ScriptExecution::Update ScriptExecution::Resume(const StatementResult& result) {
    if (!pending_statement_state_ || result.pending_statement_id != pending_statement_state_->id) {
        return MakeUpdate(ProtocolError::STALE_EFFECT, "statement is no longer pending");
    }
    if (result.status != StatementResultStatus::SUCCEEDED && result.status != StatementResultStatus::FAILED &&
        result.status != StatementResultStatus::CANCELLED) {
        return MakeUpdate(ProtocolError::INVALID_ARGUMENT, "invalid statement result status");
    }
    auto pending = std::move(*pending_statement_state_);
    pending_statement_state_.reset();
    outgoing_statement_.reset();
    pending.state->result = StatementOutcome{result.status, result.error};
    return ResumeCoroutine(pending.coroutine);
}

ScriptExecution::Update ScriptExecution::Cancel() {
    if (!pending_statement_state_) return MakeUpdate();
    StatementResult result;
    result.pending_statement_id = pending_statement_state_->id;
    result.status = StatementResultStatus::CANCELLED;
    return Resume(result);
}

ScriptExecution::Task ScriptExecution::Run() {
    phase_ = Phase::RUNNING;
    const auto statement_count = static_cast<uint32_t>(compilation_.statements.size());
    for (uint32_t index = 0; index < statement_count; ++index) {
        statement_index_ = index + 1;
        const auto& statement = compilation_.statements[index];
        auto pending = std::make_unique<buffers::execution::PendingStatementT>();
        pending->source_statement_id = statement.statement_id;
        pending->index = statement_index_;
        pending->statement_count = statement_count;
        pending->sql = statement.sql;
        pending->produces_output = index == output_statement_index_;
        auto result = co_await StatementAwaiter{*this, std::move(pending)};
        if (result.status == StatementResultStatus::CANCELLED) {
            Complete(Phase::CANCELLED);
            co_return;
        }
        if (result.status == StatementResultStatus::FAILED) {
            Complete(Phase::FAILED, result.error.empty() ? "statement execution failed" : std::move(result.error));
            co_return;
        }
    }
    Complete(Phase::SUCCEEDED);
}

ScriptExecution::StatementAwaiter::StatementAwaiter(
    ScriptExecution& execution, std::unique_ptr<buffers::execution::PendingStatementT> statement)
    : execution_{execution}, statement_{std::move(statement)}, state_{std::make_shared<StatementState>()} {}

void ScriptExecution::StatementAwaiter::await_suspend(Task::Handle coroutine) {
    execution_.SuspendStatement(std::move(statement_), coroutine, state_);
}

ScriptExecution::StatementOutcome ScriptExecution::StatementAwaiter::await_resume() {
    if (!state_->result) throw std::logic_error{"script statement resumed without a result"};
    return std::move(*state_->result);
}

void ScriptExecution::SuspendStatement(std::unique_ptr<buffers::execution::PendingStatementT> statement,
                                       Task::Handle coroutine, std::shared_ptr<StatementState> state) {
    if (pending_statement_state_ || outgoing_statement_) {
        throw std::logic_error{"invalid concurrent pending statement"};
    }
    statement->id = next_pending_statement_id_++;
    pending_statement_state_ = PendingStatementState{statement->id, coroutine, std::move(state)};
    outgoing_statement_ = std::move(statement);
}

ScriptExecution::Update ScriptExecution::ResumeCoroutine(Task::Handle coroutine) {
    coroutine.resume();
    return CollectUpdate(coroutine);
}

ScriptExecution::Update ScriptExecution::CollectUpdate(Task::Handle coroutine) {
    if (!coroutine.done()) {
        if (!outgoing_statement_) {
            if (pending_statement_state_ && pending_statement_state_->coroutine == coroutine) {
                pending_statement_state_.reset();
            }
            coroutine.destroy();
            return MakeUpdate(ProtocolError::INTERNAL_ERROR, "script coroutine suspended without a statement");
        }
        auto update = MakeUpdate();
        update.pending_statement = std::move(outgoing_statement_);
        return update;
    }
    pending_statement_state_.reset();
    outgoing_statement_.reset();
    auto exception = coroutine.promise().exception;
    coroutine.destroy();
    if (exception) {
        try {
            std::rethrow_exception(exception);
        } catch (const std::exception& error) {
            return MakeUpdate(ProtocolError::INTERNAL_ERROR, error.what());
        }
    }
    if (!completed_update_) {
        return MakeUpdate(ProtocolError::INTERNAL_ERROR, "script coroutine completed without an update");
    }
    auto update = std::move(*completed_update_);
    completed_update_.reset();
    return update;
}

ScriptExecution::Update ScriptExecution::MakeUpdate(ProtocolError error, std::string message) {
    Update update;
    update.protocol_error = error;
    update.protocol_error_message = std::move(message);
    update.snapshot = std::make_unique<buffers::execution::ScriptExecutionSnapshotT>();
    update.snapshot->phase = phase_;
    update.snapshot->text_version = text_version_;
    update.snapshot->statement_index = statement_index_;
    update.snapshot->statement_count = static_cast<uint32_t>(compilation_.statements.size());
    update.snapshot->output_statement_index = output_statement_index_;
    update.snapshot->error = error_;
    return update;
}

void ScriptExecution::Complete(Phase phase, std::string error) {
    phase_ = phase;
    error_ = std::move(error);
    completed_update_ = MakeUpdate();
}

}  // namespace dashql::execution
