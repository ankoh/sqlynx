#include "flatsql/script.h"

#include <flatbuffers/flatbuffer_builder.h>

#include <algorithm>
#include <chrono>
#include <memory>
#include <optional>
#include <unordered_set>

#include "flatsql/analyzer/analyzer.h"
#include "flatsql/analyzer/completion.h"
#include "flatsql/analyzer/completion_index.h"
#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/parser.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/utils/suffix_trie.h"

namespace flatsql {

/// Finish a statement
std::unique_ptr<proto::StatementT> ParsedScript::Statement::Pack() {
    auto stmt = std::make_unique<proto::StatementT>();
    stmt->statement_type = type;
    stmt->root_node = root;
    return stmt;
}

/// Constructor
ScannedScript::ScannedScript(const rope::Rope& text, uint32_t context_id)
    : context_id(context_id), text_buffer(text.ToString(true)) {}

/// Register a name
NameID ScannedScript::RegisterKeywordAsName(std::string_view s, sx::Location location, sx::NameTag tag) {
    auto iter = name_dictionary_ids.find(s);
    if (iter != name_dictionary_ids.end()) {
        auto& name = name_dictionary[iter->second];
        name.tags |= tag;
        name.occurrences += 1;
        return iter->second;
    }
    auto id = name_dictionary.size();
    name_dictionary_ids.insert({s, id});
    name_dictionary.push_back(Name{.text = s, .location = location, .tags = tag, .occurrences = 1});
    return id;
}
/// Register a name
NameID ScannedScript::RegisterName(std::string_view s, sx::Location location, sx::NameTag tag) {
    auto iter = name_dictionary_ids.find(s);
    if (iter != name_dictionary_ids.end()) {
        auto& name = name_dictionary[iter->second];
        name.tags |= tag;
        name.occurrences += 1;
        return iter->second;
    }
    auto id = name_dictionary.size();
    name_dictionary_ids.insert({s, id});
    name_dictionary.push_back(Name{.text = s, .location = location, .tags = tag, .occurrences = 1});
    return id;
}
/// Tag a name
void ScannedScript::TagName(NameID name_id, sx::NameTag tag) {
    assert(name_id <= name_dictionary.size());
    name_dictionary[name_id].tags |= tag;
}

/// Find a token at a text offset
ScannedScript::LocationInfo ScannedScript::FindSymbol(size_t text_offset) {
    using RelativePosition = ScannedScript::LocationInfo::RelativePosition;
    auto& chunks = symbols.GetChunks();
    auto user_text_end = std::max<size_t>(text_buffer.size(), 2) - 2;
    text_offset = std::min<size_t>(user_text_end, text_offset);

    // Helper to get the previous symbol (if there is one)
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
            return RelativePosition::NEW_SYMBOL;
        }
        auto& chunk = chunks[chunk_id];
        auto symbol = chunk[chunk_symbol_id];
        auto symbol_begin = symbol.location.offset();
        auto symbol_end = symbol.location.offset() + symbol.location.length();

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
        return RelativePosition::NEW_SYMBOL;
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
            } else {
                // Very first token is EOF token?
                // Special case empty script buffer
                return {0, 0, *symbol_iter, std::nullopt, RelativePosition::NEW_SYMBOL};
            }
        } else {
            --global_symbol_id;
            --chunk_symbol_id;
        }
    }

    // Return the global token offset
    auto prev_symbol = get_prev_symbol(chunk_iter - chunks.begin(), chunk_symbol_id);
    auto relative_pos = get_relative_position(text_offset, chunk_iter - chunks.begin(), chunk_symbol_id);
    return {text_offset, global_symbol_id, *symbol_iter, prev_symbol, relative_pos};
}

