#include "gtest/gtest.h"
#include "pugixml.hpp"
#include "dashql/catalog.h"
#include "dashql/script.h"
#include "dashql/testing/analyzer_snapshot_test.h"

using namespace dashql;
using namespace dashql::testing;

namespace {

struct AnalyzerSnapshotTestSuite : public ::testing::TestWithParam<const AnalyzerSnapshotTest*> {};

TEST_P(AnalyzerSnapshotTestSuite, Test) {
    auto* test = GetParam();

    pugi::xml_document out;

    // Write the script node
    auto main_node = out.append_child("script");

    // Write the catalog node
    auto catalog_node = out.append_child("catalog");
    std::string default_database{test->catalog_default_database};
    std::string default_schema{test->catalog_default_schema};
    catalog_node.append_attribute("database").set_value(default_database.c_str());
    catalog_node.append_attribute("schema").set_value(default_schema.c_str());

    // Read catalog
    Catalog catalog{test->catalog_default_database, test->catalog_default_schema};
    std::vector<std::unique_ptr<Script>> catalog_scripts;
    size_t entry_id = 1;
    ASSERT_NO_FATAL_FAILURE(AnalyzerSnapshotTest::TestRegistrySnapshot(test->catalog_entries, catalog_node, catalog,
                                                                       catalog_scripts, entry_id));

    // Read main script
    Script main_script{catalog, 0};
    ASSERT_NO_FATAL_FAILURE(AnalyzerSnapshotTest::TestMainScriptSnapshot(test->script, main_node, main_script, 0));
}

// clang-format off
INSTANTIATE_TEST_SUITE_P(Basic, AnalyzerSnapshotTestSuite, ::testing::ValuesIn(AnalyzerSnapshotTest::GetTests("basic.xml")), AnalyzerSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Names, AnalyzerSnapshotTestSuite, ::testing::ValuesIn(AnalyzerSnapshotTest::GetTests("names.xml")), AnalyzerSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Multiple, AnalyzerSnapshotTestSuite, ::testing::ValuesIn(AnalyzerSnapshotTest::GetTests("multiple.xml")), AnalyzerSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(TPCH, AnalyzerSnapshotTestSuite, ::testing::ValuesIn(AnalyzerSnapshotTest::GetTests("tpch.xml")), AnalyzerSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(CrossDB, AnalyzerSnapshotTestSuite, ::testing::ValuesIn(AnalyzerSnapshotTest::GetTests("crossdb.xml")), AnalyzerSnapshotTest::TestPrinter());

}
