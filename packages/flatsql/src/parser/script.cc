#include "flatsql/script.h"

#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"

namespace flatsql {

/// Constructor
Statement::Statement() : root(std::numeric_limits<uint32_t>::max()) {}
/// Finish a statement
std::unique_ptr<proto::StatementT> Statement::Pack() {
    auto stmt = std::make_unique<proto::StatementT>();
    stmt->statement_type = type;
    stmt->root_node = root;
    return stmt;
}

/// Constructor
ScannedScript::ScannedScript(rope::Rope& rope) : input_data(rope) {}

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
    return input_data.Read(loc.offset(), loc.length(), tmp);
}

/// Constructor
ParsedScript::ParsedScript(parser::ParseContext&& ctx)
    : scan(ctx.program),
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
    out->highlighting = scan.PackHighlighting();
    out->line_breaks = std::move(scan.line_breaks);
    out->comments = std::move(scan.comments);
    return out;
}

/// Constructor
AnalyzedScript::AnalyzedScript(ScannedScript& scanned, ParsedScript& parsed) : scanned(scanned), parsed(parsed) {}

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

}  // namespace flatsql
