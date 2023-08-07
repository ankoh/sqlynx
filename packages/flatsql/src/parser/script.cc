#include "flatsql/script.h"

#include <flatbuffers/flatbuffer_builder.h>

#include <algorithm>
#include <chrono>
#include <optional>
#include <unordered_set>

#include "flatsql/analyzer/analyzer.h"
#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/parser_generated.h"
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
ScannedScript::ScannedScript(const rope::Rope& text) : text_buffer(text.ToString(true)) {}

/// Register a name
size_t ScannedScript::RegisterKeywordAsName(std::string_view s, sx::Location location) {
    auto iter = name_dictionary_ids.find(s);
    if (iter != name_dictionary_ids.end()) {
        return iter->second;
    }
    auto id = name_dictionary.size();
    name_dictionary_ids.insert({s, id});
    name_dictionary.push_back({s, location});
    return id;
}
/// Register a name
size_t ScannedScript::RegisterName(std::string_view s, sx::Location location) {
    auto iter = name_dictionary_ids.find(s);
    if (iter != name_dictionary_ids.end()) {
        return iter->second;
    }
    auto id = name_dictionary.size();
    name_dictionary_ids.insert({s, id});
    name_dictionary.push_back({s, location});
    return id;
}

/// Find a token at a text offset
size_t ScannedScript::FindToken(size_t text_offset) {
    // Symbols are sorted by location, so we can do a binary search on the symbol buffer
    auto& chunks = symbols.GetChunks();
    // Short-circuit offset past end (+ 2 trailing YY_END_OF_BUFFER_CHAR)
    if (text_offset + 2 >= text_buffer.size()) {
        // Get last token (minus EOF token)
        return std::max<size_t>(symbols.GetSize(), 2) - 2;
    }

    // Find chunk that contains the text offset.
    // Chunks grow exponentially in size, so this is logarithmic in cost
    auto chunk_iter = chunks.begin();
    size_t chunk_token_offset = 0;
    for (; chunk_iter != chunks.end(); ++chunk_iter) {
        size_t text_to = chunk_iter->back().location.offset() + chunk_iter->back().location.length();
        if (text_offset < text_to) {
            break;
        }
        chunk_token_offset += chunk_iter->size();
    }

    // Iter hit end?
    // Return the last token then (minus YYEOF)
    if (chunk_iter == chunks.end()) {
        return std::max<size_t>(chunk_token_offset, 2) - 2;
    }

    // Otherwise we found a chunk that contains the text offset.
    // Binary search the token offset.
    auto token_iter =
        std::lower_bound(chunk_iter->begin(), chunk_iter->end(), text_offset,
                         [](parser::Parser::symbol_type& token, size_t ofs) { return token.location.offset() < ofs; });

    // Offset is larger than the text offset?
    // Then emit the previous node
    if (token_iter->location.offset() > text_offset) {
        // Get the previous token
        if (token_iter != chunk_iter->begin()) {
            // Get the previous token in the same chunk
            --token_iter;
        } else if (chunk_iter != chunks.begin()) {
            // Get the previous token in this previous chunk
            --chunk_iter;
            chunk_token_offset -= chunk_iter->size();
            assert(!chunk_iter->empty());
            token_iter = (chunk_iter->begin() + chunk_iter->size() - 1);
        }
        // Otherwise we just emit the first token
    }

    // Return the global token offset
    auto local_token_ofs = token_iter - chunk_iter->begin();
    return chunk_token_offset + local_token_ofs;
}

flatbuffers::Offset<proto::ScannedScript> ScannedScript::Pack(flatbuffers::FlatBufferBuilder& builder) {
    proto::ScannedScriptT out;
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
    : scanned_script(scan),
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
    for (auto& [name, loc] : scanned_script->name_dictionary) {
        out.name_dictionary.emplace_back(name);
    }
    return proto::ParsedScript::Pack(builder, &out);
}

/// Constructor
AnalyzedScript::AnalyzedScript(std::shared_ptr<ParsedScript> parsed, std::shared_ptr<AnalyzedScript> external)
    : parsed_script(std::move(parsed)), external_script(std::move(external)) {}
// Pack an analyzed script
flatbuffers::Offset<proto::AnalyzedScript> AnalyzedScript::Pack(flatbuffers::FlatBufferBuilder& builder) {
    proto::AnalyzedScriptT out;
    out.tables = tables;
    out.table_columns = table_columns;
    out.table_references = table_references;
    out.column_references = column_references;
    out.graph_edges = graph_edges;
    out.graph_edge_nodes = graph_edge_nodes;
    return proto::AnalyzedScript::Pack(builder, &out);
}

/// Constructor
Script::Script() : text(1024), external_script(nullptr) {}

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

    if (completion_index.suffix_trie) {
        registerScript(completion_index.analyzed_script.get(), memory->mutable_completion_index_script());
        size_t completion_index_entries = completion_index.suffix_trie->GetEntries().size() * sizeof(SuffixTrie::Entry);
        size_t completion_index_bytes = completion_index.suffix_trie->GetEntries().size() * sizeof(SuffixTrie::Entry);
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
    auto [script, status] = parser::Scanner::Scan(text);
    scanned_script = std::move(script);
    if (status == proto::StatusCode::OK) {
        scanned_script->text_version = ++text_version;
    }
    timing_statistics.mutate_scanner_last_elapsed(
        std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - time_start).count());
    return {scanned_script.get(), status};
}
/// Parse a script
std::pair<ParsedScript*, proto::StatusCode> Script::Parse() {
    auto time_start = std::chrono::steady_clock::now();
    auto [script, status] = parser::ParseContext::Parse(scanned_script);
    parsed_script = std::move(script);
    if (status == proto::StatusCode::OK) {
        parsed_script->text_version = scanned_script->text_version;
    }
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
    }

    // Analyze a script
    auto [script, status] = Analyzer::Analyze(parsed_script, external_analyzed);
    if (status != proto::StatusCode::OK) {
        return {nullptr, status};
    }
    script->text_version = parsed_script->text_version;
    analyzed_script = std::move(script);

    // Update step timings
    timing_statistics.mutate_analyzer_last_elapsed(
        std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - time_start).count());
    return {analyzed_script.get(), status};
}

