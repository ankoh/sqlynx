#include "sqlynx/analyzer/analyzer.h"

#include "sqlynx/analyzer/name_resolution_pass.h"
#include "sqlynx/analyzer/pass_manager.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/schema.h"
#include "sqlynx/script.h"

namespace sqlynx {

Analyzer::Analyzer(std::shared_ptr<ParsedScript> parsed, std::string_view database_name, std::string_view schema_name,
                   SchemaSearchPath schema_search_path)
    : parsed_program(parsed),
      database_name(database_name),
      schema_name(schema_name),
      schema_search_path(schema_search_path),
      pass_manager(*parsed),
      name_resolution(std::make_unique<NameResolutionPass>(*parsed, database_name, schema_name,
                                                           this->schema_search_path, attribute_index)) {}

std::pair<std::shared_ptr<AnalyzedScript>, proto::StatusCode> Analyzer::Analyze(
    std::shared_ptr<ParsedScript> parsed, std::string_view database_name, std::string_view schema_name,
    const SchemaSearchPath* schema_search_path) {
    if (parsed == nullptr) {
        return {nullptr, proto::StatusCode::ANALYZER_INPUT_INVALID};
    }
    // Run analysis passes
    SchemaSearchPath search_path_snapshot;
    if (schema_search_path) {
        search_path_snapshot = schema_search_path->CreateSnapshot();
    }
    Analyzer az{parsed, database_name, schema_name, search_path_snapshot};
    az.pass_manager.Execute(*az.name_resolution);

    // Build program
    auto program =
        std::make_shared<AnalyzedScript>(parsed, std::move(search_path_snapshot), database_name, schema_name);
    az.name_resolution->Export(*program);
    return {program, proto::StatusCode::OK};
}

}  // namespace sqlynx
