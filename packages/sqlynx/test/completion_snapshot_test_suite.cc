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

    // Read registry
    SchemaRegistry registry;
    std::vector<std::unique_ptr<Script>> registry_scripts;
    size_t entry_id = 1;
    ASSERT_NO_FATAL_FAILURE(AnalyzerSnapshotTest::TestRegistrySnapshot(test->registry, registry_node, registry,
                                                                       registry_scripts, entry_id));

    // Read main script
    Script main_script{0};
    ASSERT_NO_FATAL_FAILURE(
        AnalyzerSnapshotTest::TestMainScriptSnapshot(test->script, registry, main_node, main_script, 0));

    // Determine cursor position
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
