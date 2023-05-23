#include "flatsql/analyzer/analyzer.h"

#include "flatsql/analyzer/name_resolution_pass.h"
#include "flatsql/analyzer/pass_manager.h"

namespace flatsql {

Analyzer::Analyzer(ScannedProgram& scanned, ParsedProgram& parsed)
    : scanned_program(scanned),
      parsed_program(parsed),
      pass_manager(parsed),
      name_resolution(parsed, attribute_index) {}

std::unique_ptr<AnalyzedProgram> Analyzer::Analyze(ScannedProgram& scanned, ParsedProgram& parsed) {
    Analyzer az{scanned, parsed};
    az.pass_manager.Execute(az.name_resolution);
    return nullptr;
}

}  // namespace flatsql
