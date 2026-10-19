#include "dashql/analyzer/analyzer.h"
#include "dashql/analyzer/name_resolution_pass.h"
#include "dashql/analyzer/pass_manager.h"
#include "dashql/buffers/index_generated.h"
#include "dashql/catalog.h"
#include "dashql/script.h"

namespace dashql {

AnalysisState::AnalysisState(std::shared_ptr<ParsedScript> parsed, Catalog& catalog)
    : scanned(*parsed->scanned_script),
      parsed(*parsed),
      ast(parsed->GetNodes()),
      analyzed(std::make_shared<AnalyzedScript>(parsed, catalog)),
      catalog_entry_id(parsed->external_id),
      catalog(catalog),
      empty_name(parsed->scanned_script->name_registry.Register("")),
      expression_index(parsed->GetNodes().size(), nullptr) {
    empty_name.coarse_analyzer_tags |= buffers::analyzer::NameTag::DATABASE_NAME;
    empty_name.coarse_analyzer_tags |= buffers::analyzer::NameTag::SCHEMA_NAME;
}

std::span<std::reference_wrapper<RegisteredName>> AnalysisState::ReadNamePath(const sx::parser::Node& node) {
    if (node.node_type() != buffers::parser::NodeType::ARRAY) {
        return {};
    }
    name_path_buffer.clear();
    auto children = ast.subspan(node.children_begin_or_value(), node.children_count());
    for (size_t i = 0; i != children.size(); ++i) {
        // A child is either a name, an indirection or an operator (*).
        // We only consider plan name paths for now and extend later.
        auto& child = children[i];
        // Skip over trailing dots
        if (child.node_type() == buffers::parser::NodeType::OBJECT_EXT_TRAILING_DOT) {
            continue;
        }
        // Not a name?
        if (child.node_type() != buffers::parser::NodeType::NAME) {
            name_path_buffer.clear();
            break;
        }
        auto& name = scanned.GetNames().At(child.children_begin_or_value());
        name_path_buffer.push_back(name);
    }
    return std::span{name_path_buffer};
}

std::optional<AnalyzedScript::QualifiedTableName> AnalysisState::ReadQualifiedTableName(const sx::parser::Node* node) {
    if (!node) {
        return std::nullopt;
    }
    auto name_path = ReadNamePath(*node);
    auto ast_node_id = node - ast.data();
    switch (name_path.size()) {
        case 3:
            name_path[0].get().coarse_analyzer_tags |= sx::analyzer::NameTag::DATABASE_NAME;
            name_path[1].get().coarse_analyzer_tags |= sx::analyzer::NameTag::SCHEMA_NAME;
            name_path[2].get().coarse_analyzer_tags |= sx::analyzer::NameTag::TABLE_NAME;
            return AnalyzedScript::QualifiedTableName{ast_node_id, name_path[0], name_path[1], name_path[2]};
        case 2: {
            name_path[0].get().coarse_analyzer_tags |= sx::analyzer::NameTag::SCHEMA_NAME;
            name_path[1].get().coarse_analyzer_tags |= sx::analyzer::NameTag::TABLE_NAME;
            return AnalyzedScript::QualifiedTableName{ast_node_id, empty_name, name_path[0], name_path[1]};
        }
        case 1: {
            name_path[0].get().coarse_analyzer_tags |= sx::analyzer::NameTag::TABLE_NAME;
            return AnalyzedScript::QualifiedTableName{ast_node_id, empty_name, empty_name, name_path[0]};
        }
        default:
            return std::nullopt;
    }
}

std::optional<AnalyzedScript::QualifiedColumnName> AnalysisState::ReadQualifiedColumnName(
    const sx::parser::Node* node) {
    if (!node) {
        return std::nullopt;
    }
    auto name_path = ReadNamePath(*node);
    uint32_t ast_node_id = node - ast.data();
    // Build the qualified column name.
    // Paths with more than two names access fields of a row-typed column, e.g. table.column.field.
    switch (name_path.size()) {
        case 0:
            return std::nullopt;
        case 1:
            name_path[0].get().coarse_analyzer_tags |= sx::analyzer::NameTag::COLUMN_NAME;
            return AnalyzedScript::QualifiedColumnName{ast_node_id, std::nullopt, name_path[0]};
        default:
            name_path[0].get().coarse_analyzer_tags |= sx::analyzer::NameTag::TABLE_ALIAS;
            name_path[1].get().coarse_analyzer_tags |= sx::analyzer::NameTag::COLUMN_NAME;
            return AnalyzedScript::QualifiedColumnName{ast_node_id, name_path[0], name_path[1]};
    }
}

std::optional<AnalyzedScript::QualifiedFunctionName> AnalysisState::ReadQualifiedFunctionName(
    const sx::parser::Node* node) {
    if (!node) {
        return std::nullopt;
    }
    auto name_path = ReadNamePath(*node);
    auto ast_node_id = node - ast.data();
    switch (name_path.size()) {
        case 3:
            name_path[0].get().coarse_analyzer_tags |= sx::analyzer::NameTag::DATABASE_NAME;
            name_path[1].get().coarse_analyzer_tags |= sx::analyzer::NameTag::SCHEMA_NAME;
            name_path[2].get().coarse_analyzer_tags |= sx::analyzer::NameTag::FUNCTION_NAME;
            return AnalyzedScript::QualifiedFunctionName{ast_node_id, name_path[0], name_path[1], name_path[2]};
        case 2: {
            name_path[0].get().coarse_analyzer_tags |= sx::analyzer::NameTag::SCHEMA_NAME;
            name_path[1].get().coarse_analyzer_tags |= sx::analyzer::NameTag::FUNCTION_NAME;
            return AnalyzedScript::QualifiedFunctionName{ast_node_id, empty_name, name_path[0], name_path[1]};
        }
        case 1: {
            name_path[0].get().coarse_analyzer_tags |= sx::analyzer::NameTag::FUNCTION_NAME;
            return AnalyzedScript::QualifiedFunctionName{ast_node_id, empty_name, empty_name, name_path[0]};
        }
        default:
            return std::nullopt;
    }
}

}  // namespace dashql
