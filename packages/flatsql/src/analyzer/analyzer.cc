#include "flatsql/analyzer/analyzer.h"

#include "flatsql/analyzer/name_resolution_pass.h"
#include "flatsql/analyzer/pass_manager.h"
#include "flatsql/program.h"

namespace flatsql {

Analyzer::Analyzer(ScannedProgram& scanned, ParsedProgram& parsed, const AnalyzedProgram* schema)
    : scanned_program(scanned),
      parsed_program(parsed),
      pass_manager(parsed),
      name_resolution(parsed, attribute_index),
      schema(schema) {
    if (schema) {
        name_resolution.RegisterExternalTables(*schema);
    }
}

std::unique_ptr<AnalyzedProgram> Analyzer::Analyze(ScannedProgram& scanned, ParsedProgram& parsed,
                                                   const AnalyzedProgram* schema) {
    // Run analysis passes
    Analyzer az{scanned, parsed, std::move(schema)};
    az.pass_manager.Execute(az.name_resolution);

    // Build program
    auto program = std::make_unique<AnalyzedProgram>(scanned, parsed);
    az.name_resolution.Export(*program);
    return program;
}

}  // namespace flatsql
