#include "dashql/analyzer/analyzer.h"

#include "dashql/analyzer/name_resolution_pass.h"
#include "dashql/analyzer/pass_manager.h"
#include "dashql/catalog.h"
#include "dashql/proto/proto_generated.h"
#include "dashql/script.h"

namespace dashql {

Analyzer::Analyzer(std::shared_ptr<ParsedScript> parsed, Catalog& catalog)
    : parsed(parsed),
      analyzed(std::make_shared<AnalyzedScript>(parsed, catalog)),
      catalog(catalog),
      pass_manager(*parsed),
      name_resolution(std::make_unique<NameResolutionPass>(*analyzed, catalog, attribute_index)) {}

std::pair<std::shared_ptr<AnalyzedScript>, proto::StatusCode> Analyzer::Analyze(std::shared_ptr<ParsedScript> parsed,
                                                                                Catalog& catalog) {
    if (parsed == nullptr) {
        return {nullptr, proto::StatusCode::ANALYZER_INPUT_NOT_PARSED};
    }
    // Run analysis passes
    Analyzer az{parsed, catalog};
    az.pass_manager.Execute(*az.name_resolution);

    // Build program
    return {az.analyzed, proto::StatusCode::OK};
}

}  // namespace dashql
