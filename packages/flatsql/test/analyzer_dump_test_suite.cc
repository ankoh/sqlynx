#include "flatsql/analyzer/analyzer.h"
#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/script.h"
#include "flatsql/testing/analyzer_dump_test.h"
#include "flatsql/testing/xml_tests.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

using namespace flatsql;
using namespace flatsql::testing;

struct AnalyzerDumpTestSuite : public ::testing::TestWithParam<const AnalyzerDumpTest*> {};

TEST_P(AnalyzerDumpTestSuite, Test) {
    auto* test = GetParam();
    auto input_external = rope::Rope::FromString(1024, test->input_external);
    auto input_main = rope::Rope::FromString(1024, test->input_main);

    // Analyze schema
    auto external_scan = parser::Scanner::Scan(input_external);
    auto external_parsed = parser::ParseContext::Parse(external_scan);
    auto external_analyzed = Analyzer::Analyze(external_parsed);

    // Analyze script
    auto main_scan = parser::Scanner::Scan(input_main);
    auto main_parsed = parser::ParseContext::Parse(main_scan);
    auto main_analyzed = Analyzer::Analyze(main_parsed, external_analyzed);

    // Encode the program
    pugi::xml_document out;
    auto xml_external = out.append_child("external");
    auto xml_main = out.append_child("main");
    AnalyzerDumpTest::EncodeScript(out, *main_analyzed, external_analyzed.get());

    // Test the XMLs
    ASSERT_TRUE(Matches(xml_main.child("tables"), test->tables));
    ASSERT_TRUE(Matches(xml_main.child("table-references"), test->table_references));
    ASSERT_TRUE(Matches(xml_main.child("column-references"), test->column_references));
    ASSERT_TRUE(Matches(xml_main.child("query-graph"), test->graph_edges));
}

// clang-format off
INSTANTIATE_TEST_SUITE_P(Basic, AnalyzerDumpTestSuite, ::testing::ValuesIn(AnalyzerDumpTest::GetTests("basic.xml")), AnalyzerDumpTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(TPCH, AnalyzerDumpTestSuite, ::testing::ValuesIn(AnalyzerDumpTest::GetTests("tpch.xml")), AnalyzerDumpTest::TestPrinter());
