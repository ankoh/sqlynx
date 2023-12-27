#include "gtest/gtest.h"
#include "pugixml.hpp"
#include "sqlynx/analyzer/analyzer.h"
#include "sqlynx/analyzer/completion.h"
#include "sqlynx/parser/parser.h"
#include "sqlynx/parser/scanner.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/schema.h"
#include "sqlynx/script.h"
#include "sqlynx/testing/completion_snapshot_test.h"
#include "sqlynx/testing/xml_tests.h"

using namespace sqlynx;
using namespace sqlynx::testing;

namespace {

struct CompletionSnapshotTestSuite : public ::testing::TestWithParam<const CompletionSnapshotTest*> {};

TEST_P(CompletionSnapshotTestSuite, Test) {
    auto* test = GetParam();

    pugi::xml_document out;
    auto main_node = out.append_child("script");
    auto registry_node = out.append_child("registry");

    // Read the registry
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

    // Analyze main script
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

    std::string_view target_text = main_script.scanned_script->GetInput();
    auto search_pos = target_text.find(test->cursor_search_string);
    auto cursor_pos = search_pos + test->cursor_search_index;
    ASSERT_NE(search_pos, std::string::npos);
    ASSERT_LE(cursor_pos, target_text.size());

    // Move cursor and get completion
    main_script.MoveCursor(cursor_pos);
    auto [completion, completion_status] = main_script.CompleteAtCursor(test->completion_limit);
    ASSERT_EQ(completion_status, proto::StatusCode::OK);
    ASSERT_NE(completion, nullptr);

    auto completions = out.append_child("completions");
    completions.append_attribute("limit").set_value(test->completion_limit);
    CompletionSnapshotTest::EncodeCompletion(completions, *completion);

    ASSERT_TRUE(Matches(out.child("completions"), test->completions));
}

// clang-format off
INSTANTIATE_TEST_SUITE_P(Basic, CompletionSnapshotTestSuite, ::testing::ValuesIn(CompletionSnapshotTest::GetTests("basic.xml")), CompletionSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(TPCH, CompletionSnapshotTestSuite, ::testing::ValuesIn(CompletionSnapshotTest::GetTests("tpch.xml")), CompletionSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Keywords, CompletionSnapshotTestSuite, ::testing::ValuesIn(CompletionSnapshotTest::GetTests("keywords.xml")), CompletionSnapshotTest::TestPrinter());

}
