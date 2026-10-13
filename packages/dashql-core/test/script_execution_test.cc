#include "dashql/script_execution.h"

#include "dashql/catalog.h"
#include "dashql/script_session.h"
#include "gtest/gtest.h"

namespace dashql::execution {
namespace {

buffers::formatting::FormattingConfigT ExecutionConfig() {
    buffers::formatting::FormattingConfigT config;
    config.mode = buffers::formatting::FormattingMode::INLINE;
    config.dialect = buffers::formatting::FormattingDialect::HYPER;
    return config;
}

TEST(ScriptExecutionTest, SteersStatementsInOrder) {
    Catalog catalog;
    ScriptSession session{catalog};
    session.ReplaceText(0, "create table t (v int); insert into t values (1); select * from t;");
    ScriptExecution execution{session, ExecutionConfig()};

    auto operation = execution.Start();
    ASSERT_EQ(operation.protocol_error, buffers::execution::ScriptExecutionProtocolError::NONE);
    ASSERT_NE(operation.pending_statement, nullptr);
    EXPECT_EQ(operation.pending_statement->index, 1);
    EXPECT_EQ(operation.pending_statement->statement_count, 3);
    EXPECT_FALSE(operation.pending_statement->produces_output);
    EXPECT_EQ(operation.pending_statement->sql, "create table t (v int)");

    for (uint32_t index = 2; index <= 3; ++index) {
        buffers::execution::StatementResultT result;
        result.pending_statement_id = operation.pending_statement->id;
        result.status = buffers::execution::StatementResultStatus::SUCCEEDED;
        operation = execution.Resume(result);
        ASSERT_NE(operation.pending_statement, nullptr);
        EXPECT_EQ(operation.pending_statement->index, index);
        if (index == 2) EXPECT_EQ(operation.pending_statement->sql, "insert into t values (1)");
    }
    EXPECT_TRUE(operation.pending_statement->produces_output);
    EXPECT_EQ(operation.pending_statement->sql, "select * from t");

    buffers::execution::StatementResultT result;
    result.pending_statement_id = operation.pending_statement->id;
    result.status = buffers::execution::StatementResultStatus::SUCCEEDED;
    operation = execution.Resume(result);
    ASSERT_NE(operation.snapshot, nullptr);
    EXPECT_EQ(operation.snapshot->phase, buffers::execution::ScriptExecutionPhase::SUCCEEDED);
    EXPECT_EQ(operation.pending_statement, nullptr);
}

TEST(ScriptExecutionTest, StopsAfterStatementError) {
    Catalog catalog;
    ScriptSession session{catalog};
    session.ReplaceText(0, "set x = 1; select 1");
    ScriptExecution execution{session, ExecutionConfig()};
    auto operation = execution.Start();

    buffers::execution::StatementResultT result;
    result.pending_statement_id = operation.pending_statement->id;
    result.status = buffers::execution::StatementResultStatus::FAILED;
    result.error = "nope";
    operation = execution.Resume(result);

    EXPECT_EQ(operation.snapshot->phase, buffers::execution::ScriptExecutionPhase::FAILED);
    EXPECT_EQ(operation.snapshot->error, "nope");
    EXPECT_EQ(operation.pending_statement, nullptr);
}

TEST(ScriptExecutionTest, CapturesImmutable64BitTextVersion) {
    Catalog catalog;
    ScriptSession session{catalog};
    const auto version = (uint64_t{1} << 32) + 42;
    session.GetScript().text_version = version - 1;
    session.GetScript().ReplaceText("select 1");
    ScriptExecution execution{session, ExecutionConfig()};
    session.GetScript().ReplaceText("select 2");

    auto update = execution.Start();
    ASSERT_NE(update.snapshot, nullptr);
    EXPECT_EQ(update.snapshot->text_version, version);
    ASSERT_NE(update.pending_statement, nullptr);
    EXPECT_EQ(update.pending_statement->sql, "select 1");
    EXPECT_EQ(session.GetTextVersion(), version + 1);

    buffers::execution::StatementResultT result;
    result.pending_statement_id = update.pending_statement->id;
    update = execution.Resume(result);
    ASSERT_NE(update.snapshot, nullptr);
    EXPECT_EQ(update.snapshot->text_version, version);
}

TEST(ScriptExecutionTest, SendsUnparseableSQLToRemoteAsOneOutputStatement) {
    Catalog catalog;
    ScriptSession session{catalog};
    constexpr std::string_view sql = "SELECT * FROM remote_table QUALIFY rank() OVER (ORDER BY id) = 1;";
    session.ReplaceText(0, sql);
    ScriptExecution execution{session, ExecutionConfig()};

    auto operation = execution.Start();
    ASSERT_EQ(operation.protocol_error, buffers::execution::ScriptExecutionProtocolError::NONE);
    ASSERT_NE(operation.pending_statement, nullptr);
    EXPECT_EQ(operation.pending_statement->sql, sql);
    EXPECT_EQ(operation.pending_statement->statement_count, 1);
    EXPECT_TRUE(operation.pending_statement->produces_output);
}

TEST(ScriptExecutionTest, DoesNotRunInvalidCompilationWithoutPassThroughSQL) {
    Catalog catalog;
    ScriptSession session{catalog};
    session.ReplaceText(0, "SELECT 1; CREATE TABLE t (v INT);");
    ScriptExecution execution{session, ExecutionConfig()};

    auto operation = execution.Start();
    EXPECT_EQ(operation.protocol_error, buffers::execution::ScriptExecutionProtocolError::INVALID_ARGUMENT);
    EXPECT_EQ(operation.pending_statement, nullptr);
}

}  // namespace
}  // namespace dashql::execution
