#include "sqlynx/script.h"

#include <flatbuffers/flatbuffer_builder.h>

#include <algorithm>
#include <chrono>
#include <memory>
#include <optional>
#include <unordered_set>

#include "sqlynx/analyzer/analyzer.h"
#include "sqlynx/analyzer/completion.h"
#include "sqlynx/catalog.h"
#include "sqlynx/external.h"
#include "sqlynx/parser/parse_context.h"
#include "sqlynx/parser/parser.h"
#include "sqlynx/parser/scanner.h"
#include "sqlynx/proto/proto_generated.h"

namespace sqlynx {

/// Finish a statement
std::unique_ptr<proto::StatementT> ParsedScript::Statement::Pack() {
    auto stmt = std::make_unique<proto::StatementT>();
    stmt->statement_type = type;
    stmt->root_node = root;
    stmt->nodes_begin = nodes_begin;
    stmt->node_count = node_count;
    return stmt;
}

/// Constructor
ScannedScript::ScannedScript(const rope::Rope& text, uint32_t external_id)
    : external_id(external_id), text_buffer(text.ToString(true)) {}
/// Constructor
ScannedScript::ScannedScript(std::string text, uint32_t external_id)
    : external_id(external_id), text_buffer(std::move(text)) {
    if (text_buffer.size() < 2) {
        text_buffer.resize(2);
    }
    text_buffer[text_buffer.size() - 1] = 0;
    text_buffer[text_buffer.size() - 2] = 0;
}

/// Find a token at a text offset
ScannedScript::LocationInfo ScannedScript::FindSymbol(size_t text_offset) {
    using RelativePosition = ScannedScript::LocationInfo::RelativePosition;
    auto& chunks = symbols.GetChunks();
    auto user_text_end = std::max<size_t>(text_buffer.size(), 2) - 2;
    text_offset = std::min<size_t>(user_text_end, text_offset);

    // Helper to get the previous symbol (if there is one) auto get_prev_symbol =
    auto get_prev_symbol =
        [&](size_t chunk_id,
            size_t chunk_symbol_id) -> std::optional<std::reference_wrapper<parser::Parser::symbol_type>> {
        auto& chunk = chunks[chunk_id];
        std::optional<std::reference_wrapper<parser::Parser::symbol_type>> prev_symbol;
        if (chunk_symbol_id > 0) {
            auto prev_chunk_token_id = chunk_symbol_id - 1;
            prev_symbol = chunk[prev_chunk_token_id];
        } else if (chunk_id > 0) {
            auto prev_chunk_id = chunk_id - 1;
            auto& prev_chunk = chunks[prev_chunk_id];
            assert(!prev_chunk.empty());
            auto prev_chunk_token_id = prev_chunk.size() - 1;
            prev_symbol = prev_chunk[chunk_symbol_id];
        }
        return prev_symbol;
    };

    // Helper to determine the insert mode
    auto get_relative_position = [&](size_t text_offset, size_t chunk_id, size_t chunk_symbol_id) -> RelativePosition {
        // Should actually never happen.
        // We're never pointing one past the last chunk after searching the symbol.
        if (chunk_id >= chunks.size()) {
            return RelativePosition::NEW_SYMBOL_AFTER;
        }
        auto& chunk = chunks[chunk_id];
        auto symbol = chunk[chunk_symbol_id];
        auto symbol_begin = symbol.location.offset();
        auto symbol_end = symbol.location.offset() + symbol.location.length();

        // Before the symbol?
        // Can happen wen the offset points at the beginning of the text
        if (text_offset < symbol_begin) {
            return RelativePosition::NEW_SYMBOL_BEFORE;
        }
        // Begin of the token?
        if (text_offset == symbol_begin) {
            return RelativePosition::BEGIN_OF_SYMBOL;
        }
        // End of the token?
        if (text_offset == symbol_end) {
            return RelativePosition::END_OF_SYMBOL;
        }
        // Mid of the token?
        if (text_offset > symbol_begin && (text_offset < symbol_end)) {
            return RelativePosition::MID_OF_SYMBOL;
        }
        // This happens when we're pointing at white-space after a symbol.
        // (end + 1), since end emits END_OF_SYMBOL
        return RelativePosition::NEW_SYMBOL_AFTER;
    };

    // Find chunk that contains the text offset.
    // Chunks grow exponentially in size, so this is logarithmic in cost
    auto chunk_iter = chunks.begin();
    size_t chunk_token_base_id = 0;
    for (; chunk_iter != chunks.end(); ++chunk_iter) {
        size_t text_from = chunk_iter->front().location.offset();
        if (text_from > text_offset) {
            break;
        }
        chunk_token_base_id += chunk_iter->size();
    }

    // Get previous chunk
    if (chunk_iter > chunks.begin()) {
        --chunk_iter;
        chunk_token_base_id -= chunk_iter->size();
    }

    // Otherwise we found a chunk that contains the text offset.
    // Binary search the token offset.
    auto symbol_iter =
        std::upper_bound(chunk_iter->begin(), chunk_iter->end(), text_offset,
                         [](size_t ofs, parser::Parser::symbol_type& token) { return ofs < token.location.offset(); });
    if (symbol_iter > chunk_iter->begin()) {
        --symbol_iter;
    }
    auto chunk_id = chunk_iter - chunks.begin();
    auto chunk_symbol_id = symbol_iter - chunk_iter->begin();
    auto global_symbol_id = chunk_token_base_id + chunk_symbol_id;
    assert(symbols.GetSize() >= 1);

    // Hit EOF? Get last token before EOF (if there is one)
    if (symbol_iter->kind_ == parser::Parser::symbol_kind::S_YYEOF) {
        if (chunk_symbol_id == 0) {
            if (chunk_iter > chunks.begin()) {
                --global_symbol_id;
                --chunk_iter;
                chunk_symbol_id = chunk_iter->size() - 1;
                symbol_iter = chunk_iter->begin() + chunk_symbol_id;
            } else {
                // Very first token is EOF token?
                // Special case empty script buffer
                return {0, 0, *symbol_iter, std::nullopt, RelativePosition::NEW_SYMBOL_BEFORE, true};
            }
        } else {
            --global_symbol_id;
            --chunk_symbol_id;
            --symbol_iter;
        }
    }

    // Return the global token offset
    auto prev_symbol = get_prev_symbol(chunk_iter - chunks.begin(), chunk_symbol_id);
    auto relative_pos = get_relative_position(text_offset, chunk_iter - chunks.begin(), chunk_symbol_id);
    assert(symbols.GetSize() >= 1);  // + EOF
    bool at_eof = (global_symbol_id + 1) >= symbols.GetSize();
    return {text_offset, global_symbol_id, *symbol_iter, prev_symbol, relative_pos, at_eof};
}

flatbuffers::Offset<proto::ScannedScript> ScannedScript::Pack(flatbuffers::FlatBufferBuilder& builder) {
    proto::ScannedScriptT out;
    out.external_id = external_id;
    out.errors.reserve(errors.size());
    for (auto& [loc, msg] : errors) {
        auto err = std::make_unique<proto::ErrorT>();
        err->location = std::make_unique<proto::Location>(loc);
        err->message = msg;
        out.errors.push_back(std::move(err));
    }
    out.tokens = PackTokens();
    out.line_breaks = line_breaks;
    out.comments = comments;
    return proto::ScannedScript::Pack(builder, &out);
}

/// Constructor
ParsedScript::ParsedScript(std::shared_ptr<ScannedScript> scan, parser::ParseContext&& ctx)
    : external_id(scan->external_id),
      scanned_script(scan),
      nodes(ctx.nodes.Flatten()),
      statements(std::move(ctx.statements)),
      errors(std::move(ctx.errors)) {
    assert(std::is_sorted(statements.begin(), statements.end(),
                          [](auto& l, auto& r) { return l.nodes_begin < r.nodes_begin; }));
}

/// Resolve an ast node
std::optional<std::pair<size_t, size_t>> ParsedScript::FindNodeAtOffset(size_t text_offset) const {
    if (statements.empty()) {
        return std::nullopt;
    }
    // Find statement that includes the text offset by searching the predecessor of the first statement after the text
    // offset
    size_t statement_id = 0;
    for (; statement_id < statements.size(); ++statement_id) {
        if (nodes[statements[statement_id].root].location().offset() > text_offset) {
            break;
        }
    }
    // First statement and begins > text_offset, bail out
    if (statement_id == 0) {
        return std::nullopt;
    }
    --statement_id;
    // Traverse down the AST
    auto iter = statements[statement_id].root;
    while (true) {
        // Reached node without children? Then return that node
        auto& node = nodes[iter];
        if (node.children_count() == 0) {
            break;
        }
        // Otherwise find the first child that includes the offset
        // Children are not ordered by location but ideally, there should only be a single match.
        std::optional<size_t> child_exact;
        std::optional<size_t> child_end_plus_1;
        for (size_t i = 0; i < node.children_count(); ++i) {
            auto ci = node.children_begin_or_value() + i;
            auto node_begin = nodes[ci].location().offset();
            auto node_end = node_begin + nodes[ci].location().length();
            // Includes the offset?
            // Note that we want an exact match here since AST nodes will include "holes".
            // For example, a select clause does not emit a node for a FROM keyword.
            // It would be misleading if we'd return the closest node that is materialized in the AST.
            if (node_begin <= text_offset) {
                if (node_end > text_offset) {
                    child_exact = ci;
                } else if (node_end == text_offset) {
                    child_end_plus_1 = ci;
                }
            }
        }
        auto child = child_exact.has_value() ? child_exact : child_end_plus_1;
        if (!child.has_value()) {
            // None of the children included the text offset.
            // Abort and return the current node as best match.
            break;
        }
        // Traverse down
        iter = *child;
        child_exact.reset();
        child_end_plus_1.reset();
    }
    // Return (statement, node)-pair
    return std::make_pair(statement_id, iter);
}

/// Pack the FlatBuffer
flatbuffers::Offset<proto::ParsedScript> ParsedScript::Pack(flatbuffers::FlatBufferBuilder& builder) {
    proto::ParsedScriptT out;
    out.external_id = external_id;
    out.nodes = nodes;
    out.statements.reserve(statements.size());
    for (auto& stmt : statements) {
        out.statements.push_back(stmt.Pack());
    }
    out.errors.reserve(errors.size());
    for (auto& [loc, msg] : errors) {
        auto err = std::make_unique<proto::ErrorT>();
        err->location = std::make_unique<proto::Location>(loc);
        err->message = msg;
        out.errors.push_back(std::move(err));
    }
    return proto::ParsedScript::Pack(builder, &out);
}

flatbuffers::Offset<proto::QualifiedTableName> AnalyzedScript::QualifiedTableName::Pack(
    flatbuffers::FlatBufferBuilder& builder) const {
    flatbuffers::Offset<flatbuffers::String> database_name_ofs;
    flatbuffers::Offset<flatbuffers::String> schema_name_ofs;
    flatbuffers::Offset<flatbuffers::String> table_name_ofs;
    if (!database_name.get().text.empty()) {
        database_name_ofs = builder.CreateString(database_name.get().text);
    }
    if (!schema_name.get().text.empty()) {
        schema_name_ofs = builder.CreateString(schema_name.get().text);
    }
    if (!table_name.get().text.empty()) {
        table_name_ofs = builder.CreateString(table_name.get().text);
    }
    proto::QualifiedTableNameBuilder out{builder};
    out.add_ast_node_id(ast_node_id.value_or(PROTO_NULL_U32));
    out.add_database_name(database_name_ofs);
    out.add_schema_name(schema_name_ofs);
    out.add_table_name(table_name_ofs);
    return out.Finish();
}

flatbuffers::Offset<proto::QualifiedColumnName> AnalyzedScript::QualifiedColumnName::Pack(
    flatbuffers::FlatBufferBuilder& builder) const {
    flatbuffers::Offset<flatbuffers::String> table_alias_ofs;
    flatbuffers::Offset<flatbuffers::String> column_name_ofs;
    if (table_alias && !table_alias.value().get().text.empty()) {
        table_alias_ofs = builder.CreateString(table_alias.value().get().text);
    }
    if (!column_name.get().text.empty()) {
        column_name_ofs = builder.CreateString(column_name.get().text);
    }
    proto::QualifiedColumnNameBuilder out{builder};
    out.add_ast_node_id(ast_node_id.value_or(PROTO_NULL_U32));
    out.add_table_alias(table_alias_ofs);
    out.add_column_name(column_name_ofs);
    return out.Finish();
}

/// Pack as FlatBuffer
flatbuffers::Offset<proto::TableReference> AnalyzedScript::TableReference::Pack(
    flatbuffers::FlatBufferBuilder& builder) const {
    std::optional<proto::TableReferenceSubType> inner_type;
    flatbuffers::Offset<void> inner_ofs;
    switch (inner.index()) {
        case 1: {
            auto& unresolved = std::get<AnalyzedScript::TableReference::UnresolvedRelationExpression>(inner);
            auto table_name_ofs = unresolved.table_name.Pack(builder);
            proto::UnresolvedRelationExpressionBuilder out{builder};
            out.add_table_name(table_name_ofs);
            inner_ofs = out.Finish().Union();
            inner_type = proto::TableReferenceSubType::UnresolvedRelationExpression;
            break;
        }
        case 2: {
            auto& resolved = std::get<AnalyzedScript::TableReference::ResolvedRelationExpression>(inner);
            auto table_name_ofs = resolved.table_name.Pack(builder);
            proto::ResolvedRelationExpressionBuilder out{builder};
            out.add_table_name(table_name_ofs);
            out.add_catalog_database_id(resolved.catalog_database_id);
            out.add_catalog_schema_id(resolved.catalog_schema_id);
            out.add_catalog_table_id(resolved.catalog_table_id.Pack());
            inner_ofs = out.Finish().Union();
            inner_type = proto::TableReferenceSubType::ResolvedRelationExpression;
            break;
        }
    }
    flatbuffers::Offset<flatbuffers::String> alias_name_ofs;
    if (alias_name.has_value()) {
        alias_name_ofs = builder.CreateString(alias_name.value().get().text);
    }
    proto::TableReferenceBuilder out{builder};
    out.add_ast_node_id(ast_node_id);
    out.add_ast_scope_root(ast_scope_root.value_or(std::numeric_limits<uint32_t>::max()));
    out.add_ast_statement_id(ast_statement_id.value_or(std::numeric_limits<uint32_t>::max()));
    if (alias_name.has_value()) {
        out.add_alias_name(alias_name_ofs);
    }
    if (inner_type.has_value()) {
        out.add_inner_type(inner_type.value());
        out.add_inner(inner_ofs);
    }
    return out.Finish();
}

/// Pack as FlatBuffer
flatbuffers::Offset<proto::Expression> AnalyzedScript::Expression::Pack(flatbuffers::FlatBufferBuilder& builder) const {
    std::optional<proto::ExpressionSubType> inner_type;
    flatbuffers::Offset<void> inner_ofs;
    switch (inner.index()) {
        case 1: {
            auto& unresolved = std::get<AnalyzedScript::Expression::UnresolvedColumnRef>(inner);
            auto column_name_ofs = unresolved.column_name.Pack(builder);
            proto::UnresolvedColumnRefExpressionBuilder out{builder};
            out.add_column_name(column_name_ofs);
            inner_ofs = out.Finish().Union();
            inner_type = proto::ExpressionSubType::UnresolvedColumnRefExpression;
            break;
        }
        case 2: {
            auto& resolved = std::get<AnalyzedScript::Expression::ResolvedColumnRef>(inner);
            auto column_name_ofs = resolved.column_name.Pack(builder);
            proto::ResolvedColumnRefExpressionBuilder out{builder};
            out.add_column_name(column_name_ofs);
            out.add_catalog_database_id(resolved.catalog_database_id);
            out.add_catalog_schema_id(resolved.catalog_schema_id);
            out.add_catalog_table_id(resolved.catalog_table_id.Pack());
            out.add_column_id(resolved.table_column_id);
            inner_ofs = out.Finish().Union();
            inner_type = proto::ExpressionSubType::ResolvedColumnRefExpression;
            break;
        }
        default:
            break;
    }
    proto::ExpressionBuilder out{builder};
    out.add_ast_node_id(ast_node_id);
    out.add_ast_scope_root(ast_scope_root.value_or(std::numeric_limits<uint32_t>::max()));
    out.add_ast_statement_id(ast_statement_id.value_or(std::numeric_limits<uint32_t>::max()));
    if (inner_type.has_value()) {
        out.add_inner_type(inner_type.value());
        out.add_inner(inner_ofs);
    }
    return out.Finish();
}

/// Constructor
AnalyzedScript::AnalyzedScript(std::shared_ptr<ParsedScript> parsed, Catalog& catalog)
    : CatalogEntry(catalog, parsed->external_id),
      default_database_name(parsed->scanned_script->name_registry.Register(catalog.GetDefaultDatabaseName())),
      default_schema_name(parsed->scanned_script->name_registry.Register(catalog.GetDefaultSchemaName())),
      parsed_script(std::move(parsed)),
      catalog_version(catalog.GetVersion()) {}

/// Get the name search index
flatbuffers::Offset<proto::CatalogEntry> AnalyzedScript::DescribeEntry(flatbuffers::FlatBufferBuilder& builder) const {
    std::vector<flatbuffers::Offset<proto::SchemaTable>> table_offsets;
    table_offsets.reserve(table_declarations.GetSize());
    uint32_t table_id = 0;
    for (auto& table_chunk : table_declarations.GetChunks()) {
        for (auto& table : table_chunk) {
            auto table_name = builder.CreateString(table.table_name.table_name.get().text);

            std::vector<flatbuffers::Offset<proto::SchemaTableColumn>> column_offsets;
            column_offsets.reserve(table.table_columns.size());
            for (auto& column : table.table_columns) {
                auto column_name = builder.CreateString(column.column_name.get().text);
                proto::SchemaTableColumnBuilder column_builder{builder};
                column_builder.add_column_name(column_name);
                column_offsets.push_back(column_builder.Finish());
            }
            auto columns_offset = builder.CreateVector(column_offsets);

            proto::SchemaTableBuilder table_builder{builder};
            table_builder.add_table_id(table_id++);
            table_builder.add_table_name(table_name);
            table_builder.add_columns(columns_offset);
        }
    }
    auto tables_offset = builder.CreateVector(table_offsets);

    proto::SchemaDescriptorBuilder schemaBuilder{builder};
    schemaBuilder.add_tables(tables_offset);
    auto schema_offset = schemaBuilder.Finish();
    std::vector<flatbuffers::Offset<proto::SchemaDescriptor>> schemas{schema_offset};
    auto schemas_offset = builder.CreateVector(schemas);

    proto::CatalogEntryBuilder catalog{builder};
    catalog.add_catalog_entry_id(catalog_entry_id);
    catalog.add_catalog_entry_type(proto::CatalogEntryType::DESCRIPTOR_POOL);
    catalog.add_rank(0);
    catalog.add_schemas(schemas_offset);
    return catalog.Finish();
}

/// Get the name search index
const CatalogEntry::NameSearchIndex& AnalyzedScript::GetNameSearchIndex() {
    if (!name_search_index.has_value()) {
        auto& index = name_search_index.emplace();
        auto& names = parsed_script->scanned_script->name_registry.GetChunks();
        for (auto& names_chunk : names) {
            for (auto& name : names_chunk) {
                auto s = name.text;
                for (size_t i = 1; i <= s.size(); ++i) {
                    auto suffix = s.substr(s.size() - i);
                    index.insert({{suffix.data(), suffix.size()}, name});
                }
            }
        }
    }
    return name_search_index.value();
}

template <typename In, typename Out, size_t ChunkSize>
static flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<Out>>> PackVector(
    flatbuffers::FlatBufferBuilder& builder, const ChunkBuffer<In, ChunkSize>& elems) {
    std::vector<flatbuffers::Offset<Out>> offsets;
    offsets.reserve(elems.GetSize());
    for (auto& chunk : elems.GetChunks()) {
        for (auto& elem : chunk) {
            offsets.push_back(elem.Pack(builder));
        }
    }
    return builder.CreateVector(offsets);
};

template <typename In, typename Out, size_t ChunkSize>
static flatbuffers::Offset<flatbuffers::Vector<const Out*>> packStructVector(flatbuffers::FlatBufferBuilder& builder,
                                                                             const ChunkBuffer<In, ChunkSize>& elems) {
    Out* writer;
    auto out = builder.CreateUninitializedVectorOfStructs(elems.GetSize(), &writer);
    for (auto& chunk : elems.GetChunks()) {
        for (auto& elem : chunk) {
            *(writer++) = static_cast<const Out>(elem);
        }
    }
    return out;
};

// Pack an analyzed script
flatbuffers::Offset<proto::AnalyzedScript> AnalyzedScript::Pack(flatbuffers::FlatBufferBuilder& builder) {
    // Pack tables
    flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<proto::Table>>> tables_ofs;
    {
        std::vector<flatbuffers::Offset<proto::Table>> table_offsets;
        table_offsets.reserve(table_declarations.GetSize());
        for (auto& table_chunk : table_declarations.GetChunks()) {
            for (auto& table : table_chunk) {
                table_offsets.push_back(table.Pack(builder));
            }
        }
        tables_ofs = builder.CreateVector(table_offsets);
    }
    // Pack table references
    auto table_references_ofs =
        PackVector<AnalyzedScript::TableReference, proto::TableReference>(builder, table_references);
    // Pack expressions
    auto expressions_ofs = PackVector<AnalyzedScript::Expression, proto::Expression>(builder, expressions);

    // Build index: (db_id, schema_id, table_id) -> table_ref*
    flatbuffers::Offset<flatbuffers::Vector<const proto::IndexedTableReference*>> table_refs_by_id_ofs;
    {
        std::vector<proto::IndexedTableReference> table_refs_by_id;
        table_refs_by_id.reserve(table_references.GetSize());
        table_references.ForEach([&](size_t ref_id, TableReference& ref) {
            if (auto* resolved = std::get_if<TableReference::ResolvedRelationExpression>(&ref.inner)) {
                assert(resolved->catalog_database_id != std::numeric_limits<uint32_t>::max());
                assert(resolved->catalog_schema_id != std::numeric_limits<uint32_t>::max());
                table_refs_by_id.emplace_back(resolved->catalog_database_id, resolved->catalog_schema_id,
                                              resolved->catalog_table_id.Pack(), ref_id);
            }
        });
        std::sort(table_refs_by_id.begin(), table_refs_by_id.end(),
                  [&](proto::IndexedTableReference& l, proto::IndexedTableReference& r) {
                      auto a = std::make_tuple(l.catalog_database_id(), l.catalog_schema_id(), l.catalog_table_id());
                      auto b = std::make_tuple(r.catalog_database_id(), r.catalog_schema_id(), r.catalog_table_id());
                      return a < b;
                  });
        table_refs_by_id_ofs = builder.CreateVectorOfStructs(table_refs_by_id);
    }

    // Build index: (db_id, schema_id, table_id, column_id) -> column_ref*
    flatbuffers::Offset<flatbuffers::Vector<const proto::IndexedColumnReference*>> column_refs_by_id_ofs;
    {
        std::vector<proto::IndexedColumnReference> column_refs_by_id;
        column_refs_by_id.reserve(expressions.GetSize());
        expressions.ForEach([&](size_t ref_id, Expression& ref) {
            if (auto* resolved = std::get_if<AnalyzedScript::Expression::ResolvedColumnRef>(&ref.inner)) {
                assert(resolved->catalog_database_id != std::numeric_limits<uint32_t>::max());
                assert(resolved->catalog_schema_id != std::numeric_limits<uint32_t>::max());
                assert(resolved->table_column_id);
                column_refs_by_id.emplace_back(resolved->catalog_database_id, resolved->catalog_schema_id,
                                               resolved->catalog_table_id.Pack(), resolved->table_column_id, ref_id);
            }
        });
        std::sort(column_refs_by_id.begin(), column_refs_by_id.end(),
                  [&](proto::IndexedColumnReference& l, proto::IndexedColumnReference& r) {
                      auto a = std::make_tuple(l.catalog_database_id(), l.catalog_schema_id(), l.catalog_table_id(),
                                               l.table_column_id());
                      auto b = std::make_tuple(r.catalog_database_id(), r.catalog_schema_id(), r.catalog_table_id(),
                                               r.table_column_id());
                      return a < b;
                  });
        column_refs_by_id_ofs = builder.CreateVectorOfStructs(column_refs_by_id);
    }

    proto::AnalyzedScriptBuilder out{builder};
    out.add_catalog_entry_id(catalog_entry_id);
    out.add_tables(tables_ofs);
    out.add_table_references(table_references_ofs);
    out.add_expressions(expressions_ofs);
    out.add_table_references_by_id(table_refs_by_id_ofs);
    out.add_column_references_by_id(column_refs_by_id_ofs);
    return out.Finish();
}

Script::Script(Catalog& catalog, uint32_t external_id) : catalog(catalog), catalog_entry_id(external_id), text(1024) {
    assert(!catalog.Contains(external_id));
}

Script::~Script() { catalog.DropScript(*this); }

/// Insert a character at an offet
void Script::InsertCharAt(size_t char_idx, uint32_t unicode) {
    std::array<std::byte, 6> buffer;
    auto length = sqlynx::utf8::utf8proc_encode_char(unicode, reinterpret_cast<uint8_t*>(buffer.data()));
    std::string_view encoded{reinterpret_cast<char*>(buffer.data()), static_cast<size_t>(length)};
    text.Insert(char_idx, encoded);
}
/// Insert a text at an offet
void Script::InsertTextAt(size_t char_idx, std::string_view encoded) { text.Insert(char_idx, encoded); }
/// Erase a text at an offet
void Script::EraseTextRange(size_t char_idx, size_t count) { text.Remove(char_idx, count); }
/// Replace the text in the script
void Script::ReplaceText(std::string_view encoded) { text = rope::Rope{1024, encoded}; }
/// Print a script as string
std::string Script::ToString() { return text.ToString(); }

/// Returns the pretty-printed string for this script.
std::string Script::Format() {
    // TODO: actually implement formatting
    return "formatted[" + text.ToString() + "]";
}

/// Update memory statisics
std::unique_ptr<proto::ScriptMemoryStatistics> Script::GetMemoryStatistics() {
    auto memory = std::make_unique<proto::ScriptMemoryStatistics>();
    memory->mutate_rope_bytes(text.GetStats().text_bytes);

    std::unordered_set<const ScannedScript*> registered_scanned;
    std::unordered_set<const ParsedScript*> registered_parsed;
    std::unordered_set<const AnalyzedScript*> registered_analyzed;
    registered_scanned.reserve(4);
    registered_parsed.reserve(4);
    registered_analyzed.reserve(4);
    auto registerScript = [&](AnalyzedScript* analyzed, proto::ScriptProcessingMemoryStatistics& stats) {
        if (!analyzed) return;
        // Added analyzed before?
        if (registered_analyzed.contains(analyzed)) return;
        size_t table_column_bytes = 0;
        for (auto& table_chunk : analyzed->table_declarations.GetChunks()) {
            for (auto& table : table_chunk) {
                table_column_bytes += table.table_columns.size() * sizeof(CatalogEntry::TableColumn);
            }
        }
        size_t analyzer_description_bytes =
            analyzed->table_declarations.GetSize() * sizeof(CatalogEntry::TableDeclaration) + table_column_bytes +
            analyzed->table_references.GetSize() * sizeof(decltype(analyzed->table_references)::value_type) +
            analyzed->expressions.GetSize() * sizeof(decltype(analyzed->expressions)::value_type);
        size_t analyzer_name_index_bytes = 0;
        size_t analyzer_name_search_index_size = 0;
        if (auto& index = analyzed->name_search_index) {
            analyzer_name_index_bytes = index->size() * index->average_bytes_per_value();
            analyzer_name_search_index_size = index->size();
        }
        stats.mutate_analyzer_description_bytes(analyzer_description_bytes);
        stats.mutate_analyzer_name_index_size(analyzer_name_search_index_size);
        stats.mutate_analyzer_name_index_bytes(analyzer_name_index_bytes);

        // Added parsed before?
        ParsedScript* parsed = analyzed->parsed_script.get();
        if (registered_parsed.contains(parsed)) return;
        size_t parser_ast_bytes = parsed->nodes.size() * sizeof(decltype(parsed->nodes)::value_type);
        stats.mutate_parser_ast_bytes(parser_ast_bytes);

        // Added scanned before?
        ScannedScript* scanned = parsed->scanned_script.get();
        if (registered_scanned.contains(scanned)) return;
        size_t scanner_symbol_bytes = scanned->symbols.GetSize() + sizeof(parser::Parser::symbol_type);
        size_t scanner_dictionary_bytes = scanned->name_pool.GetSize() + scanned->name_registry.GetByteSize();
        stats.mutate_scanner_input_bytes(scanned->GetInput().size());
        stats.mutate_scanner_symbol_bytes(scanner_symbol_bytes);
        stats.mutate_scanner_name_dictionary_bytes(scanner_dictionary_bytes);
    };
    registerScript(analyzed_script.get(), memory->mutable_latest_script());
    return memory;
}

/// Get statisics
std::unique_ptr<proto::ScriptStatisticsT> Script::GetStatistics() {
    auto stats = std::make_unique<proto::ScriptStatisticsT>();
    stats->memory = GetMemoryStatistics();
    stats->timings = std::make_unique<proto::ScriptProcessingTimings>(timing_statistics);
    return stats;
}

/// Scan a script
std::pair<ScannedScript*, proto::StatusCode> Script::Scan() {
    auto time_start = std::chrono::steady_clock::now();
    auto [script, status] = parser::Scanner::Scan(text, catalog_entry_id);
    scanned_script = std::move(script);
    timing_statistics.mutate_scanner_last_elapsed(
        std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - time_start).count());
    return {scanned_script.get(), status};
}
/// Parse a script
std::pair<ParsedScript*, proto::StatusCode> Script::Parse() {
    auto time_start = std::chrono::steady_clock::now();
    auto [script, status] = parser::Parser::Parse(scanned_script);
    parsed_script = std::move(script);
    timing_statistics.mutate_parser_last_elapsed(
        std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - time_start).count());
    return {parsed_script.get(), status};
}

