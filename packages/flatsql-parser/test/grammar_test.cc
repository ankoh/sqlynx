#include "flatsql/parser/parser_driver.h"
#include "flatsql/test/grammar_tester.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

using namespace flatsql;
using namespace flatsql::test;

struct GrammarSpecTests : public testing::TestWithParam<const GrammarTest*> {};

TEST_P(GrammarSpecTests, Test) {
    auto* test = GetParam();
    auto input_buffer = test->input;
    auto program = parser::ParserDriver::Parse(std::span<char>{input_buffer.data(), input_buffer.size()});

    pugi::xml_document out;
    GrammarTest::EncodeProgram(out, *program, test->input);

    ASSERT_TRUE(test->Matches(out));
}

// clang-format off
INSTANTIATE_TEST_SUITE_P(Bugs, GrammarSpecTests, testing::ValuesIn(GrammarTest::GetTests("bugs.xml")), GrammarTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Set, GrammarSpecTests, testing::ValuesIn(GrammarTest::GetTests("ext_set.xml")), GrammarTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Create, GrammarSpecTests, testing::ValuesIn(GrammarTest::GetTests("sql_create.xml")), GrammarTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Select, GrammarSpecTests, testing::ValuesIn(GrammarTest::GetTests("sql_select.xml")), GrammarTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(View, GrammarSpecTests, testing::ValuesIn(GrammarTest::GetTests("sql_view.xml")), GrammarTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(SSB, GrammarSpecTests, testing::ValuesIn(GrammarTest::GetTests("ssb.xml")), GrammarTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(TPCDS, GrammarSpecTests, testing::ValuesIn(GrammarTest::GetTests("tpcds.xml")), GrammarTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(TPCH, GrammarSpecTests, testing::ValuesIn(GrammarTest::GetTests("tpch.xml")), GrammarTest::TestPrinter());
