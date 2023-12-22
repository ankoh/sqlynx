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
    Script external_script{2};
    Script main_script{1};
    external_script.InsertTextAt(0, test->input_external);
    main_script.InsertTextAt(0, test->input_main);

    // Analyze schema
    auto external_scan = external_script.Scan();
    ASSERT_EQ(external_scan.second, proto::StatusCode::OK);
    auto external_parsed = external_script.Parse();
    ASSERT_EQ(external_parsed.second, proto::StatusCode::OK);
    auto external_analyzed = external_script.Analyze();
    ASSERT_EQ(external_analyzed.second, proto::StatusCode::OK);

    // Analyze script
    auto main_scan = main_script.Scan();
    ASSERT_EQ(main_scan.second, proto::StatusCode::OK);
    auto main_parsed = main_script.Parse();
    ASSERT_EQ(main_parsed.second, proto::StatusCode::OK);

    SchemaRegistry registry;
    registry.AddScript(external_script, 0);
    auto main_analyzed = main_script.Analyze(&registry);
    ASSERT_EQ(main_analyzed.second, proto::StatusCode::OK);

    // Encode the program
    pugi::xml_document out;
    auto xml_external = out.append_child("script");
    xml_external.append_attribute("context").set_value("external");
    auto xml_main = out.append_child("script");
    xml_main.append_attribute("context").set_value("main");
    AnalyzerSnapshotTest::EncodeScript(out, *main_analyzed.first, external_analyzed.first);

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
