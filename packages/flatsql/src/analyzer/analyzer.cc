#include "flatsql/analyzer/analyzer.h"

#include "flatsql/analyzer/name_resolution_pass.h"
#include "flatsql/analyzer/pass_manager.h"
#include "flatsql/script.h"

namespace flatsql {

Analyzer::Analyzer(std::shared_ptr<ScannedScript> scanned, std::shared_ptr<ParsedScript> parsed,
                   std::shared_ptr<AnalyzedScript> external)
    : scanned_program(scanned),
      parsed_program(parsed),
      pass_manager(*parsed),
      name_resolution(std::make_unique<NameResolutionPass>(*parsed, attribute_index)),
      schema(external) {
    if (schema) {
        name_resolution->RegisterExternalTables(*schema);
    }
}

std::shared_ptr<AnalyzedScript> Analyzer::Analyze(std::shared_ptr<ScannedScript> scanned,
                                                  std::shared_ptr<ParsedScript> parsed,
                                                  std::shared_ptr<AnalyzedScript> external) {
    // Run analysis passes
    Analyzer az{scanned, parsed, external};
    az.pass_manager.Execute(*az.name_resolution);

    // Build program
    auto program = std::make_shared<AnalyzedScript>(scanned, parsed);
    az.name_resolution->Export(*program);
    return program;
}

}  // namespace flatsql
