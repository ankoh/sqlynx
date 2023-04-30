#include "flatsql/parser/program.h"

#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"

namespace flatsql {
namespace parser {

/// Constructor
ScannedProgram::ScannedProgram(Scanner&& scanner)
    : input_data(scanner.input_data),
      errors(std::move(scanner.errors)),
      line_breaks(std::move(scanner.line_breaks)),
      comments(std::move(scanner.comments)),
      string_dictionary(std::move(scanner.name_dictionary_locations)),
      symbols(std::move(scanner.symbols)),
      symbol_iterator(symbols) {}

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
        out->statements.push_back(stmt.Finish());
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
