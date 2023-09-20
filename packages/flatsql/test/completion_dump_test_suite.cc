#include "flatsql/analyzer/analyzer.h"
#include "flatsql/analyzer/completion.h"
#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/testing/completion_dump_test.h"
#include "flatsql/testing/xml_tests.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

using namespace flatsql;
using namespace flatsql::testing;

namespace {

struct CompletionDumpTestSuite : public ::testing::TestWithParam<const CompletionDumpTest*> {};

TEST_P(CompletionDumpTestSuite, Test) {
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
    ASSERT_EQ(main_script.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(main_script.Parse().second, proto::StatusCode::OK);
    ASSERT_EQ(main_script.Analyze(&external_script).second, proto::StatusCode::OK);

    size_t cursor_pos = 0;
    Script* target_script = nullptr;

    if (test->cursor_context == "main") {
        auto search_pos = test->input_main.find(test->cursor_search_string);
        ASSERT_NE(search_pos, std::string::npos);
        auto cursor_pos = search_pos + test->cursor_search_index;
        ASSERT_LE(cursor_pos, test->input_main.size());
        target_script = &main_script;

    } else if (test->cursor_context == "external") {
        auto search_pos = test->input_external.find(test->cursor_search_string);
        ASSERT_NE(search_pos, std::string::npos);
        auto cursor_pos = search_pos + test->cursor_search_index;
        ASSERT_LE(cursor_pos, test->input_main.size());
        target_script = &external_script;

    } else {
        FAIL() << "unexpected cursor context " << test->cursor_context;
    }

    // Move cursor and get completion
    target_script->MoveCursor(cursor_pos);
    auto [completion, completion_status] = target_script->CompleteAtCursor();
    ASSERT_EQ(completion_status, proto::StatusCode::OK);
    ASSERT_NE(completion, nullptr);
}

// clang-format off
INSTANTIATE_TEST_SUITE_P(Basic, CompletionDumpTestSuite, ::testing::ValuesIn(CompletionDumpTest::GetTests("basic.xml")), CompletionDumpTest::TestPrinter());

}
