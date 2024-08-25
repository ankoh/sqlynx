#include "gtest/gtest.h"
#include "sqlynx/analyzer/analyzer.h"
#include "sqlynx/analyzer/completion.h"
#include "sqlynx/parser/parser.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"

using namespace sqlynx;

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
    std::stringstream out;
    size_t out_idx = 0;
    auto write = [&](std::string_view name) {
        if (!name.empty()) {
            if (out_idx++ > 0) {
                out << ".";
            }
            out << name;
        }
    };
    write(name.database_name.get());
    write(name.schema_name.get());
    write(name.table_name.get());
    return out.str();
}

std::string print_name(const Script& script, const AnalyzedScript::QualifiedColumnName& name) {
    auto& scanned = script.scanned_script;
    std::stringstream out;
    size_t out_idx = 0;
    auto write = [&](std::string_view name) {
        if (!name.empty()) {
            if (out_idx++ > 0) {
                out << ".";
            }
            out << name;
        }
    };
    write(name.table_alias ? name.table_alias->get().text : "");
    write(name.column_name.get());
    return out.str();
}

void test(Script& script, size_t text_offset, ExpectedScriptCursor expected) {
    SCOPED_TRACE(std::string{"CURSOR "} + std::to_string(text_offset));
    auto [cursor, status] = script.MoveCursor(text_offset);
    ASSERT_EQ(status, proto::StatusCode::OK);
    // Check scanner token
    if (expected.scanner_token_text.has_value()) {
        ASSERT_TRUE(cursor->scanner_location.has_value());
        auto token = script.scanned_script->GetSymbols()[cursor->scanner_location->symbol_id];
        auto token_text = script.scanned_script->ReadTextAtLocation(token.location);
        ASSERT_EQ(token_text, *expected.scanner_token_text);
    } else {
        ASSERT_FALSE(cursor->scanner_location.has_value());
    }
    // Check statement id
    ASSERT_EQ(cursor->statement_id, expected.statement_id);
    // Check AST node type
    auto& ast_node = script.analyzed_script->parsed_script->nodes[*cursor->ast_node_id];
    ASSERT_EQ(ast_node.attribute_key(), expected.ast_attribute_key)
        << proto::EnumNameAttributeKey(ast_node.attribute_key());
    ASSERT_EQ(ast_node.node_type(), expected.ast_node_type) << proto::EnumNameNodeType(ast_node.node_type());
    // Check table reference
    if (expected.table_ref_name.has_value()) {
        ASSERT_TRUE(cursor->table_reference_id.has_value());
        ASSERT_LT(*cursor->table_reference_id, script.analyzed_script->table_references.GetSize());
        auto& table_ref = script.analyzed_script->table_references[*cursor->table_reference_id];
        auto table_name = print_name(script, table_ref->table_name);
        ASSERT_EQ(table_name, expected.table_ref_name);
    } else {
        ASSERT_FALSE(cursor->table_reference_id.has_value());
    }
    // Check expression
    if (expected.column_ref_name.has_value()) {
        ASSERT_TRUE(cursor->expression_id.has_value());
        ASSERT_LT(*cursor->expression_id, script.analyzed_script->expressions.GetSize());
        auto& column_ref = script.analyzed_script->expressions[*cursor->expression_id];
        switch (column_ref->inner.index()) {
            case 0:
                break;
            case 1: {
                auto& unresolved = std::get<AnalyzedScript::Expression::UnresolvedColumnRef>(column_ref->inner);
                auto column_name = print_name(script, unresolved.column_name);
                ASSERT_EQ(column_name, expected.column_ref_name);
                break;
            }
            case 2: {
                auto& resolved = std::get<AnalyzedScript::Expression::ResolvedColumnRef>(column_ref->inner);
                auto column_name = print_name(script, resolved.column_name);
                ASSERT_EQ(column_name, expected.column_ref_name);
                break;
            }
        }
    } else {
        ASSERT_FALSE(cursor->expression_id.has_value());
    }
}

TEST(CursorTest, SimpleNoExternal) {
    Catalog catalog;
    Script script{catalog, 1};
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
             .table_ref_name = "sqlynx.default.a",
         });
    test(script, 16,
         {
             .scanner_token_text = "b",
             .statement_id = 0,
             .ast_attribute_key = proto::AttributeKey::SQL_TABLEREF_ALIAS,
             .ast_node_type = proto::NodeType::NAME,
             .table_ref_name = "sqlynx.default.a",
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
             .ast_attribute_key = proto::AttributeKey::NONE,
             .ast_node_type = proto::NodeType::NAME,
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
             .ast_attribute_key = proto::AttributeKey::SQL_EXPRESSION_ARGS,
             .ast_node_type = proto::NodeType::ARRAY,
             .graph_from = {"b.x"},
             .graph_to = {"d.y"},
         });
}

TEST(CursorTest, TableRef) {
    Catalog catalog;
    Script script{catalog, 1};
    script.InsertTextAt(0, "select r_regionkey from region, n");
    auto [scanned, scan_status] = script.Scan();
    ASSERT_EQ(scan_status, proto::StatusCode::OK);
    auto [parsed, parse_status] = script.Parse();
    ASSERT_EQ(parse_status, proto::StatusCode::OK);
    auto [analyzed, analysis_status] = script.Analyze();
    ASSERT_EQ(analysis_status, proto::StatusCode::OK);

    test(script, 32,
         {
             .scanner_token_text = "n",
             .statement_id = 0,
             .ast_attribute_key = proto::AttributeKey::NONE,
             .ast_node_type = proto::NodeType::NAME,
             .table_ref_name = "sqlynx.default.n",
         });
}

}  // namespace
