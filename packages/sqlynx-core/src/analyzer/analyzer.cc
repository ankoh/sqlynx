#include "sqlynx/analyzer/analyzer.h"

#include "sqlynx/analyzer/name_resolution_pass.h"
#include "sqlynx/analyzer/pass_manager.h"
#include "sqlynx/catalog.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"

namespace sqlynx {

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

}  // namespace sqlynx
