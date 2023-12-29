#include "sqlynx/script.h"

#include <flatbuffers/flatbuffer_builder.h>

#include <algorithm>
#include <chrono>
#include <memory>
#include <optional>
#include <unordered_set>

#include "sqlynx/analyzer/analyzer.h"
#include "sqlynx/analyzer/completion.h"
#include "sqlynx/external.h"
#include "sqlynx/parser/parse_context.h"
#include "sqlynx/parser/parser.h"
#include "sqlynx/parser/scanner.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/schema.h"
#include "sqlynx/utils/string_conversion.h"
#include "sqlynx/utils/suffix_trie.h"

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
    : external_id(external_id), text_buffer(text.ToString(true)) {
    names_by_text.reserve(64);
    names_by_id.reserve(64);
}

/// Read a name
Schema::NameInfo& ScannedScript::ReadName(NameID name) {
    assert(names_by_id.contains(name));
    return names_by_id.at(name).get();
}

/// Register a name
NameID ScannedScript::RegisterKeywordAsName(std::string_view s, sx::Location location, sx::NameTag tag) {
    auto iter = names_by_text.find(s);
    if (iter != names_by_text.end()) {
        auto& name = iter->second.get();
        name.tags |= tag;
        name.occurrences += 1;
        return name.name_id;
    }
    NameID name_id = names.GetSize();
    auto& name = names.Append(
        Schema::NameInfo{.name_id = name_id, .text = s, .location = location, .tags = tag, .occurrences = 1});
    names_by_text.insert({s, name});
    names_by_id.insert({name_id, name});
    return name_id;
}

