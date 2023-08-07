#include "flatsql/analyzer/analyzer.h"
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
    std::optional<std::string_view> table_ref_name;
};

std::string print_name(const Script& script, const proto::QualifiedTableName& name) {
    auto& scanned = script.scanned_script;
    auto& names = scanned->name_dictionary;
    std::stringstream out;
    size_t out_idx = 0;
    auto write = [&](Analyzer::ID name_id) {
        if (!name_id.IsNull()) {
            auto name = scanned->name_dictionary[name_id.AsIndex()].first;
            if (out_idx++ > 0) {
                out << ".";
            }
            out << name;
        }
    };
    write(Analyzer::ID(name.database_name()));
    write(Analyzer::ID(name.schema_name()));
    write(Analyzer::ID(name.table_name()));
    return out.str();
}

void test_cursor(const Script& script, size_t text_offset, ExpectedScriptCursor expected) {
    SCOPED_TRACE(std::string{"CURSOR "} + std::to_string(text_offset));
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
    // Check table reference
    if (expected.table_ref_name.has_value()) {
        ASSERT_TRUE(cursor.table_reference_id.has_value());
        ASSERT_LT(*cursor.table_reference_id, script.analyzed_script->table_references.size());
        auto& table_ref = script.analyzed_script->table_references[*cursor.table_reference_id];
        auto table_name = print_name(script, table_ref.table_name());
        ASSERT_EQ(table_name, expected.table_ref_name);
    } else {
        ASSERT_FALSE(cursor.table_reference_id.has_value());
    }
}

TEST(CursorTest, SimpleNoExternal) {
    Script script;
    script.InsertTextAt(0, "select * from A b, C d where b.x = d.y");
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
                    .table_ref_name = "a",
                });

    test_cursor(script, 16,
                {
                    .scanner_token_text = "b",
                    .statement_id = 0,
                    .ast_attribute_key = proto::AttributeKey::SQL_TABLEREF_ALIAS,
                    .ast_node_type = proto::NodeType::NAME,
                    .table_ref_name = "a",
                });
}

}  // namespace
