#include "flatsql/script.h"

#include "flatsql/analyzer/analyzer.h"
#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"

namespace flatsql {

/// Finish a statement
std::unique_ptr<proto::StatementT> ParsedScript::Statement::Pack() {
    auto stmt = std::make_unique<proto::StatementT>();
    stmt->statement_type = type;
    stmt->root_node = root;
    return stmt;
}

/// Constructor
ScannedScript::ScannedScript(std::shared_ptr<TextBuffer> text) : input_data(std::move(text)) {}

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
    auto copy = name_pool.AllocateCopy(s);
    auto id = name_dictionary.size();
    name_dictionary_ids.insert({copy, id});
    name_dictionary.push_back({copy, location});
    return id;
}
/// Read a text at a location
std::string_view ScannedScript::ReadTextAtLocation(sx::Location loc, std::string& tmp) {
    return input_data->Read(loc.offset(), loc.length(), tmp);
}

/// Constructor
ParsedScript::ParsedScript(std::shared_ptr<ScannedScript> scan, parser::ParseContext&& ctx)
    : scanned_script(scan),
      nodes(ctx.nodes.Flatten()),
      statements(std::move(ctx.statements)),
      errors(std::move(ctx.errors)) {}

/// Pack the FlatBuffer
std::shared_ptr<proto::ParsedScriptT> ParsedScript::Pack() {
    auto out = std::make_unique<proto::ParsedScriptT>();
    out->nodes = std::move(nodes);
    out->statements.reserve(statements.size());
    for (auto& stmt : statements) {
        out->statements.push_back(stmt.Pack());
    }
    out->errors.reserve(errors.size());
    for (auto& [loc, msg] : errors) {
        auto err = std::make_unique<proto::ErrorT>();
        err->location = std::make_unique<proto::Location>(loc);
        err->message = std::move(msg);
        out->errors.push_back(std::move(err));
    }
    out->highlighting = scanned_script->PackHighlighting();
    out->line_breaks = std::move(scanned_script->line_breaks);
    out->comments = std::move(scanned_script->comments);
    return out;
}

/// Constructor
AnalyzedScript::AnalyzedScript(std::shared_ptr<ParsedScript> parsed, std::shared_ptr<AnalyzedScript> external)
    : parsed_script(std::move(parsed)), external_script(std::move(external)) {}
// Pack an analyzed script
std::unique_ptr<proto::AnalyzedScriptT> AnalyzedScript::Pack() {
    auto out = std::make_unique<proto::AnalyzedScriptT>();
    out->tables = tables;
    out->table_columns = table_columns;
    out->table_references = table_references;
    out->column_references = column_references;
    out->graph_edges = graph_edges;
    out->graph_edge_nodes = graph_edge_nodes;
    return out;
}

/// Constructor
Script::Script() : text(std::make_shared<TextBuffer>(1024)) {}

/// Insert a character at an offet
void Script::InsertCharAt(size_t char_idx, uint32_t unicode) {
    std::array<std::byte, 6> buffer;
    auto length = flatsql::utf8::utf8proc_encode_char(unicode, reinterpret_cast<uint8_t*>(buffer.data()));
    std::string_view encoded{reinterpret_cast<char*>(buffer.data()), static_cast<size_t>(length)};
    text->InsertTextAt(char_idx, encoded);
}
/// Insert a text at an offet
void Script::InsertTextAt(size_t char_idx, std::string_view encoded) { text->InsertTextAt(char_idx, encoded); }
/// Erase a text at an offet
void Script::EraseTextRange(size_t char_idx, size_t count) { text->EraseTextRange(char_idx, count); }
/// Print a script as string
std::string Script::ToString() { return text->ToString(); }

/// Parse a script
ParsedScript& Script::Parse() {
    scanned_script = parser::Scanner::Scan(text);
    parsed_scripts.push_back(parser::ParseContext::Parse(scanned_script));
    return *parsed_scripts.back();
}
/// Analyze a script
AnalyzedScript& Script::Analyze(Script* external) {
    assert(scanned_script != nullptr);
    assert(!parsed_scripts.empty());
    auto parsed_script = parsed_scripts.back();
    if (!external->analyzed_scripts.empty()) {
        analyzed_scripts.push_back(Analyzer::Analyze(std::move(parsed_script), external->analyzed_scripts.back()));
    } else {
        analyzed_scripts.push_back(Analyzer::Analyze(std::move(parsed_script)));
    }
    return *analyzed_scripts.back();
}

/// Pack a parsed script
flatbuffers::Offset<proto::ParsedScript> Script::PackParsedScript(flatbuffers::FlatBufferBuilder& builder) {
    assert(!parsed_scripts.empty());
    auto packed = parsed_scripts.back()->Pack();
    return proto::ParsedScript::Pack(builder, packed.get());
}
/// Pack a analyzed script
flatbuffers::Offset<proto::AnalyzedScript> Script::PackAnalyzedScript(flatbuffers::FlatBufferBuilder& builder) {
    assert(!analyzed_scripts.empty());
    auto packed = analyzed_scripts.back()->Pack();
    return proto::AnalyzedScript::Pack(builder, packed.get());
}

}  // namespace flatsql
