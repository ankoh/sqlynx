#include "sqlynx/analyzer/analyzer.h"

#include "sqlynx/analyzer/name_resolution_pass.h"
#include "sqlynx/analyzer/pass_manager.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/schema.h"
#include "sqlynx/script.h"

namespace sqlynx {

Analyzer::Analyzer(std::shared_ptr<ParsedScript> parsed, SchemaSearchPath schema_search_path)
    : parsed_program(parsed),
      schema_search_path(schema_search_path),
      pass_manager(*parsed),
      name_resolution(std::make_unique<NameResolutionPass>(*parsed, this->schema_search_path, attribute_index)) {}

std::pair<std::shared_ptr<AnalyzedScript>, proto::StatusCode> Analyzer::Analyze(
    std::shared_ptr<ParsedScript> parsed, std::string database_name, std::string schema_name,
    const SchemaSearchPath& schema_search_path) {
    if (parsed == nullptr) {
        return {nullptr, proto::StatusCode::ANALYZER_INPUT_INVALID};
    }
    // Run analysis passes
    auto search_path_snapshot = schema_search_path.CreateSnapshot();
    Analyzer az{parsed, search_path_snapshot};
    az.pass_manager.Execute(*az.name_resolution);

    // Build program
    auto program =
        std::make_shared<AnalyzedScript>(parsed, database_name, schema_name, std::move(search_path_snapshot));
    az.name_resolution->Export(*program);
    return {program, proto::StatusCode::OK};
}

}  // namespace sqlynx
