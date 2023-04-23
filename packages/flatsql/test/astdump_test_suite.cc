#include "flatsql/parser/parser_driver.h"
#include "flatsql/testing/astdump_test.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

using namespace flatsql;
using namespace flatsql::testing;

struct ASTDumpTestSuite : public ::testing::TestWithParam<const ASTDumpTest*> {};

TEST_P(ASTDumpTestSuite, Test) {
    auto* test = GetParam();
    auto input_buffer = test->input;
    auto program = parser::ParserDriver::Parse(std::span<char>{input_buffer.data(), input_buffer.size()});
    ASSERT_EQ(input_buffer, test->input);

    pugi::xml_document out;
    ASTDumpTest::EncodeProgram(out, *program, test->input);

    ASSERT_TRUE(test->Matches(out));
}

// clang-format off
INSTANTIATE_TEST_SUITE_P(Bugs, ASTDumpTestSuite, ::testing::ValuesIn(ASTDumpTest::GetTests("bugs.xml")), ASTDumpTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Set, ASTDumpTestSuite, ::testing::ValuesIn(ASTDumpTest::GetTests("ext_set.xml")), ASTDumpTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Create, ASTDumpTestSuite, ::testing::ValuesIn(ASTDumpTest::GetTests("sql_create.xml")), ASTDumpTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Select, ASTDumpTestSuite, ::testing::ValuesIn(ASTDumpTest::GetTests("sql_select.xml")), ASTDumpTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(View, ASTDumpTestSuite, ::testing::ValuesIn(ASTDumpTest::GetTests("sql_view.xml")), ASTDumpTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(SSB, ASTDumpTestSuite, ::testing::ValuesIn(ASTDumpTest::GetTests("ssb.xml")), ASTDumpTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(TPCDS, ASTDumpTestSuite, ::testing::ValuesIn(ASTDumpTest::GetTests("tpcds.xml")), ASTDumpTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(TPCH, ASTDumpTestSuite, ::testing::ValuesIn(ASTDumpTest::GetTests("tpch.xml")), ASTDumpTest::TestPrinter());
