#include "dashql/formatter/formatter.h"
#include "dashql/parser/scanner.h"
#include "dashql/testing/formatter_snapshot_test.h"

#include <limits>

#include <hyperapi/hyperapi.hpp>

#include <cstdlib>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <string_view>

#include "gtest/gtest.h"

using namespace dashql;
using namespace dashql::testing;

namespace {

struct FormatterValidationHyperTestSuite : public ::testing::TestWithParam<const FormatterSnapshotTest*> {};

hyperapi::HyperProcess& GetHyperProcess() {
    static auto process = [] {
        const char* hyperd_binary = std::getenv("HYPERD_BINARY");
        if (hyperd_binary == nullptr) throw std::runtime_error{"HYPERD_BINARY is not set"};
        return hyperapi::HyperProcess{
            std::filesystem::path{hyperd_binary}.parent_path().string(),
            hyperapi::Telemetry::DoNotSendUsageDataToTableau,
            "dashql-formatter-validation",
            {
                {"default_database_version", "4"},
                {"log_config", ""},
            },
        };
    }();
    return process;
}

std::filesystem::path CreateDatabasePath() {
    const char* test_tmpdir = std::getenv("TEST_TMPDIR");
    if (test_tmpdir == nullptr) throw std::runtime_error{"TEST_TMPDIR is not set"};
    const auto* test = ::testing::UnitTest::GetInstance()->current_test_info();
    auto directory = std::filesystem::path{test_tmpdir} / (std::string{test->test_suite_name()} + "." + test->name());
    std::filesystem::create_directories(directory);
    return directory / "memory.hyper";
}

struct TemporaryDatabase {
    std::filesystem::path path = CreateDatabasePath();

    ~TemporaryDatabase() {
        std::error_code error;
        std::filesystem::remove_all(path.parent_path(), error);
    }
};

void ExecuteScript(hyperapi::Connection& connection, std::string_view script) {
    size_t statement_begin = 0;
    char quote = 0;
    bool line_comment = false;
    size_t block_comment_depth = 0;

    auto execute_statement = [&](size_t statement_end) {
        auto statement = script.substr(statement_begin, statement_end - statement_begin);
        const auto first = statement.find_first_not_of(" \t\r\n");
        if (first == std::string_view::npos) return;
        const auto last = statement.find_last_not_of(" \t\r\n");
        connection.executeCommand(std::string{statement.substr(first, last - first + 1)});
    };

    for (size_t i = 0; i < script.size(); ++i) {
        const char current = script[i];
        const char next = i + 1 < script.size() ? script[i + 1] : 0;

        if (line_comment) {
            if (current == '\n') line_comment = false;
            continue;
        }
        if (block_comment_depth > 0) {
            if (current == '/' && next == '*') {
                ++block_comment_depth;
                ++i;
            } else if (current == '*' && next == '/') {
                --block_comment_depth;
                ++i;
            }
            continue;
        }
        if (quote != 0) {
            if (current == quote) {
                if (next == quote) {
                    ++i;
                } else {
                    quote = 0;
                }
            }
            continue;
        }
        if (current == '-' && next == '-') {
            line_comment = true;
            ++i;
        } else if (current == '/' && next == '*') {
            block_comment_depth = 1;
            ++i;
        } else if (current == '\'' || current == '"') {
            quote = current;
        } else if (current == ';') {
            execute_statement(i);
            statement_begin = i + 1;
        }
    }
    execute_statement(script.size());
}

TEST_P(FormatterValidationHyperTestSuite, Test) {
    auto* test = GetParam();
    rope::Rope input{1024, test->input};
    auto scanned = parser::Scanner::Scan(input, 0, 2);
    auto parsed = parser::Parser::Parse(scanned);

    Formatter formatter{*parsed};
    for (const auto& dialect_exp : test->dialects) {
        if (dialect_exp.skip) continue;
        if (dialect_exp.dialect != "hyper" || !dialect_exp.validation.has_value()) continue;

        TemporaryDatabase database;
        try {
            hyperapi::Connection connection{
                GetHyperProcess().getEndpoint(),
                database.path.string(),
                hyperapi::CreateMode::CreateAndReplace,
            };

            const auto& validation = *dialect_exp.validation;
            ExecuteScript(connection, validation.setup);
            if (HasFailure()) return;

            for (size_t i = 0; i < dialect_exp.expectations.size(); ++i) {
                const auto& exp = dialect_exp.expectations[i];
                std::string formatted = formatter.Format(exp.config);
                ASSERT_NE(formatted, "") << "Dialect " << dialect_exp.dialect << " expectation " << i
                                         << " (mode=" << FormattingModeToString(exp.config.mode)
                                         << "): output must not be empty";
                ASSERT_EQ(formatted, exp.formatted) << "Dialect " << dialect_exp.dialect << " expectation " << i
                                                    << " (mode=" << FormattingModeToString(exp.config.mode) << ")";

                try {
                    ExecuteScript(connection, formatted);
                } catch (const hyperapi::HyperException& e) {
                    FAIL() << "Dialect " << dialect_exp.dialect << " expectation " << i
                           << " (mode=" << FormattingModeToString(exp.config.mode)
                           << "): Hyper execution failed: " << e.toString();
                }
                if (HasFailure()) return;
            }
        } catch (const hyperapi::HyperException& e) {
            FAIL() << "Dialect " << dialect_exp.dialect << ": Hyper setup failed: " << e.toString();
        }
    }
}

// clang-format off
INSTANTIATE_TEST_SUITE_P(Simple, FormatterValidationHyperTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTestsWithValidation("simple.yaml", "hyper")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Bugs, FormatterValidationHyperTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTestsWithValidation("bugs.yaml", "hyper")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Precedences, FormatterValidationHyperTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTestsWithValidation("precedences.yaml", "hyper")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(TableRef, FormatterValidationHyperTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTestsWithValidation("tableref.yaml", "hyper")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(ColumnRef, FormatterValidationHyperTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTestsWithValidation("columnref.yaml", "hyper")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Expressions, FormatterValidationHyperTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTestsWithValidation("expressions.yaml", "hyper")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(GroupBy, FormatterValidationHyperTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTestsWithValidation("group_by.yaml", "hyper")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(OrderBy, FormatterValidationHyperTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTestsWithValidation("order_by.yaml", "hyper")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Functions, FormatterValidationHyperTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTestsWithValidation("functions.yaml", "hyper")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Comments, FormatterValidationHyperTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTestsWithValidation("comments.yaml", "hyper")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Statements, FormatterValidationHyperTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTestsWithValidation("statements.yaml", "hyper")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(PGQ, FormatterValidationHyperTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTestsWithValidation("pgq.yaml", "hyper")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Insert, FormatterValidationHyperTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTestsWithValidation("insert.yaml", "hyper")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Delete, FormatterValidationHyperTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTestsWithValidation("delete.yaml", "hyper")), FormatterSnapshotTest::TestPrinter());

}  // namespace
