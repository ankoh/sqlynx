#include "flatsql/parser/program.h"

#include "flatsql/parser/scanner.h"

namespace flatsql {
namespace parser {

/// Constructor
ScannedProgram::ScannedProgram(Scanner& scanner)
    : input_data(scanner.input_data),
      errors(std::move(scanner.errors)),
      line_breaks(std::move(scanner.line_breaks)),
      comments(std::move(scanner.comments)),
      string_dictionary(std::move(scanner.string_dictionary_locations)),
      symbols(std::move(scanner.symbols)),
      symbol_iterator(symbols) {}

/// Read a text at a location
std::string_view ScannedProgram::ReadTextAtLocation(sx::Location loc, std::string& tmp) {
    return input_data.Read(loc.offset(), loc.length(), tmp);
}

}  // namespace parser
}  // namespace flatsql
