#include "dashql/formatter/formatter.h"
#include "dashql/parser/scanner.h"
#include "dashql/testing/formatter_snapshot_test.h"
#include "gtest/gtest.h"

using namespace dashql;
using namespace dashql::testing;

namespace {

struct FormatterSnapshotTestSuite : public ::testing::TestWithParam<const FormatterSnapshotTest*> {};

TEST_P(FormatterSnapshotTestSuite, Test) {
    auto* test = GetParam();
    rope::Rope input{1024, test->input};
    auto scanned = parser::Scanner::Scan(input, 0, 2);
    auto parsed = parser::Parser::Parse(scanned);

    Formatter formatter{*parsed};
    const bool require_fully_formatted = test->name.starts_with("coverage_");
    for (const auto& dialect_exp : test->dialects) {
        if (dialect_exp.skip) continue;
        for (size_t i = 0; i < dialect_exp.expectations.size(); ++i) {
            const auto& exp = dialect_exp.expectations[i];
            std::string formatted = formatter.Format(exp.config);
            ASSERT_NE(formatted, "") << "Dialect " << dialect_exp.dialect << " expectation " << i
                                     << " (mode=" << FormattingModeToString(exp.config.mode)
                                     << " indent=" << exp.config.indentation_width << "): output must not be empty";
            ASSERT_EQ(formatted, exp.formatted) << "Dialect " << dialect_exp.dialect << " expectation " << i
                                                << " (mode=" << FormattingModeToString(exp.config.mode)
                                                << " indent=" << exp.config.indentation_width << ")";
            if (require_fully_formatted) {
                ASSERT_TRUE(formatter.IsFullyFormatted())
                    << "Dialect " << dialect_exp.dialect << " expectation " << i
                    << " has unformattable AST node "
                    << (formatter.GetUnformattableNodes().empty()
                            ? "<unknown>"
                            : std::string(buffers::parser::EnumNameNodeType(
                                              parsed->GetNodes()[formatter.GetUnformattableNodes().front()].node_type())) +
                                  "/" +
                                  buffers::parser::EnumNameAttributeKey(
                                      parsed->GetNodes()[formatter.GetUnformattableNodes().front()].attribute_key()));

                rope::Rope formatted_input{1024, formatted};
                auto formatted_scanned = parser::Scanner::Scan(formatted_input, 0, 2);
                auto formatted_parsed = parser::Parser::Parse(formatted_scanned);
                ASSERT_TRUE(formatted_scanned->errors.empty())
                    << "Dialect " << dialect_exp.dialect << " expectation " << i
                    << " produced scanner errors after formatting";
                ASSERT_TRUE(formatted_parsed->errors.empty())
                    << "Dialect " << dialect_exp.dialect << " expectation " << i
                    << " produced parser errors after formatting";
            }
        }
    }
}

// clang-format off
INSTANTIATE_TEST_SUITE_P(Simple, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("simple.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Bugs, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("bugs.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Precedences, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("precedences.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(TableRef, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("tableref.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(ColumnRef, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("columnref.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Expressions, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("expressions.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(GroupBy, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("group_by.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(CreateTable, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("create_table.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(OrderBy, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("order_by.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Demo, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("demo.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Functions, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("functions.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Trino, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("trino.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Explain, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("explain.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Visualize, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("visualize.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Comments, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("comments.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Statements, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("statements.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(SelectClauses, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("select_clauses.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Insert, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("insert.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Delete, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("delete.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Tpch, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("tpch.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Tpcds, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("tpcds.yaml")), FormatterSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(PGQ, FormatterSnapshotTestSuite, ::testing::ValuesIn(FormatterSnapshotTest::GetTests("pgq.yaml")), FormatterSnapshotTest::TestPrinter());

} // namespace
