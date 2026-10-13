#include "dashql/script_compiler.h"

#include <algorithm>
#include <cctype>
#include <stdexcept>

#include "dashql/formatter/formatter.h"
#include "dashql/script.h"
#include "dashql/utils/ast_attributes.h"
#include "dashql/visualize/markdown.h"
#include "dashql/visualize/umap.h"
#include "dashql/visualize/vegalite.h"

namespace dashql {

using AttributeKey = buffers::parser::AttributeKey;
using ErrorCode = buffers::execution::ScriptCompilationErrorCode;
using NodeType = buffers::parser::NodeType;
using StatementKind = buffers::execution::ScriptCompilationStatementKind;
using CompiledKind = buffers::execution::CompiledScriptStatementKind;

namespace {

ScriptCompilationError MakeError(ErrorCode code, std::string message, uint32_t statement_id = PROTO_NULL_U32,
                                 uint32_t ast_node_id = PROTO_NULL_U32, std::optional<TextSpan> text_span = {}) {
    return ScriptCompilationError{code, statement_id, ast_node_id, text_span, std::move(message)};
}

std::optional<uint32_t> ReadTerminalSqlNode(const ParsedScript& parsed, uint32_t statement_id, StatementKind& kind) {
    const auto& statement = parsed.statements[statement_id];
    switch (statement.type) {
        case buffers::parser::StatementType::CREATE_FUNCTION:
        case buffers::parser::StatementType::CREATE_TABLE:
        case buffers::parser::StatementType::CREATE_TABLE_AS:
        case buffers::parser::StatementType::CREATE_VIEW:
        case buffers::parser::StatementType::DROP_TABLE:
        case buffers::parser::StatementType::DROP_VIEW:
        case buffers::parser::StatementType::SELECT_INTO:
        case buffers::parser::StatementType::ATTACH_DATABASE:
        case buffers::parser::StatementType::EXPLAIN:
        case buffers::parser::StatementType::SELECT:
        case buffers::parser::StatementType::INSERT:
        case buffers::parser::StatementType::DELETE:
        case buffers::parser::StatementType::SET:
            kind = StatementKind::QUERY;
            return statement.root;
        case buffers::parser::StatementType::NONE:
            return std::nullopt;
        case buffers::parser::StatementType::VIS_VISUALISE: {
            kind = StatementKind::VISUALIZE;
            const auto& root = parsed.nodes[statement.root];
            auto [source] = LookupAttributes<AttributeKey::VIS_VISUALISE_SELECT>(
                std::span{parsed.nodes}.subspan(root.children_begin_or_value(), root.children_count()));
            if (!source) return std::nullopt;
            return static_cast<uint32_t>(source - parsed.nodes.data());
        }
    }
    return std::nullopt;
}

bool HasReturning(const ParsedScript& parsed, const ParsedScript::Statement& statement) {
    const auto& root = parsed.nodes[statement.root];
    auto [insert_returning, delete_returning] = LookupAttributes<AttributeKey::SQL_INSERT_RETURNING,
                                                              AttributeKey::SQL_DELETE_RETURNING>(
        std::span{parsed.nodes}.subspan(root.children_begin_or_value(), root.children_count()));
    auto* returning = statement.type == buffers::parser::StatementType::DELETE ? delete_returning : insert_returning;
    return returning != nullptr && returning->node_type() != NodeType::NONE;
}

bool ProducesOutput(const ParsedScript& parsed, const ParsedScript::Statement& statement) {
    switch (statement.type) {
        case buffers::parser::StatementType::SELECT:
        case buffers::parser::StatementType::EXPLAIN:
        case buffers::parser::StatementType::SELECT_INTO:
        case buffers::parser::StatementType::VIS_VISUALISE:
            return true;
        case buffers::parser::StatementType::INSERT:
        case buffers::parser::StatementType::DELETE:
            return HasReturning(parsed, statement);
        default:
            return false;
    }
}

flatbuffers::Offset<buffers::execution::CompiledVisualization> PackVisualization(
    flatbuffers::FlatBufferBuilder& builder, const CompiledVisualization& visualization) {
    auto renderer = builder.CreateString(visualization.renderer);
    auto vegalite = builder.CreateString(visualization.vegalite_spec);
    flatbuffers::Offset<buffers::visualization::UmapSpec> umap;
    if (visualization.umap_spec) {
        umap = visualize::PackUmapSpec(builder, *visualization.umap_spec);
    }
    flatbuffers::Offset<buffers::visualization::MarkdownSpec> markdown;
    if (visualization.markdown_spec) {
        markdown = visualize::PackMarkdownSpec(builder, *visualization.markdown_spec);
    }
    auto dashboard = buffers::visualization::CreateDashboardSpec(
        builder, visualization.dashboard ? visualization.dashboard->row : flatbuffers::Optional<int32_t>{},
        visualization.dashboard ? visualization.dashboard->column : flatbuffers::Optional<int32_t>{},
        visualization.dashboard ? visualization.dashboard->width : 6,
        visualization.dashboard ? visualization.dashboard->height : 3);
    flatbuffers::Offset<buffers::visualization::TableSpec> table;
    if (visualization.table_spec) {
        table = buffers::visualization::CreateTableSpec(builder);
    }
    return buffers::execution::CreateCompiledVisualization(builder, renderer, vegalite, umap, markdown, dashboard,
                                                             table);
}

}  // namespace

buffers::execution::CompiledVisualizationT CompiledVisualization::ToObject() const {
    buffers::execution::CompiledVisualizationT result;
    result.renderer = renderer;
    result.vegalite_spec = vegalite_spec;
    if (umap_spec) result.umap_spec = std::make_unique<visualize::UmapDocument>(*umap_spec);
    if (markdown_spec) result.markdown_spec = std::make_unique<visualize::MarkdownDocument>(*markdown_spec);
    if (dashboard) result.dashboard = std::make_unique<buffers::visualization::DashboardSpecT>(*dashboard);
    if (table_spec) result.table_spec = std::make_unique<buffers::visualization::TableSpecT>(*table_spec);
    return result;
}

CompiledVisualization ScriptCompiler::CompileVisualization(const VisualizationSpec& visualization,
                                                           const AnalyzedScript& script) {
    if (!visualization.renderer) throw std::invalid_argument("could not resolve visualization renderer");
    const auto& spec = visualization;
    CompiledVisualization compiled{.renderer = std::string(*spec.renderer)};
    std::transform(compiled.renderer.begin(), compiled.renderer.end(), compiled.renderer.begin(),
                   [](unsigned char c) { return std::tolower(c); });
    compiled.dashboard = std::make_shared<buffers::visualization::DashboardSpecT>();
    compiled.dashboard->row = spec.dashboard.row;
    compiled.dashboard->column = spec.dashboard.column;
    compiled.dashboard->width = spec.dashboard.width;
    compiled.dashboard->height = spec.dashboard.height;
    if (compiled.renderer == "vegalite") {
        compiled.vegalite_spec = visualize::GenerateVegaLiteSpec(spec, script);
    } else if (compiled.renderer == "umap") {
        compiled.umap_spec = visualize::CompileUmapSpec(spec, script);
        if (!compiled.umap_spec || compiled.umap_spec->vector_column.empty()) {
            throw std::invalid_argument("UMAP visualization requires a vector field");
        }
    } else if (compiled.renderer == "markdown") {
        compiled.markdown_spec = visualize::CompileMarkdownSpec(spec);
        if (!compiled.markdown_spec) throw std::invalid_argument("could not compile Markdown visualization spec");
    } else if (compiled.renderer == "table") {
        compiled.table_spec = std::make_shared<buffers::visualization::TableSpecT>();
    } else {
        throw std::invalid_argument("unsupported visualization renderer: " + compiled.renderer);
    }
    return compiled;
}

flatbuffers::Offset<buffers::execution::ScriptCompilationResult> ScriptCompilationResult::Pack(
    flatbuffers::FlatBufferBuilder& builder) const {
    std::vector<flatbuffers::Offset<buffers::execution::ScriptCompilationError>> error_offsets;
    error_offsets.reserve(errors.size());
    for (const auto& error : errors) {
        auto message = builder.CreateString(error.message);
        buffers::execution::ScriptCompilationErrorBuilder eb{builder};
        eb.add_code(error.code);
        eb.add_statement_id(error.statement_id);
        eb.add_ast_node_id(error.ast_node_id);
        if (error.text_span) eb.add_text_span(&error.text_span.value());
        eb.add_message(message);
        error_offsets.push_back(eb.Finish());
    }
    auto errors_offset = builder.CreateVector(error_offsets);
    auto sql_offset = builder.CreateString(sql);

    flatbuffers::Offset<buffers::execution::CompiledVisualization> visualization_offset;
    if (visualization) {
        visualization_offset = PackVisualization(builder, *visualization);
    }
    std::vector<flatbuffers::Offset<buffers::execution::CompiledScriptStatement>> statement_offsets;
    statement_offsets.reserve(statements.size());
    for (const auto& statement : statements) {
        flatbuffers::Offset<buffers::execution::CompiledVisualization> statement_visualization;
        if (statement.visualization) statement_visualization = PackVisualization(builder, *statement.visualization);
        statement_offsets.push_back(buffers::execution::CreateCompiledScriptStatement(
            builder, statement.statement_id, statement.statement_type, statement.kind,
            builder.CreateString(statement.sql), statement_visualization));
    }
    auto statements_offset = builder.CreateVector(statement_offsets);
    auto cache_signature_offset = builder.CreateString(cache_signature);
    return buffers::execution::CreateScriptCompilationResult(builder, kind, terminal_statement_id, sql_offset,
                                                               visualization_offset, errors_offset, statements_offset,
                                                               cache_signature_offset, cacheable);
}

ScriptCompilationResult ScriptCompiler::Compile(Script& script, const buffers::formatting::FormattingConfigT& config,
                                                ScriptCompilationOptions options) {
    ScriptCompilationResult result;
    if (options.parse_if_outdated &&
        (!script.parsed_script || script.parsed_script->scanned_script->text_version != script.text_version)) {
        script.Parse();
    }
    if (!script.parsed_script) {
        result.errors.push_back(MakeError(ErrorCode::EMPTY_SCRIPT, "script is not parsed"));
        return result;
    }
    auto& parsed = *script.parsed_script;

    for (const auto& [span, message] : parsed.scanned_script->errors) {
        result.errors.push_back(MakeError(ErrorCode::SCANNER_ERROR, message, PROTO_NULL_U32, PROTO_NULL_U32, span));
    }
    for (const auto& error : parsed.errors) {
        result.errors.push_back(MakeError(ErrorCode::PARSER_ERROR, error.message, PROTO_NULL_U32, PROTO_NULL_U32,
                                          parsed.scanned_script->ResolveTextSpan(error.location)));
    }
    if (!result.errors.empty()) {
        const auto sql = script.ToString();
        if (std::any_of(sql.begin(), sql.end(), [](unsigned char c) { return !std::isspace(c); })) {
            // The remote dialect may accept SQL that our scanner/parser does not. Without a
            // reliable AST, send the original text once and do not cache or split it locally.
            result.sql = sql;
            result.terminal_statement_id = 0;
            result.statements.push_back({.statement_id = 0, .kind = CompiledKind::OUTPUT, .sql = sql});
        }
        return result;
    }
    if (parsed.statements.empty()) {
        result.errors.push_back(MakeError(ErrorCode::EMPTY_SCRIPT, "script has no executable statement"));
        return result;
    }

    constexpr auto execution_features = static_cast<uint32_t>(buffers::parser::ParsedScriptFeature::VISUALIZE);
    if (!options.allow_extensions && (parsed.feature_flags & execution_features) != 0) {
        result.errors.push_back(MakeError(ErrorCode::EXTENSIONS_DISABLED,
                                           "DashQL VISUALIZE syntax is not executable in the shell"));
        return result;
    }
    auto terminal_statement_id = static_cast<uint32_t>(parsed.statements.size() - 1);
    result.terminal_statement_id = terminal_statement_id;
    const auto terminal_type = parsed.statements.back().type;
    result.cacheable = terminal_type == buffers::parser::StatementType::SELECT ||
                       terminal_type == buffers::parser::StatementType::EXPLAIN ||
                       terminal_type == buffers::parser::StatementType::VIS_VISUALISE;

    auto descriptions = parsed.AssociateDescriptions();
    auto input = parsed.scanned_script->GetInput();
    result.statements.reserve(parsed.statements.size());
    for (uint32_t statement_id = 0; statement_id < parsed.statements.size(); ++statement_id) {
        const auto& statement = parsed.statements[statement_id];
        const bool produces_output = ProducesOutput(parsed, statement);
        if (produces_output && statement_id != terminal_statement_id) {
            const auto& span = descriptions[statement_id].statement_span;
            result.errors.push_back(MakeError(ErrorCode::OUTPUT_STATEMENT_NOT_LAST,
                                              "SELECT, EXPLAIN, SELECT INTO, INSERT RETURNING, DELETE RETURNING, or VISUALIZE must be the final statement",
                                              statement_id, statement.root, span));
            continue;
        }
        const auto& statement_span = descriptions[statement_id].statement_span;
        result.statements.push_back({
            .statement_id = statement_id,
            .statement_type = statement.type,
            .kind = produces_output ? CompiledKind::OUTPUT : CompiledKind::COMMAND,
            .sql = std::string{input.substr(statement_span.offset(), statement_span.length())},
        });
    }
    if (!result.errors.empty()) return result;
    result.cache_signature = script.ComputeSignature(false);

    if ((parsed.feature_flags & execution_features) == 0) {
        result.kind = StatementKind::QUERY;
        result.sql = result.statements.back().sql;
        return result;
    }

    auto terminal_sql_node_id = ReadTerminalSqlNode(parsed, terminal_statement_id, result.kind);
    if (!terminal_sql_node_id) {
        auto root_id = parsed.statements.back().root;
        result.errors.push_back(MakeError(ErrorCode::LAST_STATEMENT_NOT_EXECUTABLE,
                                          "the final statement must be a query or VISUALIZE statement",
                                          terminal_statement_id, root_id,
                                          parsed.scanned_script->ResolveTextSpan(parsed.nodes[root_id].symbol_span())));
        return result;
    }

    if (result.kind == StatementKind::VISUALIZE &&
        (!script.analyzed_script || script.analyzed_script->parsed_script.get() != script.parsed_script.get())) {
        script.Analyze(false);
    }

    Formatter formatter{parsed};
    result.sql = formatter.FormatNodeAt(*terminal_sql_node_id, config);
    if (result.sql.empty()) {
        result.sql.clear();
        result.errors.push_back(MakeError(ErrorCode::FORMAT_ERROR, "could not format the executable query",
                                          terminal_statement_id, *terminal_sql_node_id));
        return result;
    }

    if (result.kind == StatementKind::VISUALIZE) {
        const VisualizationSpec* visualization = nullptr;
        script.analyzed_script->visualization_specs.ForEach([&](size_t, VisualizationSpec& spec) {
            if (!visualization && spec.ast_statement_id == terminal_statement_id) visualization = &spec;
        });
        if (!visualization || !visualization->renderer) {
            result.sql.clear();
            result.errors.push_back(MakeError(ErrorCode::VISUALIZATION_METADATA_UNAVAILABLE,
                                              "could not resolve visualization metadata", terminal_statement_id,
                                              parsed.statements.back().root));
            return result;
        }
        try {
            result.visualization = CompileVisualization(*visualization, *script.analyzed_script);
        } catch (const std::exception& error) {
            result.sql.clear();
            result.errors.push_back(MakeError(ErrorCode::VISUALIZATION_METADATA_UNAVAILABLE, error.what(),
                                              terminal_statement_id, parsed.statements.back().root));
            return result;
        }
        auto& terminal = result.statements.back();
        terminal.kind = CompiledKind::VISUALIZE;
        terminal.sql = result.sql;
        terminal.visualization = result.visualization;
    }
    return result;
}

}  // namespace dashql