/// Register a name
NameID ScannedScript::RegisterName(std::string_view s, sx::Location location, sx::NameTag tag) {
    auto iter = names_by_text.find(s);
    if (iter != names_by_text.end()) {
        auto& name = iter->second.get();
        name.tags |= tag;
        name.occurrences += 1;
        return name.name_id;
    }
    NameID name_id = names.GetSize();
    auto& name = names.Append(
        Schema::NameInfo{.name_id = name_id, .text = s, .location = location, .tags = tag, .occurrences = 1});
    names_by_text.insert({s, name});
    names_by_id.insert({name_id, name});
    return name_id;
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
        if (chunk_id >= chunks.size()) {
            return RelativePosition::NEW_SYMBOL_AFTER;
        }
        auto& chunk = chunks[chunk_id];
        auto symbol = chunk[chunk_symbol_id];
        auto symbol_begin = symbol.location.offset();
        auto symbol_end = symbol.location.offset() + symbol.location.length();

        // Before the symbol?
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
std::optional<std::pair<size_t, size_t>> ParsedScript::FindNodeAtOffset(size_t text_offset) {
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
    if (!database_name.empty()) {
        database_name_ofs = builder.CreateString(database_name);
    }
    if (!schema_name.empty()) {
        schema_name_ofs = builder.CreateString(schema_name);
    }
    if (!table_name.empty()) {
        table_name_ofs = builder.CreateString(table_name);
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
    if (!table_alias.empty()) {
        table_alias_ofs = builder.CreateString(table_alias);
    }
    if (!column_name.empty()) {
        column_name_ofs = builder.CreateString(column_name);
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
    auto table_name_ofs = table_name.Pack(builder);
    auto alias_name_ofs = builder.CreateString(alias_name);
    proto::TableReferenceBuilder out{builder};
    out.add_ast_node_id(ast_node_id.value_or(std::numeric_limits<uint32_t>::max()));
    out.add_ast_scope_root(ast_scope_root.value_or(std::numeric_limits<uint32_t>::max()));
    out.add_ast_statement_id(ast_statement_id.value_or(std::numeric_limits<uint32_t>::max()));
    out.add_table_name(table_name_ofs);
    out.add_alias_name(alias_name_ofs);
    out.add_resolved_table_id(resolved_table_id.Pack());
    return out.Finish();
}

/// Pack as FlatBuffer
flatbuffers::Offset<proto::ColumnReference> AnalyzedScript::ColumnReference::Pack(
    flatbuffers::FlatBufferBuilder& builder) const {
    auto column_name_ofs = column_name.Pack(builder);
    proto::ColumnReferenceBuilder out{builder};
    out.add_ast_node_id(ast_node_id.value_or(std::numeric_limits<uint32_t>::max()));
    out.add_ast_scope_root(ast_scope_root.value_or(std::numeric_limits<uint32_t>::max()));
    out.add_ast_statement_id(ast_statement_id.value_or(std::numeric_limits<uint32_t>::max()));
    out.add_column_name(column_name_ofs);
    out.add_resolved_table_reference_id(resolved_table_reference_id.value_or(std::numeric_limits<uint32_t>::max()));
    out.add_resolved_table_id(resolved_table_id.Pack());
    out.add_resolved_column_id(resolved_column_id.value_or(std::numeric_limits<uint32_t>::max()));
    return out.Finish();
}

/// Constructor
AnalyzedScript::AnalyzedScript(std::shared_ptr<ParsedScript> parsed, SchemaRegistry registry,
                               std::string_view database_name, std::string_view schema_name)
    : Schema(parsed->external_id, database_name, schema_name),
      parsed_script(std::move(parsed)),
      schema_registry(std::move(registry)) {}

/// Get the name search index
const Schema::NameSearchIndex& AnalyzedScript::GetNameSearchIndex() {
    if (!name_search_index.has_value()) {
        auto& index = name_search_index.emplace();
        auto& names = parsed_script->scanned_script->names;
        for (auto& names_chunk : names.GetChunks()) {
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

template <typename In, typename Out>
static flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<Out>>> PackVector(
    flatbuffers::FlatBufferBuilder& builder, const std::vector<In>& elems) {
    std::vector<flatbuffers::Offset<Out>> offsets;
    for (auto& elem : elems) {
        offsets.push_back(elem.Pack(builder));
    }
    return builder.CreateVector(offsets);
};

// Pack an analyzed script
flatbuffers::Offset<proto::AnalyzedScript> AnalyzedScript::Pack(flatbuffers::FlatBufferBuilder& builder) {
    flatbuffers::Offset<flatbuffers::String> database_name_ofs;
    if (!database_name.empty()) {
        database_name_ofs = builder.CreateString(database_name);
    }
    flatbuffers::Offset<flatbuffers::String> schema_name_ofs;
    if (!schema_name.empty()) {
        schema_name_ofs = builder.CreateString(schema_name);
    }
    auto tables_ofs = PackVector<Schema::Table, proto::Table>(builder, tables);
    auto table_columns_ofs = PackVector<Schema::TableColumn, proto::TableColumn>(builder, table_columns);
    auto table_references_ofs =
        PackVector<AnalyzedScript::TableReference, proto::TableReference>(builder, table_references);
    auto column_references_ofs =
        PackVector<AnalyzedScript::ColumnReference, proto::ColumnReference>(builder, column_references);
    proto::QueryGraphEdge* graph_edges_ofs_writer;
    proto::QueryGraphEdgeNode* graph_edge_nodes_ofs_writer;
    auto graph_edges_ofs = builder.CreateUninitializedVectorOfStructs(graph_edges.size(), &graph_edges_ofs_writer);
    auto graph_edge_nodes_ofs =
        builder.CreateUninitializedVectorOfStructs(graph_edge_nodes.size(), &graph_edge_nodes_ofs_writer);
    for (size_t i = 0; i < graph_edges.size(); ++i) {
        graph_edges_ofs_writer[i] = graph_edges[i];
    }
    for (size_t i = 0; i < graph_edge_nodes.size(); ++i) {
        graph_edge_nodes_ofs_writer[i] = graph_edge_nodes[i];
    }

    proto::AnalyzedScriptBuilder out{builder};
    out.add_external_id(external_id);
    out.add_tables(tables_ofs);
    out.add_table_columns(table_columns_ofs);
    out.add_table_references(table_references_ofs);
    out.add_column_references(column_references_ofs);
    out.add_graph_edges(graph_edges_ofs);
    out.add_graph_edge_nodes(graph_edge_nodes_ofs);
    return out.Finish();
}

/// Constructor
Script::Script(uint32_t external_id, std::string_view database_name, std::string_view schema_name)
    : external_id(external_id), text(1024), database_name(database_name), schema_name(schema_name) {}

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
        size_t analyzer_description_bytes =
            analyzed->tables.size() * sizeof(Schema::Table) +
            analyzed->table_columns.size() * sizeof(Schema::TableColumn) +
            analyzed->table_references.size() * sizeof(decltype(analyzed->table_references)::value_type) +
            analyzed->column_references.size() * sizeof(decltype(analyzed->column_references)::value_type) +
            analyzed->graph_edges.size() * sizeof(decltype(analyzed->graph_edges)::value_type) +
            analyzed->graph_edge_nodes.size() * sizeof(decltype(analyzed->graph_edge_nodes)::value_type);
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
        size_t scanner_dictionary_bytes = scanned->name_pool.GetSize() +
                                          scanned->names.GetSize() * sizeof(Schema::NameInfo) +
                                          scanned->names_by_id.size() * sizeof(std::pair<NameID, void*>) +
                                          scanned->names_by_text.size() * sizeof(std::pair<std::string_view, void*>);
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
    auto [script, status] = parser::Scanner::Scan(text, external_id);
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
std::pair<AnalyzedScript*, proto::StatusCode> Script::Analyze(const SchemaRegistry* schema_registry) {
    auto time_start = std::chrono::steady_clock::now();

    // Check if the external context id is unique
    if (schema_registry) {
        if (schema_registry->Contains(external_id)) {
            return {nullptr, proto::StatusCode::EXTERNAL_ID_COLLISION};
        }
    }

    // Analyze a script
    auto [script, status] = Analyzer::Analyze(parsed_script, database_name, schema_name, schema_registry);
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
    auto [maybe_cursor, status] = ScriptCursor::Create(*this, text_offset);
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

static bool endsCursorPath(proto::Node& n) {
    switch (n.node_type()) {
        case proto::NodeType::OBJECT_SQL_SELECT:
        case proto::NodeType::OBJECT_SQL_CREATE:
        case proto::NodeType::OBJECT_SQL_CREATE_AS:
        case proto::NodeType::OBJECT_SQL_SELECT_EXPRESSION:
            return true;
        default:
            break;
    }
    return false;
}

ScriptCursor::ScriptCursor(const Script& script, size_t text_offset) : script(script), text_offset(text_offset) {}

/// Constructor
std::pair<std::unique_ptr<ScriptCursor>, proto::StatusCode> ScriptCursor::Create(const Script& script,
                                                                                 size_t text_offset) {
    auto cursor = std::make_unique<ScriptCursor>(script, text_offset);

    // Did the parsed script change?
    auto& analyzed = script.analyzed_script;

    // Read scanner token
    if (script.scanned_script) {
        cursor->scanner_location.emplace(script.scanned_script->FindSymbol(text_offset));
        if (cursor->scanner_location) {
            auto& token = script.scanned_script->GetSymbols()[cursor->scanner_location->symbol_id];
            cursor->text = script.scanned_script->ReadTextAtLocation(token.location);
        }
    }

    // Read AST node
    if (script.parsed_script) {
        auto maybe_ast_node = script.parsed_script->FindNodeAtOffset(text_offset);
        if (!maybe_ast_node.has_value()) {
            cursor->statement_id = std::nullopt;
            cursor->ast_node_id = std::nullopt;
        } else {
            cursor->statement_id = std::get<0>(*maybe_ast_node);
            cursor->ast_node_id = std::get<1>(*maybe_ast_node);

            // Collect nodes to root
            std::unordered_set<uint32_t> cursor_path_nodes;
            for (auto iter = *cursor->ast_node_id;;) {
                auto& node = script.parsed_script->nodes[iter];
                if (endsCursorPath(node)) {
                    break;
                }
                cursor_path_nodes.insert(iter);
                if (iter == node.parent()) {
                    break;
                }
                iter = node.parent();
            }

            // Analyzed and analyzed is same version?
            if (analyzed && analyzed->parsed_script == script.parsed_script) {
                // Part of a table node?
                for (auto& table : analyzed->tables) {
                    if (table.ast_node_id.has_value() && cursor_path_nodes.contains(*table.ast_node_id)) {
                        cursor->table_id = table.ast_node_id;
                        break;
                    }
                }

                // Part of a table reference node?
                for (size_t i = 0; i < analyzed->table_references.size(); ++i) {
                    auto& table_ref = analyzed->table_references[i];
                    if (table_ref.ast_node_id.has_value() && cursor_path_nodes.contains(*table_ref.ast_node_id)) {
                        cursor->table_reference_id = i;
                        break;
                    }
                }

                // Part of a column reference node?
                for (size_t i = 0; i < analyzed->column_references.size(); ++i) {
                    auto& column_ref = analyzed->column_references[i];
                    if (column_ref.ast_node_id.has_value() && cursor_path_nodes.contains(*column_ref.ast_node_id)) {
                        cursor->column_reference_id = i;
                        break;
                    }
                }

                // Part of a query edge?
                for (size_t ei = 0; ei < analyzed->graph_edges.size(); ++ei) {
                    auto& edge = analyzed->graph_edges[ei];
                    auto nodes_begin = edge.nodes_begin;
                    if (edge.ast_node_id.has_value() && cursor_path_nodes.contains(*edge.ast_node_id)) {
                        cursor->query_edge_id = ei;
                        break;
                    }
                }
            }
        }
    }
    return {std::move(cursor), proto::StatusCode::OK};
}

/// Pack the cursor info
flatbuffers::Offset<proto::ScriptCursorInfo> ScriptCursor::Pack(flatbuffers::FlatBufferBuilder& builder) const {
    auto out = std::make_unique<proto::ScriptCursorInfoT>();
    out->text_offset = text_offset;
    out->scanner_symbol_id = std::numeric_limits<uint32_t>::max();
    out->scanner_relative_position = proto::RelativeSymbolPosition::NEW_SYMBOL_AFTER;
    out->scanner_symbol_offset = 0;
    out->scanner_symbol_kind = 0;
    if (scanner_location) {
        auto& symbol = script.scanned_script->symbols[scanner_location->symbol_id];
        auto symbol_offset = symbol.location.offset();
        out->scanner_symbol_id = scanner_location->symbol_id;
        out->scanner_relative_position = static_cast<proto::RelativeSymbolPosition>(scanner_location->relative_pos);
        out->scanner_symbol_offset = symbol_offset;
        out->scanner_symbol_kind = static_cast<uint32_t>(symbol.kind_);
    }
    out->statement_id = statement_id.value_or(std::numeric_limits<uint32_t>::max());
    out->ast_node_id = ast_node_id.value_or(std::numeric_limits<uint32_t>::max());
    out->table_id = table_id.value_or(std::numeric_limits<uint32_t>::max());
    out->table_reference_id = table_reference_id.value_or(std::numeric_limits<uint32_t>::max());
    out->column_reference_id = column_reference_id.value_or(std::numeric_limits<uint32_t>::max());
    out->query_edge_id = query_edge_id.value_or(std::numeric_limits<uint32_t>::max());
    return proto::ScriptCursorInfo::Pack(builder, out.get());
}

}  // namespace sqlynx
