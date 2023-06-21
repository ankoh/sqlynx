#include "flatsql/analyzer/analyzer.h"

#include "flatsql/analyzer/name_resolution_pass.h"
#include "flatsql/analyzer/pass_manager.h"
#include "flatsql/script.h"

namespace flatsql {

Analyzer::Analyzer(std::shared_ptr<ParsedScript> parsed, std::shared_ptr<AnalyzedScript> external)
    : parsed_program(parsed),
      pass_manager(*parsed),
      name_resolution(std::make_unique<NameResolutionPass>(*parsed, attribute_index)),
      external_script(external) {
    if (external) {
        name_resolution->RegisterExternalTables(*external);
    }
}

std::shared_ptr<AnalyzedScript> Analyzer::Analyze(std::shared_ptr<ParsedScript> parsed,
                                                  std::shared_ptr<AnalyzedScript> external) {
    // Run analysis passes
    Analyzer az{parsed, external};
    az.pass_manager.Execute(*az.name_resolution);

    // Build program
    auto program = std::make_shared<AnalyzedScript>(parsed, external);
    az.name_resolution->Export(*program);
    return program;
}

}  // namespace flatsql
