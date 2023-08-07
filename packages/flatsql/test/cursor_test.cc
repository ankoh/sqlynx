#include "flatsql/parser/parser_generated.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "gtest/gtest.h"

using namespace flatsql;

namespace {

struct ExpectedScriptCursor {
    std::optional<std::string_view> scanner_token_text;
    std::optional<uint32_t> statement_id;
    proto::AttributeKey ast_attribute_key;
    proto::NodeType ast_node_type;
};

void test_cursor(const Script& script, size_t text_offset, ExpectedScriptCursor expected) {
    ScriptCursor cursor;
    cursor.Move(script, text_offset);
    // Check scanner token
    if (expected.scanner_token_text.has_value()) {
        ASSERT_TRUE(cursor.scanner_token_id.has_value());
        auto token = script.scanned_script->GetTokens()[*cursor.scanner_token_id];
        auto token_text = script.scanned_script->ReadTextAtLocation(token.location);
        ASSERT_EQ(token_text, *expected.scanner_token_text);
    } else {
        ASSERT_FALSE(cursor.scanner_token_id.has_value());
    }
    // Check statement id
    ASSERT_EQ(cursor.statement_id, expected.statement_id);
    // Check AST node type
    auto& ast_node = cursor.parsed_script->nodes[*cursor.ast_node_id];
    ASSERT_EQ(ast_node.attribute_key(), expected.ast_attribute_key);
    ASSERT_EQ(ast_node.node_type(), expected.ast_node_type);
}

TEST(CursorTest, SimpleNoExternal) {
    Script script;
    script.InsertTextAt(0, "select * from A a, B b where a.x = b.y");
    auto [scanned, scan_status] = script.Scan();
    ASSERT_EQ(scan_status, proto::StatusCode::OK);
    auto [parsed, parse_status] = script.Parse();
    ASSERT_EQ(parse_status, proto::StatusCode::OK);
    auto [analyzed, analysis_status] = script.Analyze();
    ASSERT_EQ(analysis_status, proto::StatusCode::OK);

    test_cursor(script, 0,
                {
                    .scanner_token_text = "select",
                    .statement_id = 0,
                    .ast_attribute_key = proto::AttributeKey::NONE,
                    .ast_node_type = proto::NodeType::OBJECT_SQL_SELECT,
                });

    test_cursor(script, 9,
                {
                    .scanner_token_text = "from",
                    .statement_id = 0,
                    .ast_attribute_key = proto::AttributeKey::SQL_SELECT_FROM,
                    .ast_node_type = proto::NodeType::ARRAY,
                });

    test_cursor(script, 14,
                {
                    .scanner_token_text = "A",
                    .statement_id = 0,
                    .ast_attribute_key = proto::AttributeKey::NONE,
                    .ast_node_type = proto::NodeType::NAME,
                });

    test_cursor(script, 16,
                {
                    .scanner_token_text = "a",
                    .statement_id = 0,
                    .ast_attribute_key = proto::AttributeKey::SQL_TABLEREF_ALIAS,
                    .ast_node_type = proto::NodeType::NAME,
                });
}

}  // namespace