/// Returns the pretty-printed string for this script.
std::string Script::Format() {
    // TODO: actually implement formatting
    return "formatted[" + text.ToString() + "]";
}

/// Update the completion index
proto::StatusCode Script::UpdateCompletionIndex() {
    auto& analyzed = analyzed_script;
    if (!analyzed) {
        return proto::StatusCode::COMPLETION_DATA_INVALID;
    }
    auto& parsed = analyzed->parsed_script;
    auto& scanned = parsed->scanned_script;

    completion_index.analyzed_script = analyzed;
    completion_index.suffix_trie = SuffixTrie::BulkLoad(scanned->name_dictionary);
    return proto::StatusCode::OK;
}

/// Constructor
ScriptCursor::ScriptCursor() : analyzed_script(), text_offset(0) {}

/// Move the cursor to a script at a position
void ScriptCursor::Move(const Script& script, size_t offset) {
    // Did the parsed script change?
    auto& scanned = script.scanned_script;
    parsed_script = script.parsed_script;
    analyzed_script = script.analyzed_script;
    text_offset = offset;

    // Read scanner token
    scanner_token_id = scanned->FindToken(text_offset);
    // Read AST node
    auto maybe_ast_node = parsed_script->FindNodeAtOffset(text_offset);
    if (!maybe_ast_node.has_value()) {
        statement_id = std::nullopt;
        ast_node_id = std::nullopt;
    } else {
        statement_id = std::get<0>(*maybe_ast_node);
        ast_node_id = std::get<1>(*maybe_ast_node);
    }

    // Has ast node?
    if (ast_node_id.has_value() && analyzed_script != nullptr) {
        // Collect nodes to root
        std::unordered_set<uint32_t> cursor_path_nodes;
        for (auto iter = *ast_node_id;;) {
            auto& node = parsed_script->nodes[iter];
            cursor_path_nodes.insert(iter);
            if (iter == node.parent()) {
                break;
            }
            iter = node.parent();
        }

        // Part of a table node?
        table_id = std::nullopt;
        for (auto& table : analyzed_script->tables) {
            if (cursor_path_nodes.contains(table.ast_node_id())) {
                table_id = table.ast_node_id();
                break;
            }
        }

        // Part of a table reference node?
        table_reference_id = std::nullopt;
        for (size_t i = 0; i < analyzed_script->table_references.size(); ++i) {
            auto& table_ref = analyzed_script->table_references[i];
            if (cursor_path_nodes.contains(table_ref.ast_node_id())) {
                table_reference_id = i;
                break;
            }
        }

        // Part of a column reference node?
        column_reference_id = std::nullopt;
        for (size_t i = 0; i < analyzed_script->column_references.size(); ++i) {
            auto& column_ref = analyzed_script->column_references[i];
            if (cursor_path_nodes.contains(column_ref.ast_node_id())) {
                column_reference_id = i;
                break;
            }
        }

        // Part of a query edge?
        query_edge_id = std::nullopt;
        for (size_t ei = 0; ei < analyzed_script->graph_edges.size(); ++ei) {
            auto& edge = analyzed_script->graph_edges[ei];
            auto nodes_begin = edge.nodes_begin();
            for (size_t ni = 0; ni < (edge.node_count_left() + edge.node_count_right()); ++ni) {
                auto& edge_node = analyzed_script->graph_edge_nodes[nodes_begin + ni];
                auto column_ref = analyzed_script->column_references[edge_node.column_reference_id()];
                assert(!Analyzer::ID(column_ref.ast_node_id()).IsExternal());
                if (cursor_path_nodes.contains(column_ref.ast_node_id())) {
                    query_edge_id = ei;
                    break;
                }
            }
            if (query_edge_id.has_value()) {
                break;
            }
        }
    }
}

/// Pack the cursor info
flatbuffers::Offset<proto::ScriptCursorInfo> ScriptCursor::Pack(flatbuffers::FlatBufferBuilder& builder) {
    auto out = std::make_unique<proto::ScriptCursorInfoT>();
    out->text_offset = text_offset;
    out->scanner_token_id = scanner_token_id.value_or(std::numeric_limits<uint32_t>::max());
    out->statement_id = statement_id.value_or(std::numeric_limits<uint32_t>::max());
    out->ast_node_id = ast_node_id.value_or(std::numeric_limits<uint32_t>::max());
    out->table_id = table_id.value_or(std::numeric_limits<uint32_t>::max());
    out->table_reference_id = table_reference_id.value_or(std::numeric_limits<uint32_t>::max());
    out->column_reference_id = column_reference_id.value_or(std::numeric_limits<uint32_t>::max());
    out->query_edge_id = query_edge_id.value_or(std::numeric_limits<uint32_t>::max());
    return proto::ScriptCursorInfo::Pack(builder, out.get());
}

}  // namespace flatsql
