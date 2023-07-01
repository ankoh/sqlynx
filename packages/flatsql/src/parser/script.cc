#include "flatsql/script.h"

#include <flatbuffers/flatbuffer_builder.h>

#include "flatsql/analyzer/analyzer.h"
#include "flatsql/parser/parse_context.h"
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
ScannedScript::ScannedScript(std::string text) : input_data(std::move(text)) {}

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

flatbuffers::Offset<proto::ScannedScript> ScannedScript::Pack(flatbuffers::FlatBufferBuilder& builder) {
    proto::ScannedScriptT out;
    out.errors.reserve(errors.size());
    for (auto& [loc, msg] : errors) {
        auto err = std::make_unique<proto::ErrorT>();
        err->location = std::make_unique<proto::Location>(loc);
        err->message = msg;
        out.errors.push_back(std::move(err));
    }
    out.highlighting = PackHighlighting();
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

/// Scan a script
std::pair<ScannedScript*, proto::StatusCode> Script::Scan() {
    auto [script, status] = parser::Scanner::Scan(text);
    scanned_script = std::move(script);
    return {scanned_script.get(), status};
}
/// Parse a script
std::pair<ParsedScript*, proto::StatusCode> Script::Parse() {
    auto [script, status] = parser::ParseContext::Parse(scanned_script);
    parsed_script = std::move(script);
    return {parsed_script.get(), status};
}
/// Analyze a script
std::pair<AnalyzedScript*, proto::StatusCode> Script::Analyze(Script* external) {
    auto external_analyzed =
        (external && !external->analyzed_scripts.empty()) ? external->analyzed_scripts.back() : nullptr;

    // Analyze a script
    auto [script, status] = Analyzer::Analyze(parsed_script, external_analyzed);
    if (status != proto::StatusCode::OK) {
        return {nullptr, status};
    }
    analyzed_scripts.push_back(std::move(script));

    // XXX Cleanup the old for now, replace with smarter garbage collection later
    if (analyzed_scripts.size() > 1) {
        analyzed_scripts.pop_front();
    }
    return {analyzed_scripts.back().get(), status};
}

/// Update the completion index
proto::StatusCode Script::UpdateCompletionIndex() {
    if (analyzed_scripts.empty()) {
        return proto::StatusCode::COMPLETION_DATA_INVALID;
    }
    auto& analyzed = analyzed_scripts.back();
    auto& parsed = analyzed->parsed_script;
    auto& scanned = parsed->scanned_script;

    completion_index.analyzed_script = analyzed;
    completion_index.suffix_trie = SuffixTrie::BulkLoad(scanned->name_dictionary);
    return proto::StatusCode::OK;
}

}  // namespace flatsql
