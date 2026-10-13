#pragma once

#include <coroutine>
#include <cstdint>
#include <exception>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "dashql/buffers/index_generated.h"
#include "dashql/script_compiler.h"

namespace dashql { class ScriptSession; }

namespace dashql::execution {

class ScriptExecution {
   public:
    using Update = buffers::execution::ScriptExecutionUpdateT;
    using StatementResult = buffers::execution::StatementResultT;

    /// Compile and capture an immutable execution plan for the session's current text version.
    ScriptExecution(ScriptSession& session, buffers::formatting::FormattingConfigT formatting_config);
    /// Destroy any coroutine still suspended while waiting for a statement result.
    ~ScriptExecution();

    /// Executions own coroutine state and cannot be copied.
    ScriptExecution(const ScriptExecution&) = delete;
    /// Executions own coroutine state and cannot be copy-assigned.
    ScriptExecution& operator=(const ScriptExecution&) = delete;

    /// Start the captured plan and return either its first pending statement or a terminal update.
    Update Start();
    /// Supply the result for the matching pending statement and advance to the next update.
    Update Resume(const StatementResult& result);
    /// Resume the currently pending statement as cancelled and terminate the remaining plan.
    Update Cancel();

   private:
    using Phase = buffers::execution::ScriptExecutionPhase;
    using ProtocolError = buffers::execution::ScriptExecutionProtocolError;
    using StatementResultStatus = buffers::execution::StatementResultStatus;

    struct Task {
        struct promise_type;
        using Handle = std::coroutine_handle<promise_type>;

        struct promise_type {
            std::exception_ptr exception;
            /// Return the owning wrapper for this newly created coroutine frame.
            Task get_return_object() noexcept { return Task{Handle::from_promise(*this)}; }
            /// Keep execution dormant until Start explicitly resumes the workflow.
            std::suspend_always initial_suspend() const noexcept { return {}; }
            /// Keep a completed frame alive until its terminal update is collected.
            std::suspend_always final_suspend() const noexcept { return {}; }
            /// Complete a workflow whose terminal state was stored on the execution object.
            void return_void() const noexcept {}
            /// Retain workflow exceptions so they can be converted into protocol errors at the API boundary.
            void unhandled_exception() noexcept { exception = std::current_exception(); }
        };

        /// Take ownership of a newly allocated coroutine frame.
        explicit Task(Handle handle) : handle{handle} {}
        /// A coroutine frame has exactly one owner and cannot be copied.
        Task(const Task&) = delete;
        /// Transfer ownership of the coroutine frame from another task wrapper.
        Task(Task&& other) noexcept : handle{std::exchange(other.handle, {})} {}
        /// Destroy the frame unless ownership was released to ScriptExecution.
        ~Task() { if (handle) handle.destroy(); }
        /// Transfer frame ownership to the execution's suspension machinery.
        Handle Release() { return std::exchange(handle, {}); }
        Handle handle;
    };

    struct StatementOutcome {
        StatementResultStatus status = StatementResultStatus::SUCCEEDED;
        std::string error;
    };
    struct StatementState { std::optional<StatementOutcome> result; };
    struct PendingStatementState {
        uint64_t id;
        Task::Handle coroutine;
        std::shared_ptr<StatementState> state;
    };

    class StatementAwaiter {
       public:
        /// Own a host-executable statement until the workflow reaches its suspension point.
        StatementAwaiter(ScriptExecution& execution,
                         std::unique_ptr<buffers::execution::PendingStatementT> statement);
        /// Statement execution always requires asynchronous work by the host.
        bool await_ready() const noexcept { return false; }
        /// Publish the statement and retain the workflow handle needed to resume it.
        void await_suspend(Task::Handle coroutine);
        /// Consume the host result installed by Resume after the workflow continues.
        StatementOutcome await_resume();

       private:
        ScriptExecution& execution_;
        std::unique_ptr<buffers::execution::PendingStatementT> statement_;
        std::shared_ptr<StatementState> state_;
    };

    /// Execute the captured statements in order, stopping at the first failure or cancellation.
    Task Run();
    /// Register one pending statement and its suspended coroutine for the next host update.
    void SuspendStatement(std::unique_ptr<buffers::execution::PendingStatementT> statement,
                          Task::Handle coroutine, std::shared_ptr<StatementState> state);
    /// Resume a valid workflow frame and translate its next suspension or completion into an update.
    Update ResumeCoroutine(Task::Handle coroutine);
    /// Collect a pending statement or terminal state and safely destroy completed coroutine frames.
    Update CollectUpdate(Task::Handle coroutine);
    /// Build an update containing protocol status and a snapshot of execution progress.
    Update MakeUpdate(ProtocolError error = ProtocolError::NONE, std::string message = {});
    /// Store the terminal execution phase and optional database error before the coroutine returns.
    void Complete(Phase phase, std::string error = {});

    buffers::formatting::FormattingConfigT formatting_config_;
    TextVersion text_version_ = 0;
    uint64_t next_pending_statement_id_ = 1;
    uint32_t statement_index_ = 0;
    uint32_t output_statement_index_ = PROTO_NULL_U32;
    Phase phase_ = Phase::IDLE;
    std::string error_;
    ScriptCompilationResult compilation_;
    std::optional<PendingStatementState> pending_statement_state_;
    std::unique_ptr<buffers::execution::PendingStatementT> outgoing_statement_;
    std::optional<Update> completed_update_;
};

}  // namespace dashql::execution
