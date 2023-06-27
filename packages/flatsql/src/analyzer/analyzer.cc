#include "flatsql/analyzer/analyzer.h"

#include "flatsql/analyzer/name_resolution_pass.h"
#include "flatsql/analyzer/pass_manager.h"
#include "flatsql/proto/proto_generated.h"
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

std::pair<std::shared_ptr<AnalyzedScript>, proto::StatusCode> Analyzer::Analyze(
    std::shared_ptr<ParsedScript> parsed, std::shared_ptr<AnalyzedScript> external) {
    if (parsed == nullptr) {
        return {nullptr, proto::StatusCode::ANALYZER_INPUT_INVALID};
    }

    // Run analysis passes
    Analyzer az{parsed, external};
    az.pass_manager.Execute(*az.name_resolution);

    // Build program
    auto program = std::make_shared<AnalyzedScript>(parsed, external);
    az.name_resolution->Export(*program);
    return {program, proto::StatusCode::OK};
}

}  // namespace flatsql
