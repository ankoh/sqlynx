#include "gtest/gtest.h"
#include "pugixml.hpp"
#include "sqlynx/analyzer/analyzer.h"
#include "sqlynx/parser/parser.h"
#include "sqlynx/parser/scanner.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/schema.h"
#include "sqlynx/script.h"
#include "sqlynx/testing/analyzer_snapshot_test.h"
#include "sqlynx/testing/xml_tests.h"

using namespace sqlynx;
using namespace sqlynx::testing;

namespace {

struct AnalyzerSnapshotTestSuite : public ::testing::TestWithParam<const AnalyzerSnapshotTest*> {};

TEST_P(AnalyzerSnapshotTestSuite, Test) {
    auto* test = GetParam();
    rope::Rope input_external{1024, test->input_external};
    rope::Rope input_main{1024, test->input_main};

    // Analyze schema
    auto external_scan = parser::Scanner::Scan(input_external, 1);
    ASSERT_EQ(external_scan.second, proto::StatusCode::OK);
    auto external_parsed = parser::Parser::Parse(external_scan.first);
    ASSERT_EQ(external_parsed.second, proto::StatusCode::OK);
    auto external_analyzed = Analyzer::Analyze(external_parsed.first, DEFAULT_DATABASE_NAME, DEFAULT_SCHEMA_NAME);
    ASSERT_EQ(external_analyzed.second, proto::StatusCode::OK);

    // Analyze script
    auto main_scan = parser::Scanner::Scan(input_main, 2);
    ASSERT_EQ(main_scan.second, proto::StatusCode::OK);
    auto main_parsed = parser::Parser::Parse(main_scan.first);
    ASSERT_EQ(main_parsed.second, proto::StatusCode::OK);
    SchemaSearchPath search_path;
    search_path.PushBack(external_analyzed.first);
    auto main_analyzed = Analyzer::Analyze(main_parsed.first, DEFAULT_DATABASE_NAME, DEFAULT_SCHEMA_NAME, &search_path);
    ASSERT_EQ(main_analyzed.second, proto::StatusCode::OK);

    // Encode the program
    pugi::xml_document out;
    auto xml_external = out.append_child("script");
    xml_external.append_attribute("context").set_value("external");
    auto xml_main = out.append_child("script");
    xml_main.append_attribute("context").set_value("main");
    AnalyzerSnapshotTest::EncodeScript(out, *main_analyzed.first, external_analyzed.first.get());

    // Test the XMLs
    ASSERT_TRUE(Matches(xml_main.child("tables"), test->tables));
    ASSERT_TRUE(Matches(xml_main.child("table-references"), test->table_references));
    ASSERT_TRUE(Matches(xml_main.child("column-references"), test->column_references));
    ASSERT_TRUE(Matches(xml_main.child("query-graph"), test->graph_edges));
}

// clang-format off
INSTANTIATE_TEST_SUITE_P(Basic, AnalyzerSnapshotTestSuite, ::testing::ValuesIn(AnalyzerSnapshotTest::GetTests("basic.xml")), AnalyzerSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Multiple, AnalyzerSnapshotTestSuite, ::testing::ValuesIn(AnalyzerSnapshotTest::GetTests("multiple.xml")), AnalyzerSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(TPCH, AnalyzerSnapshotTestSuite, ::testing::ValuesIn(AnalyzerSnapshotTest::GetTests("tpch.xml")), AnalyzerSnapshotTest::TestPrinter());

}
