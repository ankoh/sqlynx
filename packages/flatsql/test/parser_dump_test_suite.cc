#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/script.h"
#include "flatsql/testing/parser_dump_test.h"
#include "flatsql/testing/xml_tests.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

using namespace flatsql;
using namespace flatsql::testing;

struct ParserDumpTestSuite : public ::testing::TestWithParam<const ParserDumpTest*> {};

TEST_P(ParserDumpTestSuite, Test) {
    auto* test = GetParam();
    auto input = std::make_shared<TextBuffer>(1024, test->input);
    auto [scanned, scannedStatus] = parser::Scanner::Scan(input);
    ASSERT_EQ(scannedStatus, proto::StatusCode::OK);
    auto [parsed, parsedStatus] = parser::ParseContext::Parse(scanned);
    ASSERT_EQ(parsedStatus, proto::StatusCode::OK);

    pugi::xml_document out;
    ParserDumpTest::EncodeScript(out, *scanned, *parsed, test->input);

    ASSERT_TRUE(Matches(out, test->expected));
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
