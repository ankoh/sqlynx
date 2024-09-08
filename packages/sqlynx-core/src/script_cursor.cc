#include "sqlynx/script.h"

namespace sqlynx {

ScriptCursor::ScriptCursor(const Script& script, size_t text_offset)
    : script(script), text_offset(text_offset), context(std::monostate{}) {}

/// Constructor
std::pair<std::unique_ptr<ScriptCursor>, proto::StatusCode> ScriptCursor::Place(const Script& script,
                                                                                size_t text_offset) {
    auto cursor = std::make_unique<ScriptCursor>(script, text_offset);

    // Has the script been scanned?
    if (script.scanned_script) {
        cursor->scanner_location.emplace(script.scanned_script->FindSymbol(text_offset));
        if (cursor->scanner_location) {
            auto& token = script.scanned_script->GetSymbols()[cursor->scanner_location->symbol_id];
            cursor->text = script.scanned_script->ReadTextAtLocation(token.location);
        }
    }

    // Has the script been parsed?
    if (script.parsed_script) {
        // Try to find the ast node the cursor is pointing at
        if (auto ast_node = script.parsed_script->FindNodeAtOffset(text_offset)) {
            // Try to find the ast node the cursor is pointing at
            cursor->statement_id = std::get<0>(*ast_node);
            cursor->ast_node_id = std::get<1>(*ast_node);

            // Analyzed and analyzed is same version as the parsed script?
            // Note that the user may re-parse and re-analyze a script after changes.
            // This ensures that we're consistent when building the cursor.
            auto& analyzed = script.analyzed_script;
            if (analyzed && analyzed->parsed_script == script.parsed_script) {
                // First find all name scopes that the ast node points into.
                script.analyzed_script->FollowPathUpwards(*cursor->ast_node_id, cursor->ast_path_to_root,
                                                          cursor->name_scopes);

                // Check if there's a table or column ref in the innermost scope containing the node
                if (cursor->name_scopes.size() != 0) {
                    auto& innermost_scope = cursor->name_scopes.front().get();
                    auto& nodes = script.parsed_script->nodes;

                    // Find first node that is a table or column ref
                    for (auto node_id : cursor->ast_path_to_root) {
                        bool matched = false;
                        switch (nodes[node_id].node_type()) {
                            // Node is a column ref?
                            // Then we check all expressions in the innermost scope.
                            case proto::NodeType::OBJECT_SQL_COLUMN_REF: {
                                matched = true;
                                for (auto& expression : innermost_scope.expressions) {
                                    if (node_id == expression.ast_node_id && expression.IsColumnRef()) {
                                        assert(expression.expression_id.GetExternalId() ==
                                               analyzed->GetCatalogEntryId());
                                        cursor->context = ColumnRefContext{expression.expression_id.GetIndex()};
                                    }
                                }
                                break;
                            }
                            // Node is a table ref?
                            // Then we check all table refs in the innermost scope.
                            case proto::NodeType::OBJECT_SQL_TABLEREF: {
                                matched = true;
                                for (auto& table_ref : innermost_scope.table_references) {
                                    if (node_id == table_ref.ast_node_id) {
                                        assert(table_ref.table_reference_id.GetExternalId() ==
                                               analyzed->GetCatalogEntryId());
                                        cursor->context = TableRefContext{table_ref.table_reference_id.GetIndex()};
                                    }
                                }
                                break;
                            }
                            default:
                                break;
                        }
                        // Stop when we reached the root of the innermost name scope.
                        if (matched || node_id == innermost_scope.ast_scope_root) {
                            break;
                        }
                    }
                }
            }
        }
    }
    return {std::move(cursor), proto::StatusCode::OK};
}

/// Pack the cursor info
flatbuffers::Offset<proto::ScriptCursor> ScriptCursor::Pack(flatbuffers::FlatBufferBuilder& builder) const {
    auto out = std::make_unique<proto::ScriptCursorT>();
    out->text_offset = text_offset;
    if (scanner_location) {
        auto& symbol = script.scanned_script->symbols[scanner_location->symbol_id];
        auto symbol_offset = symbol.location.offset();
        out->scanner_symbol_id = scanner_location->symbol_id;
        out->scanner_relative_position = static_cast<proto::RelativeSymbolPosition>(scanner_location->relative_pos);
        out->scanner_symbol_offset = symbol_offset;
        out->scanner_symbol_kind = static_cast<uint32_t>(symbol.kind_);
    } else {
        out->scanner_symbol_id = std::numeric_limits<uint32_t>::max();
        out->scanner_relative_position = proto::RelativeSymbolPosition::NEW_SYMBOL_AFTER;
        out->scanner_symbol_offset = 0;
        out->scanner_symbol_kind = 0;
    }
    out->statement_id = statement_id.value_or(std::numeric_limits<uint32_t>::max());
    out->ast_node_id = ast_node_id.value_or(std::numeric_limits<uint32_t>::max());
    out->ast_path_to_root = ast_path_to_root;
    out->name_scopes.reserve(name_scopes.size());
    for (auto& name_scope : name_scopes) {
        out->name_scopes.push_back(name_scope.get().name_scope_id);
    }
    switch (context.index()) {
        case 0:
            break;
        case 1: {
            auto& table_ref = std::get<ScriptCursor::TableRefContext>(context);
            auto ctx = std::make_unique<proto::ScriptCursorTableRefContextT>();
            ctx->table_reference_id = table_ref.table_reference_id;
            break;
        }
        case 2: {
            auto& column_ref = std::get<ScriptCursor::ColumnRefContext>(context);
            auto ctx = std::make_unique<proto::ScriptCursorColumnRefContextT>();
            ctx->expression_id = column_ref.expression_id;
            break;
        }
    }
    return proto::ScriptCursor::Pack(builder, out.get());
}

}  // namespace sqlynx
