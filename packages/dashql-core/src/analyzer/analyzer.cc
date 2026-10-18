#include "dashql/analyzer/analyzer.h"

#include "dashql/analyzer/analyze_visualization_pass.h"
#include "dashql/analyzer/constant_propagation_pass.h"
#include "dashql/analyzer/identify_function_calls_pass.h"
#include "dashql/analyzer/name_resolution_pass.h"
#include "dashql/analyzer/pass_manager.h"
#include "dashql/buffers/index_generated.h"
#include "dashql/catalog.h"
#include "dashql/exception.h"
#include "dashql/script.h"

namespace dashql {

Analyzer::Analyzer(std::shared_ptr<ParsedScript> parsed, Catalog& catalog)
    : state(parsed, catalog),
      pass_manager(),
      name_resolution(std::make_unique<NameResolutionPass>(state)),
      identify_function_calls(std::make_unique<IdentifyFunctionCallsPass>(state)),
      identify_constants(std::make_unique<ConstantPropagationPass>(state)),
      analyze_visualization(std::make_unique<AnalyzeVisualizationPass>(state)) {}

std::shared_ptr<AnalyzedScript> Analyzer::Execute() {
    std::initializer_list<std::reference_wrapper<PassManager::LTRPass>> scan1{
        *name_resolution, *identify_function_calls, *identify_constants, *analyze_visualization,
    };
    pass_manager.Execute(state, scan1);
    // Malformed comment tags fall back to ordinary comments, warn so that they don't go unnoticed
    for (auto& [span, message] : state.analyzed->parsed_script->comment_blocks.warnings) {
        auto& warning = state.analyzed->errors.emplace_back();
        warning.error_type = buffers::analyzer::AnalyzerErrorType::MALFORMED_COMMENT_TAG;
        warning.severity = buffers::analyzer::AnalyzerErrorSeverity::WARNING;
        warning.ast_node_id = PROTO_NULL_U32;
        warning.text_span = std::make_unique<buffers::parser::TextSpan>(span);
        warning.message = message;
    }
    return state.analyzed;
}

std::shared_ptr<AnalyzedScript> Analyzer::Analyze(std::shared_ptr<ParsedScript> parsed, Catalog& catalog) {
    if (parsed == nullptr) {
        throw Exception(buffers::status::StatusCode::SCRIPT_NOT_PARSED);
    }
    Analyzer az{parsed, catalog};
    return az.Execute();
}

}  // namespace dashql
