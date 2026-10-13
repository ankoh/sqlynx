#pragma once

#include <flatbuffers/flatbuffer_builder.h>

#include <cstdint>
#include <optional>
#include <memory>
#include <string>
#include <vector>

#include "dashql/buffers/index_generated.h"
#include "dashql/script.h"

namespace dashql {

namespace visualize {
using MarkdownDocument = buffers::visualization::MarkdownSpecT;
using UmapDocument = buffers::visualization::UmapSpecT;
}

struct ScriptCompilationError {
    buffers::execution::ScriptCompilationErrorCode code;
    uint32_t statement_id = PROTO_NULL_U32;
    uint32_t ast_node_id = PROTO_NULL_U32;
    std::optional<TextSpan> text_span;
    std::string message;
};

struct CompiledVisualization {
    std::string renderer;
    std::string vegalite_spec;
    std::shared_ptr<visualize::UmapDocument> umap_spec;
    std::shared_ptr<visualize::MarkdownDocument> markdown_spec;
    std::shared_ptr<buffers::visualization::DashboardSpecT> dashboard;
    std::shared_ptr<buffers::visualization::TableSpecT> table_spec;

    buffers::execution::CompiledVisualizationT ToObject() const;
};

struct CompiledScriptStatement {
    uint32_t statement_id = PROTO_NULL_U32;
    buffers::parser::StatementType statement_type = buffers::parser::StatementType::NONE;
    buffers::execution::CompiledScriptStatementKind kind =
        buffers::execution::CompiledScriptStatementKind::COMMAND;
    std::string sql;
    std::optional<CompiledVisualization> visualization;
};

struct ScriptCompilationResult {
    buffers::execution::ScriptCompilationStatementKind kind =
        buffers::execution::ScriptCompilationStatementKind::QUERY;
    uint32_t terminal_statement_id = PROTO_NULL_U32;
    std::string sql;
    std::string cache_signature;
    bool cacheable = false;
    std::optional<CompiledVisualization> visualization;
    std::vector<ScriptCompilationError> errors;
    std::vector<CompiledScriptStatement> statements;

    flatbuffers::Offset<buffers::execution::ScriptCompilationResult> Pack(
        flatbuffers::FlatBufferBuilder& builder) const;
};

struct ScriptCompiler {
    /// Compile metadata without modifying the analyzed script; throws on invalid metadata.
    static CompiledVisualization CompileVisualization(const VisualizationSpec& visualization,
                                                      const AnalyzedScript& script);

    static ScriptCompilationResult Compile(Script& script,
                                           const buffers::formatting::FormattingConfigT& config,
                                           ScriptCompilationOptions options = {});
};

}  // namespace dashql