/// Analyze a script
std::pair<AnalyzedScript*, proto::StatusCode> Script::Analyze() {
    auto time_start = std::chrono::steady_clock::now();

    // Check if the script was already analyzed.
    // In that case, we have to clean up anything that we "registered" in the scanned script before.
    if (analyzed_script && scanned_script) {
        for (auto& chunk : scanned_script->name_registry.GetChunks()) {
            for (auto& entry : chunk) {
                entry.resolved_tags = 0;
                entry.resolved_objects.Clear();
            }
        }
    }

    // Analyze a script
    auto [script, status] = Analyzer::Analyze(parsed_script, catalog);
    if (status != proto::StatusCode::OK) {
        return {nullptr, status};
    }
    analyzed_script = std::move(script);

    // Update step timings
    timing_statistics.mutate_analyzer_last_elapsed(
        std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - time_start).count());
    return {analyzed_script.get(), status};
}

/// Move the cursor to a offset
std::pair<const ScriptCursor*, proto::StatusCode> Script::MoveCursor(size_t text_offset) {
    auto [maybe_cursor, status] = ScriptCursor::Place(*this, text_offset);
    if (status == proto::StatusCode::OK) {
        cursor = std::move(maybe_cursor);
    }
    return {cursor.get(), status};
}
/// Complete at the cursor
std::pair<std::unique_ptr<Completion>, proto::StatusCode> Script::CompleteAtCursor(size_t limit) const {
    // Fail if the user forgot to move the cursor
    if (cursor == nullptr) {
        return {nullptr, proto::StatusCode::COMPLETION_MISSES_CURSOR};
    }
    // Fail if the scanner is not associated with a scanner token
    if (!cursor->scanner_location.has_value()) {
        return {nullptr, proto::StatusCode::COMPLETION_MISSES_SCANNER_TOKEN};
    }
    // Compute the completion
    return Completion::Compute(*cursor, limit);
}

void AnalyzedScript::FollowPathUpwards(uint32_t ast_node_id, std::vector<uint32_t>& ast_node_path,
                                       std::vector<std::reference_wrapper<AnalyzedScript::NameScope>>& scopes) const {
    assert(parsed_script != nullptr);

    ast_node_path.clear();
    scopes.clear();

    // Traverse all parent ids of the node
    auto& nodes = parsed_script->nodes;
    for (std::optional<size_t> node_iter = ast_node_id; node_iter.has_value();
         node_iter = nodes[node_iter.value()].parent() != node_iter.value()
                         ? std::optional{nodes[node_iter.value()].parent()}
                         : std::nullopt) {
        // Remember the node path
        ast_node_path.push_back(*node_iter);
        // Probe the name scopes
        auto scope_iter = name_scopes_by_root_node.find(node_iter.value());
        if (scope_iter != name_scopes_by_root_node.end()) {
            scopes.push_back(scope_iter->second);
        }
    }
}

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
