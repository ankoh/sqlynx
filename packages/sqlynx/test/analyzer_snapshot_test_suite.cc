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

    pugi::xml_document out;
    auto main_node = out.append_child("script");
    auto registry_node = out.append_child("registry");

    // Build the registry with all entries but the first one
    SchemaRegistry registry;
    std::vector<std::unique_ptr<Script>> registry_scripts;
    for (size_t i = 0; i < test->registry.size(); ++i) {
        auto& entry = test->registry[i];
        registry_scripts.push_back(std::make_unique<Script>(i + 1, entry.database_name, entry.schema_name));

        auto& script = *registry_scripts.back();
        script.InsertTextAt(0, entry.input);
        auto scanned = script.Scan();
        ASSERT_EQ(scanned.second, proto::StatusCode::OK);
        auto parsed = script.Parse();
        ASSERT_EQ(parsed.second, proto::StatusCode::OK);
        auto analyzed = script.Analyze();
        ASSERT_EQ(analyzed.second, proto::StatusCode::OK);

        registry.AddScript(script, i);

        auto script_node = registry_node.append_child("script");
        AnalyzerSnapshotTest::EncodeScript(script_node, *script.analyzed_script, false);

        ASSERT_TRUE(Matches(script_node.child("tables"), entry.tables));
        ASSERT_TRUE(Matches(script_node.child("table-references"), entry.table_references));
        ASSERT_TRUE(Matches(script_node.child("column-references"), entry.column_references));
        ASSERT_TRUE(Matches(script_node.child("query-graph"), entry.graph_edges));
    }

    auto& main_entry = test->script;
    Script main_script{0};
    main_script.InsertTextAt(0, main_entry.input);

    // Analyze schema
    auto main_scan = main_script.Scan();
    ASSERT_EQ(main_scan.second, proto::StatusCode::OK);
    auto main_parsed = main_script.Parse();
    ASSERT_EQ(main_parsed.second, proto::StatusCode::OK);
    auto main_analyzed = main_script.Analyze(&registry);
    ASSERT_EQ(main_analyzed.second, proto::StatusCode::OK) << proto::EnumNameStatusCode(main_analyzed.second);

    AnalyzerSnapshotTest::EncodeScript(main_node, *main_script.analyzed_script, true);

    ASSERT_TRUE(Matches(main_node.child("tables"), main_entry.tables));
    ASSERT_TRUE(Matches(main_node.child("table-references"), main_entry.table_references));
    ASSERT_TRUE(Matches(main_node.child("column-references"), main_entry.column_references));
    ASSERT_TRUE(Matches(main_node.child("query-graph"), main_entry.graph_edges));
}

// clang-format off
INSTANTIATE_TEST_SUITE_P(Basic, AnalyzerSnapshotTestSuite, ::testing::ValuesIn(AnalyzerSnapshotTest::GetTests("basic.xml")), AnalyzerSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Multiple, AnalyzerSnapshotTestSuite, ::testing::ValuesIn(AnalyzerSnapshotTest::GetTests("multiple.xml")), AnalyzerSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(TPCH, AnalyzerSnapshotTestSuite, ::testing::ValuesIn(AnalyzerSnapshotTest::GetTests("tpch.xml")), AnalyzerSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(CrossDB, AnalyzerSnapshotTestSuite, ::testing::ValuesIn(AnalyzerSnapshotTest::GetTests("crossdb.xml")), AnalyzerSnapshotTest::TestPrinter());

}
