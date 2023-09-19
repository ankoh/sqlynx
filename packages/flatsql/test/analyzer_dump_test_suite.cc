#include "flatsql/analyzer/analyzer.h"
#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/testing/analyzer_dump_test.h"
#include "flatsql/testing/xml_tests.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

using namespace flatsql;
using namespace flatsql::testing;

namespace {

struct AnalyzerDumpTestSuite : public ::testing::TestWithParam<const AnalyzerDumpTest*> {};

TEST_P(AnalyzerDumpTestSuite, Test) {
    auto* test = GetParam();
    rope::Rope input_external{1024, test->input_external};
    rope::Rope input_main{1024, test->input_main};

    // Analyze schema
    auto external_scan = parser::Scanner::Scan(input_external, 1);
    ASSERT_EQ(external_scan.second, proto::StatusCode::OK);
    auto external_parsed = parser::ParseContext::Parse(external_scan.first);
    ASSERT_EQ(external_parsed.second, proto::StatusCode::OK);
    auto external_analyzed = Analyzer::Analyze(external_parsed.first, nullptr);
    ASSERT_EQ(external_analyzed.second, proto::StatusCode::OK);

    // Analyze script
    auto main_scan = parser::Scanner::Scan(input_main, 2);
    ASSERT_EQ(main_scan.second, proto::StatusCode::OK);
    auto main_parsed = parser::ParseContext::Parse(main_scan.first);
    ASSERT_EQ(main_parsed.second, proto::StatusCode::OK);
    auto main_analyzed = Analyzer::Analyze(main_parsed.first, external_analyzed.first);
    ASSERT_EQ(main_analyzed.second, proto::StatusCode::OK);

    // Encode the program
    pugi::xml_document out;
    auto xml_external = out.append_child("script");
    xml_external.append_attribute("context").set_value("external");
    auto xml_main = out.append_child("script");
    xml_main.append_attribute("context").set_value("main");
    AnalyzerDumpTest::EncodeScript(out, *main_analyzed.first, external_analyzed.first.get());

    // Test the XMLs
    ASSERT_TRUE(Matches(xml_main.child("tables"), test->tables));
    ASSERT_TRUE(Matches(xml_main.child("table-references"), test->table_references));
    ASSERT_TRUE(Matches(xml_main.child("column-references"), test->column_references));
    ASSERT_TRUE(Matches(xml_main.child("query-graph"), test->graph_edges));
}

// clang-format off
INSTANTIATE_TEST_SUITE_P(Basic, AnalyzerDumpTestSuite, ::testing::ValuesIn(AnalyzerDumpTest::GetTests("basic.xml")), AnalyzerDumpTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(TPCH, AnalyzerDumpTestSuite, ::testing::ValuesIn(AnalyzerDumpTest::GetTests("tpch.xml")), AnalyzerDumpTest::TestPrinter());

}
