#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/program.h"
#include "flatsql/testing/parser_dump_test.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

using namespace flatsql;
using namespace flatsql::testing;

struct ParserDumpTestSuite : public ::testing::TestWithParam<const ParserDumpTest*> {};

TEST_P(ParserDumpTestSuite, Test) {
    auto* test = GetParam();
    auto input = rope::Rope::FromString(1024, test->input);
    auto scanned = parser::Scanner::Scan(input);
    auto parsed = parser::ParseContext::Parse(*scanned);
    auto packed_program = parsed->Pack();

    pugi::xml_document out;
    ParserDumpTest::EncodeProgram(out, *packed_program, test->input);

    ASSERT_TRUE(test->Matches(out));
}

// clang-format off
INSTANTIATE_TEST_SUITE_P(Bugs, ParserDumpTestSuite, ::testing::ValuesIn(ParserDumpTest::GetTests("bugs.xml")), ParserDumpTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Set, ParserDumpTestSuite, ::testing::ValuesIn(ParserDumpTest::GetTests("ext_set.xml")), ParserDumpTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Create, ParserDumpTestSuite, ::testing::ValuesIn(ParserDumpTest::GetTests("sql_create.xml")), ParserDumpTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Select, ParserDumpTestSuite, ::testing::ValuesIn(ParserDumpTest::GetTests("sql_select.xml")), ParserDumpTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(View, ParserDumpTestSuite, ::testing::ValuesIn(ParserDumpTest::GetTests("sql_view.xml")), ParserDumpTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(SSB, ParserDumpTestSuite, ::testing::ValuesIn(ParserDumpTest::GetTests("ssb.xml")), ParserDumpTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(TPCDS, ParserDumpTestSuite, ::testing::ValuesIn(ParserDumpTest::GetTests("tpcds.xml")), ParserDumpTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(TPCH, ParserDumpTestSuite, ::testing::ValuesIn(ParserDumpTest::GetTests("tpch.xml")), ParserDumpTest::TestPrinter());
