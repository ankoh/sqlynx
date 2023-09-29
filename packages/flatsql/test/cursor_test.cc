#include "flatsql/analyzer/analyzer.h"
#include "flatsql/analyzer/completion.h"
#include "flatsql/parser/parser.h"
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
    std::optional<std::string_view> column_ref_name;
    std::vector<std::string> graph_from;
    std::vector<std::string> graph_to;
};

std::string print_name(const Script& script, const AnalyzedScript::QualifiedTableName& name) {
    auto& scanned = script.scanned_script;
    auto& names = scanned->name_dictionary;
    std::stringstream out;
    size_t out_idx = 0;
    auto write = [&](QualifiedID name_id) {
        if (!name_id.IsNull()) {
            assert(name_id.GetContext() == script.context_id);
            auto name = scanned->name_dictionary[name_id.GetIndex()].text;
            if (out_idx++ > 0) {
                out << ".";
            }
            out << name;
        }
    };
    write(name.database_name);
    write(name.schema_name);
    write(name.table_name);
    return out.str();
}

std::string print_name(const Script& script, const AnalyzedScript::QualifiedColumnName& name) {
    auto& scanned = script.scanned_script;
    auto& names = scanned->name_dictionary;
    std::stringstream out;
    size_t out_idx = 0;
    auto write = [&](QualifiedID name_id) {
        if (!name_id.IsNull()) {
            assert(name_id.GetContext() == script.context_id);
            auto name = scanned->name_dictionary[name_id.GetIndex()].text;
            if (out_idx++ > 0) {
                out << ".";
            }
            out << name;
        }
    };
    write(name.table_alias);
    write(name.column_name);
    return out.str();
}

void test(Script& script, size_t text_offset, ExpectedScriptCursor expected) {
    SCOPED_TRACE(std::string{"CURSOR "} + std::to_string(text_offset));
    auto [cursor, status] = script.MoveCursor(text_offset);
    ASSERT_EQ(status, proto::StatusCode::OK);
    // Check scanner token
    if (expected.scanner_token_text.has_value()) {
        ASSERT_TRUE(cursor->scanner_location.has_value());
        auto token = script.scanned_script->GetTokens()[cursor->scanner_location->token_id];
        auto token_text = script.scanned_script->ReadTextAtLocation(token.location);
        ASSERT_EQ(token_text, *expected.scanner_token_text);
    } else {
        ASSERT_FALSE(cursor->scanner_location.has_value());
    }
    // Check statement id
    ASSERT_EQ(cursor->statement_id, expected.statement_id);
    // Check AST node type
    auto& ast_node = script.analyzed_script->parsed_script->nodes[*cursor->ast_node_id];
    ASSERT_EQ(ast_node.attribute_key(), expected.ast_attribute_key);
    ASSERT_EQ(ast_node.node_type(), expected.ast_node_type);
    // Check table reference
    if (expected.table_ref_name.has_value()) {
        ASSERT_TRUE(cursor->table_reference_id.has_value());
        ASSERT_LT(*cursor->table_reference_id, script.analyzed_script->table_references.size());
        auto& table_ref = script.analyzed_script->table_references[*cursor->table_reference_id];
        auto table_name = print_name(script, table_ref.table_name);
        ASSERT_EQ(table_name, expected.table_ref_name);
    } else {
        ASSERT_FALSE(cursor->table_reference_id.has_value());
    }
    // Check column reference
    if (expected.column_ref_name.has_value()) {
        ASSERT_TRUE(cursor->column_reference_id.has_value());
        ASSERT_LT(*cursor->column_reference_id, script.analyzed_script->column_references.size());
        auto& column_ref = script.analyzed_script->column_references[*cursor->column_reference_id];
        auto column_name = print_name(script, column_ref.column_name);
        ASSERT_EQ(column_name, expected.column_ref_name);
    } else {
        ASSERT_FALSE(cursor->column_reference_id.has_value());
    }
    // Check graph edge
    if (!expected.graph_from.empty() || !expected.graph_to.empty()) {
        ASSERT_TRUE(cursor->query_edge_id.has_value());
        auto& edge = script.analyzed_script->graph_edges[*cursor->query_edge_id];
        std::vector<std::string> from;
        std::vector<std::string> to;
        for (size_t i = 0; i < edge.node_count_left; ++i) {
            auto graph_node = script.analyzed_script->graph_edge_nodes[edge.nodes_begin + i];
            auto& col_ref = script.analyzed_script->column_references[graph_node.column_reference_id];
            from.push_back(print_name(script, col_ref.column_name));
        }
        for (size_t i = 0; i < edge.node_count_right; ++i) {
            auto graph_node = script.analyzed_script->graph_edge_nodes[edge.nodes_begin + edge.node_count_left + i];
            auto& col_ref = script.analyzed_script->column_references[graph_node.column_reference_id];
            to.push_back(print_name(script, col_ref.column_name));
        }
        ASSERT_EQ(from, expected.graph_from);
        ASSERT_EQ(to, expected.graph_to);
    } else {
        ASSERT_FALSE(cursor->query_edge_id.has_value());
    }
}