flatbuffers::Offset<proto::ScannedScript> ScannedScript::Pack(flatbuffers::FlatBufferBuilder& builder) {
    proto::ScannedScriptT out;
    out.context_id = context_id;
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
    : context_id(scan->context_id),
      scanned_script(scan),
      nodes(ctx.nodes.Flatten()),
      statements(std::move(ctx.statements)),
      errors(std::move(ctx.errors)) {}

/// Resolve an ast node
std::optional<std::pair<size_t, size_t>> ParsedScript::FindNodeAtOffset(size_t text_offset) {
    // Helper to check if an offset is included in a location
    auto includes_offset = [](const std::vector<proto::Node>& nodes, size_t node_id, size_t text_offset) {
        return nodes[node_id].location().offset() <= text_offset &&
               ((nodes[node_id].location().offset() + nodes[node_id].location().length()) > text_offset);
    };
    // Check all statements
    for (size_t si = 0; si < statements.size(); ++si) {
        // Different statement?
        auto iter = statements[si].root;
        if (!includes_offset(nodes, iter, text_offset)) {
            continue;
        }

        // Try to traverse down the AST
        while (true) {
            // Reached node without children? Then return that node
            auto& node = nodes[iter];
            if (node.children_count() == 0) {
                break;
            }
            // Otherwise find the first child that includes the offset
            // Children are not ordered by location but ideally, there should only be a single match.
            std::optional<size_t> child;
            for (size_t i = 0; i < node.children_count(); ++i) {
                auto ci = node.children_begin_or_value() + i;
                if (includes_offset(nodes, ci, text_offset)) {
                    child = ci;
                    break;
                }
            }
            // Found an including child, traverse down
            if (child.has_value()) {
                iter = child.value();
                continue;
            }
            // Otherwise none of the children included the text offset.
            // Abort and return the current node as best match.
            break;
        }
        // Return (statement, node)-pair
        return std::make_pair(si, iter);
    }
    // No match found
    return std::nullopt;
}

/// Pack the FlatBuffer
flatbuffers::Offset<proto::ParsedScript> ParsedScript::Pack(flatbuffers::FlatBufferBuilder& builder) {
    proto::ParsedScriptT out;
    out.context_id = context_id;
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
    // XXX We should not just blindy serialize all names (again) if most of them will just reference input text
    out.name_dictionary.reserve(scanned_script->name_dictionary.size());
    out.name_tags.reserve(scanned_script->name_dictionary.size());
    for (auto& name : scanned_script->name_dictionary) {
        out.name_dictionary.emplace_back(name.text);
        out.name_tags.emplace_back(name.tags);
    }
    return proto::ParsedScript::Pack(builder, &out);
}

/// Constructor
AnalyzedScript::AnalyzedScript(std::shared_ptr<ParsedScript> parsed, std::shared_ptr<AnalyzedScript> external)
    : context_id(parsed->context_id), parsed_script(std::move(parsed)), external_script(std::move(external)) {}
// Pack an analyzed script
flatbuffers::Offset<proto::AnalyzedScript> AnalyzedScript::Pack(flatbuffers::FlatBufferBuilder& builder) {
    proto::AnalyzedScriptT out;
    out.context_id = context_id;
    out.tables.reserve(tables.size());
    out.table_columns.reserve(table_columns.size());
    out.table_references.reserve(table_references.size());
    out.column_references.reserve(column_references.size());
    out.graph_edges.reserve(graph_edges.size());
    out.graph_edge_nodes.reserve(graph_edge_nodes.size());
    for (auto& table : tables) {
        out.tables.push_back(table);
    }
    for (auto& table_col : table_columns) {
        out.table_columns.push_back(table_col);
    }
    for (auto& table_ref : table_references) {
        out.table_references.push_back(table_ref);
    }
    for (auto& column_ref : column_references) {
        out.column_references.push_back(column_ref);
    }
    for (auto& graph_edge : graph_edges) {
        out.graph_edges.push_back(graph_edge);
    }
    for (auto& graph_edge_node : graph_edge_nodes) {
        out.graph_edge_nodes.push_back(graph_edge_node);
    }
    return proto::AnalyzedScript::Pack(builder, &out);
}

/// Constructor
Script::Script(uint32_t context_id) : context_id(context_id), text(1024), external_script(nullptr) {}

/// Insert a character at an offet
void Script::InsertCharAt(size_t char_idx, uint32_t unicode) {
    std::array<std::byte, 6> buffer;
    auto length = flatsql::utf8::utf8proc_encode_char(unicode, reinterpret_cast<uint8_t*>(buffer.data()));
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
        size_t analyzer_bytes =
            analyzed->tables.size() * sizeof(decltype(analyzed->tables)::value_type) +
            analyzed->table_columns.size() * sizeof(decltype(analyzed->table_columns)::value_type) +
            analyzed->table_references.size() * sizeof(decltype(analyzed->table_references)::value_type) +
            analyzed->column_references.size() * sizeof(decltype(analyzed->column_references)::value_type) +
            analyzed->graph_edges.size() * sizeof(decltype(analyzed->graph_edges)::value_type) +
            analyzed->graph_edge_nodes.size() * sizeof(decltype(analyzed->graph_edge_nodes)::value_type);
        stats.mutate_analyzer_bytes(analyzer_bytes);

        // Added parsed before?
        ParsedScript* parsed = analyzed->parsed_script.get();
        if (registered_parsed.contains(parsed)) return;
        size_t parser_ast_bytes = parsed->nodes.size() * sizeof(decltype(parsed->nodes)::value_type);
        stats.mutate_parser_ast_bytes(parser_ast_bytes);

        // Added scanned before?
        ScannedScript* scanned = parsed->scanned_script.get();
        if (registered_scanned.contains(scanned)) return;
        size_t scanner_symbol_bytes = scanned->symbols.GetSize() + sizeof(parser::Parser::symbol_type);
        size_t scanner_dictionary_bytes =
            scanned->name_pool.GetSize() +
            scanned->name_dictionary.size() * sizeof(decltype(scanned->name_dictionary)::value_type);
        stats.mutate_scanner_input_bytes(scanned->GetInput().size());
        stats.mutate_scanner_symbol_bytes(scanner_symbol_bytes);
        stats.mutate_scanner_dictionary_bytes(scanner_dictionary_bytes);
    };
    registerScript(analyzed_script.get(), memory->mutable_latest_script());

    if (completion_index) {
        if (auto& script = completion_index->GetScript()) {
            registerScript(script.get(), memory->mutable_completion_index_script());
        }
        auto& entries = completion_index->GetEntries();
        size_t completion_index_entries = entries.size() * sizeof(CompletionIndex::Entry);
        size_t completion_index_bytes = entries.size() * sizeof(SuffixTrie::Entry);
        memory->mutate_completion_index_entries(completion_index_entries);
        memory->mutate_completion_index_bytes(completion_index_bytes);
    }
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
    auto [script, status] = parser::Scanner::Scan(text, context_id);
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
std::pair<AnalyzedScript*, proto::StatusCode> Script::Analyze(Script* external) {
    auto time_start = std::chrono::steady_clock::now();

    // Get analyzed external script
    std::shared_ptr<AnalyzedScript> external_analyzed;
    if (external) {
        external_analyzed = external->analyzed_script;
        if (context_id == external->context_id) {
            return {nullptr, proto::StatusCode::EXTERNAL_CONTEXT_COLLISION};
        }
    }

    // Analyze a script
    auto [script, status] = Analyzer::Analyze(parsed_script, external_analyzed);
    if (status != proto::StatusCode::OK) {
        return {nullptr, status};
    }
    analyzed_script = std::move(script);
    external_script = external;

    // Update step timings
    timing_statistics.mutate_analyzer_last_elapsed(
        std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - time_start).count());
    return {analyzed_script.get(), status};
}

