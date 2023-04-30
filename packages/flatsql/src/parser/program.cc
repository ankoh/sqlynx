#include "flatsql/parser/program.h"

#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"

namespace flatsql {
namespace parser {

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
ParsedProgram::ParsedProgram(ParseContext&& ctx)
    : scan(ctx.program),
      nodes(std::move(ctx.nodes)),
      statements(std::move(ctx.statements)),
      errors(std::move(ctx.errors)) {}

/// Pack the FlatBuffer
std::shared_ptr<proto::ProgramT> ParsedProgram::Pack() {
    auto out = std::make_unique<proto::ProgramT>();
    out->nodes = nodes.Flatten();
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
    out->highlighting = scan.Pack();
    out->line_breaks = std::move(scan.line_breaks);
    out->comments = std::move(scan.comments);
    return out;
}

}  // namespace parser
}  // namespace flatsql
