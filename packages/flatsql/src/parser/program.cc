#include "flatsql/program.h"

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
ScannedProgram::ScannedProgram(rope::Rope& rope) : input_data(rope) {}

/// Register a name
size_t ScannedProgram::RegisterKeywordAsName(std::string_view s, sx::Location location) {
    auto iter = name_dictionary_ids.find(s);
    if (iter != name_dictionary_ids.end()) {
        return iter->second;
    }
    auto id = name_dictionary_locations.size();
    name_dictionary_ids.insert({s, id});
    name_dictionary_locations.push_back(location);
    return id;
}
/// Register a name
size_t ScannedProgram::RegisterName(std::string_view s, sx::Location location) {
    auto iter = name_dictionary_ids.find(s);
    if (iter != name_dictionary_ids.end()) {
        return iter->second;
    }
    auto copy = name_pool.AllocateCopy(s);
    auto id = name_dictionary_locations.size();
    name_dictionary_ids.insert({copy, id});
    name_dictionary_locations.push_back(location);
    return id;
}
/// Read a text at a location
std::string_view ScannedProgram::ReadTextAtLocation(sx::Location loc, std::string& tmp) {
    return input_data.Read(loc.offset(), loc.length(), tmp);
}

/// Constructor
ParsedProgram::ParsedProgram(parser::ParseContext&& ctx)
    : scan(ctx.program),
      nodes(ctx.nodes.Flatten()),
      statements(std::move(ctx.statements)),
      errors(std::move(ctx.errors)) {}

/// Pack the FlatBuffer
std::shared_ptr<proto::ParsedProgramT> ParsedProgram::Pack() {
    auto out = std::make_unique<proto::ParsedProgramT>();
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
AnalyzedProgram::AnalyzedProgram(ScannedProgram& scanned, ParsedProgram& parsed) : scanned(scanned), parsed(parsed) {}

std::unique_ptr<proto::AnalyzedProgramT> AnalyzedProgram::Pack() {
    auto names = std::make_unique<proto::NameResolutionInfoT>();
    names->column_references = column_references.Flatten();
    names->table_references = table_references.Flatten();
    names->table_declarations.reserve(table_declarations.GetSize());
    for (auto tbl : table_declarations.Flatten()) {
        names->table_declarations.push_back(std::make_unique<proto::TableDeclarationT>(std::move(tbl)));
    }
    names->join_edges.reserve(join_edges.GetSize());
    for (auto edge : join_edges.Flatten()) {
        names->join_edges.push_back(std::make_unique<proto::HyperEdgeT>(std::move(edge)));
    }
    auto analyzed = std::make_unique<proto::AnalyzedProgramT>();
    analyzed->name_resolution = std::move(names);
    return analyzed;
}

}  // namespace flatsql
