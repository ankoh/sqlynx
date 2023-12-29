#include "sqlynx/analyzer/analyzer.h"

#include "sqlynx/analyzer/name_resolution_pass.h"
#include "sqlynx/analyzer/pass_manager.h"
#include "sqlynx/catalog.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"

namespace sqlynx {

Analyzer::Analyzer(std::shared_ptr<ParsedScript> parsed, std::string_view database_name, std::string_view schema_name,
                   const Catalog& catalog)
    : parsed_program(parsed),
      database_name(database_name),
      schema_name(schema_name),
      catalog(catalog),
      pass_manager(*parsed),
      name_resolution(
          std::make_unique<NameResolutionPass>(*parsed, database_name, schema_name, this->catalog, attribute_index)) {}

std::pair<std::shared_ptr<AnalyzedScript>, proto::StatusCode> Analyzer::Analyze(std::shared_ptr<ParsedScript> parsed,
                                                                                std::string_view database_name,
                                                                                std::string_view schema_name,
                                                                                const Catalog* catalog_ptr) {
    if (parsed == nullptr) {
        return {nullptr, proto::StatusCode::ANALYZER_INPUT_NOT_PARSED};
    }
    // Run analysis passes
    static Catalog static_catalog;
    const Catalog& catalog = catalog_ptr ? *catalog_ptr : static_catalog;
    Analyzer az{parsed, database_name, schema_name, catalog};
    az.pass_manager.Execute(*az.name_resolution);

    // Build program
    auto program = std::make_shared<AnalyzedScript>(parsed, std::move(catalog), database_name, schema_name);
    az.name_resolution->Export(*program);
    return {program, proto::StatusCode::OK};
}

}  // namespace sqlynx