/// Update the completion index
proto::StatusCode Script::Reindex() {
    if (!analyzed_script) {
        return proto::StatusCode::REINDEXING_MISSES_ANALYSIS;
    }
    auto [index, status] = CompletionIndex::Build(analyzed_script);
    // Reindexing failed, keep the old index
    if (status != proto::StatusCode::OK) {
        return status;
    }
    completion_index = std::move(index);
    return proto::StatusCode::OK;
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
    auto& parsed = *analyzed->parsed_script;
    auto& scanned = *parsed.scanned_script;

    // Read scanner token
    cursor->scanner_location.emplace(scanned.FindSymbol(text_offset));
    if (cursor->scanner_location) {
        auto& token = scanned.GetSymbols()[cursor->scanner_location->symbol_id];
        cursor->text = scanned.ReadTextAtLocation(token.location);
    }

    // Read AST node
    auto maybe_ast_node = parsed.FindNodeAtOffset(text_offset);
    if (!maybe_ast_node.has_value()) {
        cursor->statement_id = std::nullopt;
        cursor->ast_node_id = std::nullopt;
    } else {
        cursor->statement_id = std::get<0>(*maybe_ast_node);
        cursor->ast_node_id = std::get<1>(*maybe_ast_node);
    }

    // Has ast node?
    if (cursor->ast_node_id.has_value()) {
        // Collect nodes to root
        std::unordered_set<uint32_t> cursor_path_nodes;
        for (auto iter = *cursor->ast_node_id;;) {
            auto& node = parsed.nodes[iter];
            if (endsCursorPath(node)) {
                break;
            }
            cursor_path_nodes.insert(iter);
            if (iter == node.parent()) {
                break;
            }
            iter = node.parent();
        }

        // Part of a table node?
        cursor->table_id = std::nullopt;
        for (auto& table : analyzed->tables) {
            if (table.ast_node_id.has_value() && cursor_path_nodes.contains(*table.ast_node_id)) {
                cursor->table_id = table.ast_node_id;
                break;
            }
        }

        // Part of a table reference node?
        cursor->table_reference_id = std::nullopt;
        for (size_t i = 0; i < analyzed->table_references.size(); ++i) {
            auto& table_ref = analyzed->table_references[i];
            if (table_ref.ast_node_id.has_value() && cursor_path_nodes.contains(*table_ref.ast_node_id)) {
                cursor->table_reference_id = i;
                break;
            }
        }

        // Part of a column reference node?
        cursor->column_reference_id = std::nullopt;
        for (size_t i = 0; i < analyzed->column_references.size(); ++i) {
            auto& column_ref = analyzed->column_references[i];
            if (column_ref.ast_node_id.has_value() && cursor_path_nodes.contains(*column_ref.ast_node_id)) {
                cursor->column_reference_id = i;
                break;
            }
        }

        // Part of a query edge?
        cursor->query_edge_id = std::nullopt;
        for (size_t ei = 0; ei < analyzed->graph_edges.size(); ++ei) {
            auto& edge = analyzed->graph_edges[ei];
            auto nodes_begin = edge.nodes_begin;
            if (edge.ast_node_id.has_value() && cursor_path_nodes.contains(*edge.ast_node_id)) {
                cursor->query_edge_id = ei;
                break;
            }
        }
    }
    return {std::move(cursor), proto::StatusCode::OK};
}

/// Pack the cursor info
flatbuffers::Offset<proto::ScriptCursorInfo> ScriptCursor::Pack(flatbuffers::FlatBufferBuilder& builder) const {
    auto out = std::make_unique<proto::ScriptCursorInfoT>();
    out->text_offset = text_offset;
    out->scanner_token_id = std::numeric_limits<uint32_t>::max();
    if (scanner_location) {
        out->scanner_token_id = scanner_location->symbol_id;
    }
    out->statement_id = statement_id.value_or(std::numeric_limits<uint32_t>::max());
    out->ast_node_id = ast_node_id.value_or(std::numeric_limits<uint32_t>::max());
    out->table_id = table_id.value_or(std::numeric_limits<uint32_t>::max());
    out->table_reference_id = table_reference_id.value_or(std::numeric_limits<uint32_t>::max());
    out->column_reference_id = column_reference_id.value_or(std::numeric_limits<uint32_t>::max());
    out->query_edge_id = query_edge_id.value_or(std::numeric_limits<uint32_t>::max());
    return proto::ScriptCursorInfo::Pack(builder, out.get());
}

}  // namespace flatsql