TEST(CursorTest, SimpleNoExternal) {
    Script script{1};
    script.InsertTextAt(0, "select * from A b, C d where b.x = d.y");
    auto [scanned, scan_status] = script.Scan();
    ASSERT_EQ(scan_status, proto::StatusCode::OK);
    auto [parsed, parse_status] = script.Parse();
    ASSERT_EQ(parse_status, proto::StatusCode::OK);
    auto [analyzed, analysis_status] = script.Analyze();
    ASSERT_EQ(analysis_status, proto::StatusCode::OK);

    test(script, 0,
         {
             .scanner_token_text = "select",
             .statement_id = 0,
             .ast_attribute_key = proto::AttributeKey::NONE,
             .ast_node_type = proto::NodeType::OBJECT_SQL_SELECT,
         });
    test(script, 9,
         {
             .scanner_token_text = "from",
             .statement_id = 0,
             .ast_attribute_key = proto::AttributeKey::SQL_SELECT_FROM,
             .ast_node_type = proto::NodeType::ARRAY,
         });
    test(script, 14,
         {
             .scanner_token_text = "A",
             .statement_id = 0,
             .ast_attribute_key = proto::AttributeKey::NONE,
             .ast_node_type = proto::NodeType::NAME,
             .table_ref_name = "a",
         });
    test(script, 16,
         {
             .scanner_token_text = "b",
             .statement_id = 0,
             .ast_attribute_key = proto::AttributeKey::SQL_TABLEREF_ALIAS,
             .ast_node_type = proto::NodeType::NAME,
             .table_ref_name = "a",
         });
    test(script, 23,
         {
             .scanner_token_text = "where",
             .statement_id = 0,
             .ast_attribute_key = proto::AttributeKey::NONE,
             .ast_node_type = proto::NodeType::OBJECT_SQL_SELECT,
         });
    test(script, 29,
         {
             .scanner_token_text = "b",
             .statement_id = 0,
             .ast_attribute_key = proto::AttributeKey::NONE,
             .ast_node_type = proto::NodeType::NAME,
             .column_ref_name = "b.x",
             .graph_from = {"b.x"},
             .graph_to = {"d.y"},
         });
    test(script, 30,
         {
             .scanner_token_text = ".",
             .statement_id = 0,
             .ast_attribute_key = proto::AttributeKey::SQL_COLUMN_REF_PATH,
             .ast_node_type = proto::NodeType::ARRAY,
             .column_ref_name = "b.x",
             .graph_from = {"b.x"},
             .graph_to = {"d.y"},
         });
    test(script, 31,
         {
             .scanner_token_text = "x",
             .statement_id = 0,
             .ast_attribute_key = proto::AttributeKey::NONE,
             .ast_node_type = proto::NodeType::NAME,
             .column_ref_name = "b.x",
             .graph_from = {"b.x"},
             .graph_to = {"d.y"},
         });
    test(script, 33,
         {
             .scanner_token_text = "=",
             .statement_id = 0,
             .ast_attribute_key = proto::AttributeKey::SQL_EXPRESSION_OPERATOR,
             .ast_node_type = proto::NodeType::ENUM_SQL_EXPRESSION_OPERATOR,
             .graph_from = {"b.x"},
             .graph_to = {"d.y"},
         });
}

}  // namespace
