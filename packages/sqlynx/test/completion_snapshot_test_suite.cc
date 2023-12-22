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

    // Create scripts
    Script external_script{1};
    Script main_script{2};
    external_script.InsertTextAt(0, test->input_external);
    main_script.InsertTextAt(0, test->input_main);

    // Analyze external script
    ASSERT_EQ(external_script.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(external_script.Parse().second, proto::StatusCode::OK);
    ASSERT_EQ(external_script.Analyze().second, proto::StatusCode::OK);

    // Analyze main script
    SchemaRegistry registry;
    registry.AddScript(external_script, 0);
    ASSERT_EQ(main_script.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(main_script.Parse().second, proto::StatusCode::OK);
    ASSERT_EQ(main_script.Analyze(&registry).second, proto::StatusCode::OK);

    size_t search_pos = 0;
    Script* target_script = nullptr;

    if (test->cursor_context == "main") {
        search_pos = test->input_main.find(test->cursor_search_string);
        target_script = &main_script;

    } else if (test->cursor_context == "external") {
        search_pos = test->input_external.find(test->cursor_search_string);
        target_script = &external_script;

    } else {
        FAIL() << "unexpected cursor context " << test->cursor_context;
    }
    auto cursor_pos = search_pos + test->cursor_search_index;
    ASSERT_NE(search_pos, std::string::npos);
    ASSERT_LE(cursor_pos, test->input_main.size()) << test->input_main;

    // Move cursor and get completion
    target_script->MoveCursor(cursor_pos);
    auto [completion, completion_status] = target_script->CompleteAtCursor(test->completion_limit);
    ASSERT_EQ(completion_status, proto::StatusCode::OK);
    ASSERT_NE(completion, nullptr);

    pugi::xml_document out;
    auto completions = out.append_child("completions");
    completions.append_attribute("limit").set_value(test->completion_limit);
    CompletionSnapshotTest::EncodeCompletion(completions, *completion);

    ASSERT_TRUE(Matches(out, test->completions));
}

// clang-format off
INSTANTIATE_TEST_SUITE_P(Basic, CompletionSnapshotTestSuite, ::testing::ValuesIn(CompletionSnapshotTest::GetTests("basic.xml")), CompletionSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(TPCH, CompletionSnapshotTestSuite, ::testing::ValuesIn(CompletionSnapshotTest::GetTests("tpch.xml")), CompletionSnapshotTest::TestPrinter());
INSTANTIATE_TEST_SUITE_P(Keywords, CompletionSnapshotTestSuite, ::testing::ValuesIn(CompletionSnapshotTest::GetTests("keywords.xml")), CompletionSnapshotTest::TestPrinter());

}
