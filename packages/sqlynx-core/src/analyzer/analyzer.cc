#include "sqlynx/analyzer/analyzer.h"

#include "sqlynx/analyzer/name_resolution_pass.h"
#include "sqlynx/analyzer/pass_manager.h"
#include "sqlynx/catalog.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"

namespace sqlynx {

Analyzer::Analyzer(std::shared_ptr<ParsedScript> parsed, const Catalog& catalog, std::string_view script_database_name,
                   std::string_view script_schema_name)
    : parsed_program(parsed),
      script_database_name(script_database_name),
      script_schema_name(script_schema_name),
      catalog(catalog),
      pass_manager(*parsed),
      name_resolution(std::make_unique<NameResolutionPass>(*parsed, script_database_name, script_schema_name,
                                                           this->catalog, attribute_index)) {}

std::pair<std::shared_ptr<AnalyzedScript>, proto::StatusCode> Analyzer::Analyze(std::shared_ptr<ParsedScript> parsed,
                                                                                const Catalog& catalog,
                                                                                std::string_view script_database_name,
                                                                                std::string_view script_schema_name) {
    if (parsed == nullptr) {
        return {nullptr, proto::StatusCode::ANALYZER_INPUT_NOT_PARSED};
    }
    // Run analysis passes
    Analyzer az{parsed, catalog, script_database_name, script_schema_name};
    az.pass_manager.Execute(*az.name_resolution);

    // Build program
    auto program = std::make_shared<AnalyzedScript>(parsed, catalog, script_database_name, script_schema_name);
    az.name_resolution->Export(*program);
    return {program, proto::StatusCode::OK};
}

}  // namespace sqlynx
