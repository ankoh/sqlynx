#include <initializer_list>
#include <optional>

#include "flatsql/api.h"
#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "gtest/gtest.h"

using namespace flatsql;

using Token = proto::ScannerTokenType;

namespace {

TEST(ParserTest, FindNodeAtOffset) {
    std::shared_ptr<ParsedScript> script;

    // Helper to parse a script
    auto parse = [&](std::string_view text) {
        rope::Rope buffer{128};
        buffer.Insert(0, text);
        auto [scanned, scannerStatus] = parser::Scanner::Scan(buffer);
        ASSERT_EQ(scannerStatus, proto::StatusCode::OK);
        auto [parsed, parserStatus] = parser::ParseContext::Parse(scanned);
        ASSERT_EQ(parserStatus, proto::StatusCode::OK);
        script = std::move(parsed);
    };
    /// Test if ast node matches
    auto test_node_at_offset = [&](size_t text_offset, size_t expected_statement_id, proto::NodeType expect_node_type,
                                   sx::Location expect_loc) {
        auto result = script->FindNodeAtOffset(text_offset);
        ASSERT_TRUE(result.has_value()) << "offset=" << text_offset;
        auto [statement_id, node_id] = *result;
        ASSERT_EQ(statement_id, expected_statement_id);
        ASSERT_LT(node_id, script->nodes.size());
        auto& node = script->nodes[node_id];
        ASSERT_EQ(node.node_type(), expect_node_type);
        ASSERT_EQ(node.location().offset(), expect_loc.offset());
        ASSERT_EQ(node.location().length(), expect_loc.length());
    };

    parse("select 1");
    test_node_at_offset(0, 0, proto::NodeType::OBJECT_SQL_SELECT, sx::Location(0, 8));
    test_node_at_offset(1, 0, proto::NodeType::OBJECT_SQL_SELECT, sx::Location(0, 8));
    test_node_at_offset(2, 0, proto::NodeType::OBJECT_SQL_SELECT, sx::Location(0, 8));
    test_node_at_offset(7, 0, proto::NodeType::LITERAL_INTEGER, sx::Location(7, 1));
}

}  // namespace
