#include "dashql/script_session.h"

#include <algorithm>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

#include "dashql/analyzer/completion.h"
#include "dashql/exception.h"
#include "dashql/script_compiler.h"
#include "dashql/script_diff.h"
#include "dashql/text/rope.h"
#include "dashql/utils/ast_attributes.h"
#include "utf8proc/utf8proc_wrapper.hpp"

namespace dashql {
namespace {

using buffers::editor::EditorUpdateStatus;
using EditorCursorSemanticContext = buffers::editor::EditorCursorSemanticContextT;
using EditorCursorState = buffers::editor::EditorCursorStateT;
using EditorDiagnostic = buffers::editor::EditorDiagnosticT;
using EditorProcessingStatistics = buffers::editor::EditorProcessingStatisticsT;
using EditorScriptAnnotations = buffers::editor::EditorScriptAnnotationsT;
using EditorSemanticSpan = buffers::editor::EditorSemanticSpanT;
using EditorStatement = buffers::editor::EditorStatementT;
using EditorStatementDescription = buffers::editor::EditorStatementDescriptionT;
using EditorSyntaxSpan = buffers::editor::EditorSyntaxSpanT;
using EditorTableDefinition = buffers::editor::EditorTableDefinitionT;
using EditorTextSpan = buffers::editor::EditorTextSpan;

struct PreparedChange {
    size_t from_byte;
    size_t to_byte;
    size_t from_codepoint;
    size_t to_codepoint;
    std::string_view insert;
    size_t input_order;
};

bool SelectionsEqual(const std::optional<buffers::editor::EditorSelectionT>& left,
                     const std::optional<buffers::editor::EditorSelectionT>& right) {
    if (left.has_value() != right.has_value()) return false;
    return !left || (left->anchor == right->anchor && left->head == right->head);
}

std::string FormatTableName(const CatalogEntry::QualifiedTableName& name) {
    std::string result;
    if (!name.schema_name.get().text.empty()) {
        result.append(name.schema_name.get().text);
        result.push_back('.');
    }
    result.append(name.table_name.get().text);
    return result;
}

struct ResolvedTableIDs {
    uint32_t database_id = 0;
    uint32_t schema_id = 0;
    uint64_t table_id = 0;
    uint32_t catalog_version = 0;
};

std::optional<ResolvedTableIDs> GetResolvedTableIDs(const TableReference& reference) {
    auto* relation = std::get_if<TableReference::RelationExpression>(&reference.inner);
    if (relation == nullptr || !relation->resolved_table) return std::nullopt;
    auto& resolved = *relation->resolved_table;
    auto [database_id, schema_id] = resolved.catalog_schema_id.UnpackSchemaID();
    return ResolvedTableIDs{
        .database_id = database_id,
        .schema_id = schema_id,
        .table_id = resolved.catalog_table_id.UnpackTableID().Pack(),
        .catalog_version = resolved.referenced_catalog_version,
    };
}

bool SameTable(const ResolvedTableIDs& table, uint32_t database_id, uint32_t schema_id, uint64_t table_id) {
    return table.database_id == database_id && table.schema_id == schema_id && table.table_id == table_id;
}

}  // namespace

ScriptSession::ScriptSession(Catalog& catalog, buffers::editor::EditorOffsetUnit offset_unit)
    : catalog_(catalog), script_(catalog), offset_unit_(offset_unit) {
    if (offset_unit != buffers::editor::EditorOffsetUnit::UTF8_BYTES &&
        offset_unit != buffers::editor::EditorOffsetUnit::UTF16_CODE_UNITS) {
        throw std::invalid_argument("invalid editor offset unit");
    }
}

std::optional<rope::Rope::TextPosition> ScriptSession::ResolveOffset(const rope::Rope& text, uint64_t offset) const {
    if (offset > std::numeric_limits<size_t>::max()) return std::nullopt;
    const auto position = static_cast<size_t>(offset);
    return offset_unit_ == buffers::editor::EditorOffsetUnit::UTF16_CODE_UNITS
               ? text.ResolveUtf16Boundary(position)
               : text.ResolveByteBoundary(position);
}

std::optional<uint64_t> ScriptSession::TryProjectByteOffset(uint64_t offset) const {
    if (offset_unit_ == buffers::editor::EditorOffsetUnit::UTF8_BYTES) return offset;
    if (offset > std::numeric_limits<size_t>::max()) return std::nullopt;
    auto position = script_.text.ResolveByteBoundary(static_cast<size_t>(offset));
    if (!position) return std::nullopt;
    return position->utf16_code_units;
}

uint64_t ScriptSession::ProjectByteOffset(uint64_t offset) const {
    auto projected = TryProjectByteOffset(offset);
    if (!projected) throw std::logic_error("internal text span is not on a UTF-8 codepoint boundary");
    return *projected;
}

std::unique_ptr<EditorTextSpan> ScriptSession::ProjectTextSpan(buffers::parser::TextSpan span) const {
    const auto begin = TryProjectByteOffset(span.offset());
    const auto end = TryProjectByteOffset(static_cast<uint64_t>(span.offset()) + span.length());
    if (!begin || !end || *end < *begin) return nullptr;
    return std::make_unique<EditorTextSpan>(*begin, *end - *begin);
}

ScriptSession::EditorUpdate ScriptSession::MakeUpdate(EditorUpdateStatus status, std::string_view message) {
    EditorUpdate update;
    update.status = status;
    update.status_message = message;
    update.offset_unit = offset_unit_;
    update.catalog_entry_id = GetCatalogEntryId();
    update.text_version = GetTextVersion();
    update.state_revision = state_revision_;
    update.catalog_revision = catalog_.GetVersion();
    update.analysis_available = IsAnalysisCurrent();
    if (primary_selection_) {
        update.primary_selection = std::make_unique<EditorSelection>(*primary_selection_);
    }
    return update;
}

ScriptSession::EditorUpdate ScriptSession::FinalizeUpdate(EditorUpdate update) {
    ProjectEditorState(update);
    return update;
}

void ScriptSession::ProjectEditorState(EditorUpdate& update) {
    if (!update.analysis_available) return;

    auto parsed = script_.GetParsedScript();
    auto analyzed = script_.GetAnalyzedScript();
    if (parsed == nullptr || analyzed == nullptr || analyzed->parsed_script != parsed) return;
    auto scanned = parsed->scanned_script;

    auto add_diagnostic = [&](buffers::editor::EditorDiagnosticSource source,
                              buffers::editor::EditorDiagnosticSeverity severity, std::string_view message,
                              buffers::parser::TextSpan span) {
        auto diagnostic = std::make_unique<EditorDiagnostic>();
        auto projected_span = ProjectTextSpan(span);
        if (!projected_span) return;
        diagnostic->source = source;
        diagnostic->severity = severity;
        diagnostic->message = message;
        diagnostic->text_span = std::move(projected_span);
        update.diagnostics.push_back(std::move(diagnostic));
    };
    for (auto& [span, message] : scanned->errors) {
        add_diagnostic(buffers::editor::EditorDiagnosticSource::SCANNER,
                       buffers::editor::EditorDiagnosticSeverity::ERROR, message, span);
    }
    for (auto& error : parsed->errors) {
        add_diagnostic(buffers::editor::EditorDiagnosticSource::PARSER,
                       buffers::editor::EditorDiagnosticSeverity::ERROR, error.message,
                       scanned->ResolveTextSpan(error.location));
    }
    for (auto& error : analyzed->errors) {
        if (error.text_span == nullptr) continue;
        add_diagnostic(buffers::editor::EditorDiagnosticSource::ANALYZER,
                       error.severity == buffers::analyzer::AnalyzerErrorSeverity::WARNING
                           ? buffers::editor::EditorDiagnosticSeverity::WARNING
                           : buffers::editor::EditorDiagnosticSeverity::ERROR,
                       error.message, *error.text_span);
    }
    std::stable_sort(update.diagnostics.begin(), update.diagnostics.end(), [](const auto& left, const auto& right) {
        return left->text_span->offset() < right->text_span->offset();
    });

    auto tokens = parsed->PackTokens();
    update.syntax_spans.reserve(tokens->token_offsets.size() + scanned->comments.size());
    for (size_t i = 0; i < tokens->token_offsets.size(); ++i) {
        auto span = std::make_unique<EditorSyntaxSpan>();
        auto projected_span = ProjectTextSpan(
            buffers::parser::TextSpan{tokens->token_offsets[i], tokens->token_lengths[i]});
        if (!projected_span) continue;
        span->token_type = tokens->token_types[i];
        span->text_span = std::move(projected_span);
        update.syntax_spans.push_back(std::move(span));
    }
    for (auto comment : scanned->comments) {
        auto span = std::make_unique<EditorSyntaxSpan>();
        auto projected_span = ProjectTextSpan(comment);
        if (!projected_span) continue;
        span->token_type = buffers::parser::ScannerTokenType::COMMENT;
        span->text_span = std::move(projected_span);
        update.syntax_spans.push_back(std::move(span));
    }
    std::stable_sort(update.syntax_spans.begin(), update.syntax_spans.end(), [](const auto& left, const auto& right) {
        return left->text_span->offset() < right->text_span->offset();
    });

    analyzed->table_references.ForEach([&](size_t reference_id, const TableReference& reference) {
        if (!reference.location) return;
        auto span = std::make_unique<EditorSemanticSpan>();
        auto projected_span = ProjectTextSpan(scanned->ResolveTextSpan(*reference.location));
        if (!projected_span) return;
        span->kind = buffers::editor::EditorSemanticReferenceKind::TABLE;
        span->reference_id = static_cast<uint32_t>(reference_id);
        span->text_span = std::move(projected_span);
        if (auto resolved = GetResolvedTableIDs(reference)) {
            span->resolution = buffers::editor::EditorSemanticResolution::RESOLVED;
            span->catalog_database_id = resolved->database_id;
            span->catalog_schema_id = resolved->schema_id;
            span->catalog_table_id = resolved->table_id;
            span->referenced_catalog_version = resolved->catalog_version;
        }
        update.semantic_spans.push_back(std::move(span));
    });
    analyzed->expressions.ForEach([&](size_t expression_id, const Expression& expression) {
        auto* column = std::get_if<Expression::ColumnRef>(&expression.inner);
        auto* function = std::get_if<Expression::FunctionCallExpression>(&expression.inner);
        if ((column == nullptr && function == nullptr) || !expression.location) return;
        auto span = std::make_unique<EditorSemanticSpan>();
        auto semantic_location = *expression.location;
        if (function != nullptr && expression.ast_node_id < parsed->nodes.size()) {
            auto& function_node = parsed->nodes[expression.ast_node_id];
            if (function_node.children_count() > 0) {
                auto [name_node] = LookupAttributes<buffers::parser::AttributeKey::SQL_FUNCTION_NAME>(
                    std::span<const buffers::parser::Node>{parsed->nodes}.subspan(
                        function_node.children_begin_or_value(), function_node.children_count()));
                if (name_node != nullptr) semantic_location = name_node->symbol_span();
            }
        }
        auto projected_span = ProjectTextSpan(scanned->ResolveTextSpan(semantic_location));
        if (!projected_span) return;
        span->kind = column != nullptr ? buffers::editor::EditorSemanticReferenceKind::COLUMN
                                       : buffers::editor::EditorSemanticReferenceKind::FUNCTION;
        span->reference_id = static_cast<uint32_t>(expression_id);
        span->text_span = std::move(projected_span);
        if (column != nullptr) {
            if (auto resolved = column->GetResolvedColumnIDs()) {
                auto [database_id, schema_id] = resolved->catalog_schema_id.UnpackSchemaID();
                auto [table_id, column_id] = resolved->catalog_table_column_id.UnpackTableColumnID();
                span->resolution = buffers::editor::EditorSemanticResolution::RESOLVED;
                span->catalog_database_id = database_id;
                span->catalog_schema_id = schema_id;
                span->catalog_table_id = table_id.Pack();
                span->catalog_column_id = column_id;
                span->referenced_catalog_version = resolved->referenced_catalog_version;
            }
        }
        update.semantic_spans.push_back(std::move(span));
    });
    std::stable_sort(
        update.semantic_spans.begin(), update.semantic_spans.end(),
        [](const auto& left, const auto& right) { return left->text_span->offset() < right->text_span->offset(); });

    if (script_.cursor != nullptr && primary_selection_ && primary_selection_->anchor == primary_selection_->head) {
        if (auto projected_offset = TryProjectByteOffset(script_.cursor->text_offset)) {
            auto cursor_state = std::make_unique<EditorCursorState>();
            cursor_state->text_offset = *projected_offset;
            cursor_state->scanner_relative_position = buffers::cursor::RelativeSymbolPosition::AFTER_SYMBOL;
            flatbuffers::FlatBufferBuilder cursor_builder;
            cursor_builder.Finish(script_.cursor->Pack(cursor_builder));
            auto projected_cursor = flatbuffers::GetRoot<buffers::cursor::ScriptCursor>(cursor_builder.GetBufferPointer());
            cursor_state->scanner_relative_position = projected_cursor->scanner_relative_position();
            cursor_state->scanner_symbol_completable = projected_cursor->scanner_symbol_completable();
            update.primary_cursor_state = std::move(cursor_state);
        }

        auto context = std::make_unique<EditorCursorSemanticContext>();
        std::optional<ResolvedTableIDs> target_table;
        std::optional<uint32_t> target_column;
        if (auto* table = std::get_if<ScriptCursor::TableRefContext>(&script_.cursor->context)) {
            context->kind = buffers::editor::EditorCursorSemanticKind::TABLE_REFERENCE;
            context->reference_id = table->table_reference_id;
            if (table->table_reference_id < analyzed->table_references.GetSize()) {
                target_table = GetResolvedTableIDs(analyzed->table_references[table->table_reference_id]);
            }
        } else if (auto* column = std::get_if<ScriptCursor::ColumnRefContext>(&script_.cursor->context)) {
            context->kind = buffers::editor::EditorCursorSemanticKind::COLUMN_REFERENCE;
            context->reference_id = column->expression_id;
            if (column->expression_id < analyzed->expressions.GetSize()) {
                auto& expression = analyzed->expressions[column->expression_id];
                if (auto* column_ref = std::get_if<Expression::ColumnRef>(&expression.inner)) {
                    if (auto resolved = column_ref->GetResolvedColumnIDs()) {
                        auto [database_id, schema_id] = resolved->catalog_schema_id.UnpackSchemaID();
                        auto [table_id, column_id] = resolved->catalog_table_column_id.UnpackTableColumnID();
                        target_table = ResolvedTableIDs{
                            .database_id = database_id,
                            .schema_id = schema_id,
                            .table_id = table_id.Pack(),
                            .catalog_version = resolved->referenced_catalog_version,
                        };
                        target_column = column_id;
                    }
                }
            }
        }
        if (target_table) {
            context->resolved = true;
            context->catalog_database_id = target_table->database_id;
            context->catalog_schema_id = target_table->schema_id;
            context->catalog_table_id = target_table->table_id;
            context->catalog_column_id = target_column.value_or(0);
            context->referenced_catalog_version = target_table->catalog_version;
            analyzed->table_references.ForEach([&](size_t reference_id, const TableReference& reference) {
                auto resolved = GetResolvedTableIDs(reference);
                if (resolved &&
                    SameTable(*resolved, target_table->database_id, target_table->schema_id, target_table->table_id)) {
                    context->related_table_reference_ids.push_back(static_cast<uint32_t>(reference_id));
                }
            });
            analyzed->expressions.ForEach([&](size_t expression_id, const Expression& expression) {
                auto* column_ref = std::get_if<Expression::ColumnRef>(&expression.inner);
                if (column_ref == nullptr) return;
                auto resolved = column_ref->GetResolvedColumnIDs();
                if (!resolved) return;
                auto [database_id, schema_id] = resolved->catalog_schema_id.UnpackSchemaID();
                auto table_id = resolved->catalog_table_column_id.UnpackTableColumnID().first;
                if (database_id == target_table->database_id && schema_id == target_table->schema_id &&
                    table_id.Pack() == target_table->table_id) {
                    context->related_column_reference_ids.push_back(static_cast<uint32_t>(expression_id));
                }
            });
        }
        if (context->kind != buffers::editor::EditorCursorSemanticKind::NONE) {
            update.primary_cursor_context = std::move(context);
        }
    }

    auto annotations = std::make_unique<EditorScriptAnnotations>();
    analyzed->GetTables().ForEach([&](size_t, const CatalogEntry::TableDeclaration& table) {
        auto definition = std::make_unique<EditorTableDefinition>();
        definition->name = FormatTableName(table.table_name);
        definition->statement_id = table.ast_statement_id.value_or(std::numeric_limits<uint32_t>::max());
        annotations->table_definitions.push_back(std::move(definition));
    });
    std::sort(annotations->table_definitions.begin(), annotations->table_definitions.end(),
              [](const auto& left, const auto& right) { return left->name < right->name; });
    analyzed->table_references.ForEach([&](size_t, const TableReference& reference) {
        auto* relation = std::get_if<TableReference::RelationExpression>(&reference.inner);
        if (relation == nullptr) return;
        annotations->referenced_table_names.emplace_back(relation->table_name.table_name.get().text);
    });
    std::sort(annotations->referenced_table_names.begin(), annotations->referenced_table_names.end());
    annotations->referenced_table_names.erase(
        std::unique(annotations->referenced_table_names.begin(), annotations->referenced_table_names.end()),
        annotations->referenced_table_names.end());
    annotations->has_visualization_compilation = !analyzed->visualization_specs.IsEmpty();
    auto descriptions = parsed->AssociateDescriptions();
    for (size_t statement_id = 0; statement_id < parsed->statements.size(); ++statement_id) {
        const auto& statement = parsed->statements[statement_id];
        const auto& metadata = descriptions[statement_id];
        auto projected_span = ProjectTextSpan(metadata.statement_span);
        if (!projected_span) continue;
        auto projected_statement = std::make_unique<EditorStatement>();
        projected_statement->statement_id = static_cast<uint32_t>(statement_id);
        projected_statement->statement_type = statement.type;
        projected_statement->text_span = std::move(projected_span);
        annotations->statements.push_back(std::move(projected_statement));
        if (metadata.description_count == 0) continue;
        auto description = std::make_unique<EditorStatementDescription>();
        description->statement_id = static_cast<uint32_t>(statement_id);
        description->statement_type = statement.type;
        description->text_span = ProjectTextSpan(metadata.statement_span);
        annotations->statement_descriptions.push_back(std::move(description));
    }
    update.script_annotations = std::move(annotations);

    auto statistics = script_.GetStatistics();
    auto projected_statistics = std::make_unique<EditorProcessingStatistics>();
    if (statistics->timings) {
        projected_statistics->scanner_last_elapsed_ns = statistics->timings->scanner_last_elapsed();
        projected_statistics->parser_last_elapsed_ns = statistics->timings->parser_last_elapsed();
        projected_statistics->analyzer_last_elapsed_ns = statistics->timings->analyzer_last_elapsed();
    }
    if (statistics->memory) {
        projected_statistics->rope_bytes = statistics->memory->rope_bytes();
        auto& latest = statistics->memory->latest_script();
        projected_statistics->scanner_input_bytes = latest.scanner_input_bytes();
        projected_statistics->scanner_symbol_bytes = latest.scanner_symbol_bytes();
        projected_statistics->scanner_name_dictionary_bytes = latest.scanner_name_dictionary_bytes();
        projected_statistics->parser_ast_bytes = latest.parser_ast_bytes();
        projected_statistics->analyzer_description_bytes = latest.analyzer_description_bytes();
        projected_statistics->analyzer_name_index_size = latest.analyzer_name_index_size();
        projected_statistics->analyzer_name_index_bytes = latest.analyzer_name_index_bytes();
    }
    update.processing_statistics = std::move(projected_statistics);
}

bool ScriptSession::IsAnalysisCurrent() const {
    const auto& analyzed = script_.GetAnalyzedScript();
    return analyzed_text_version_ == GetTextVersion() &&
           analyzed_catalog_revision_ == catalog_.GetVersion() && analyzed != nullptr &&
           analyzed->GetCatalogVersion() == catalog_.GetVersion() &&
           analyzed->parsed_script != nullptr &&
           analyzed->parsed_script == script_.GetParsedScript() &&
           analyzed->parsed_script->scanned_script != nullptr &&
           analyzed->parsed_script->scanned_script == script_.GetScannedScript() &&
           analyzed->parsed_script->scanned_script->text_version == GetTextVersion();
}

bool ScriptSession::Analyze(EditorUpdate& update) {
    if (IsAnalysisCurrent()) {
        update.analysis_available = true;
        return true;
    }

    try {
        script_.Analyze(true);
        analyzed_text_version_ = GetTextVersion();
        analyzed_catalog_revision_ = catalog_.GetVersion();
        update.analysis_updated = true;
        update.analysis_available = true;
        return true;
    } catch (const Exception& error) {
        update.status = EditorUpdateStatus::ANALYSIS_FAILED;
        update.status_message = error.what();
        update.core_status = error.GetCode();
    } catch (const std::exception& error) {
        update.status = EditorUpdateStatus::ANALYSIS_FAILED;
        update.status_message = error.what();
    }
    return false;
}

ScriptSession::EditorUpdate ScriptSession::ReplaceText(TextVersion expected_text_version, std::string_view text) {
    EditorEvent event;
    event.expected_text_version = expected_text_version;
    event.origin = buffers::editor::EditorEventOrigin::SYSTEM;
    event.intent = buffers::editor::EditorEventIntent::REPLACE;
    event.action = buffers::editor::EditorEventAction::APPLY;
    auto change = std::make_unique<buffers::editor::EditorTextChangeT>();
    change->from = 0;
    change->to = offset_unit_ == buffers::editor::EditorOffsetUnit::UTF16_CODE_UNITS
                     ? script_.text.GetStats().utf16_code_units
                     : script_.text.GetStats().text_bytes;
    change->insert = text;
    event.changes.push_back(std::move(change));
    return Apply(event);
}

ScriptSession::EditorUpdate ScriptSession::SetPrimaryCursor(TextVersion expected_text_version, uint64_t offset) {
    EditorEvent event;
    event.expected_text_version = expected_text_version;
    event.origin = buffers::editor::EditorEventOrigin::USER;
    event.intent = buffers::editor::EditorEventIntent::SELECTION;
    event.primary_selection = std::make_unique<EditorSelection>();
    event.primary_selection->anchor = offset;
    event.primary_selection->head = offset;
    return Apply(event);
}

std::string ScriptSession::RewriteDashboard(std::optional<int32_t> row, std::optional<int32_t> column, int32_t width,
                                            int32_t height, bool parse_if_outdated) {
    return script_.RewriteDashboard(row, column, width, height, parse_if_outdated);
}

flatbuffers::Offset<buffers::completion::Completion> ScriptSession::PackCompletion(
    flatbuffers::FlatBufferBuilder& builder, size_t limit, buffers::formatting::KeywordCase keyword_case) {
    auto completion = script_.CompleteAtCursor(limit);
    if (offset_unit_ == buffers::editor::EditorOffsetUnit::UTF8_BYTES) {
        return completion->Pack(builder, keyword_case);
    }

    flatbuffers::FlatBufferBuilder utf8_builder;
    utf8_builder.Finish(completion->Pack(utf8_builder, keyword_case));
    auto projected = std::unique_ptr<buffers::completion::CompletionT>{
        flatbuffers::GetRoot<buffers::completion::Completion>(utf8_builder.GetBufferPointer())->UnPack()};
    projected->cursor_offset = ProjectByteOffset(projected->cursor_offset);
    for (auto& candidate : projected->candidates) {
        if (candidate->target_location) {
            auto span = ProjectTextSpan(buffers::parser::TextSpan{candidate->target_location->offset(),
                                                                  candidate->target_location->length()});
            candidate->target_location = span
                ? std::make_unique<buffers::parser::SymbolSpan>(span->offset(), span->length())
                : nullptr;
        }
        if (candidate->target_location_qualified) {
            auto span = ProjectTextSpan(buffers::parser::TextSpan{candidate->target_location_qualified->offset(),
                                                                  candidate->target_location_qualified->length()});
            candidate->target_location_qualified = span
                ? std::make_unique<buffers::parser::SymbolSpan>(span->offset(), span->length())
                : nullptr;
        }
        rope::Rope completion_text{1024, candidate->completion_text};
        auto cursor = completion_text.ResolveByteBoundary(candidate->completion_cursor_offset);
        if (!cursor) throw std::logic_error("completion cursor is not on a UTF-8 codepoint boundary");
        candidate->completion_cursor_offset = static_cast<uint32_t>(cursor->utf16_code_units);
    }
    return buffers::completion::Completion::Pack(builder, projected.get());
}

ScriptCompilationResult ScriptSession::CompileQuery(const buffers::formatting::FormattingConfigT& config,
                                                    bool allow_extensions, bool parse_if_outdated) {
    return ScriptCompiler::Compile(
        script_, config, {.allow_extensions = allow_extensions, .parse_if_outdated = parse_if_outdated});
}

std::unique_ptr<Script> ScriptSession::Format(const buffers::formatting::FormattingConfigT& config,
                                              bool parse_if_outdated, Catalog* catalog) {
    auto text = script_.Format(config, parse_if_outdated);
    auto result = std::make_unique<Script>(catalog != nullptr ? *catalog : catalog_);
    result->ReplaceText(text);
    return result;
}

bool ScriptSession::IsFullyFormattable(const buffers::formatting::FormattingConfigT& config, bool parse_if_outdated) {
    return script_.IsFullyFormattable(config, parse_if_outdated);
}

flatbuffers::Offset<buffers::diff::ScriptDiff> ScriptSession::PackDiff(flatbuffers::FlatBufferBuilder& builder,
                                                                       Script& target) {
    if (script_.GetParsedScript() == nullptr || target.GetParsedScript() == nullptr) {
        throw Exception(buffers::status::StatusCode::SCRIPT_NOT_PARSED);
    }
    ScriptDiff diff{*script_.GetParsedScript(), *target.GetParsedScript()};
    if (offset_unit_ == buffers::editor::EditorOffsetUnit::UTF8_BYTES) {
        return diff.Pack(builder);
    }

    flatbuffers::FlatBufferBuilder utf8_builder;
    utf8_builder.Finish(diff.Pack(utf8_builder));
    auto projected = std::unique_ptr<buffers::diff::ScriptDiffT>{
        flatbuffers::GetRoot<buffers::diff::ScriptDiff>(utf8_builder.GetBufferPointer())->UnPack()};
    auto project = [&](std::unique_ptr<buffers::parser::TextSpan>& span) {
        if (!span) return;
        const auto begin = ProjectByteOffset(span->offset());
        const auto end = ProjectByteOffset(static_cast<uint64_t>(span->offset()) + span->length());
        span = std::make_unique<buffers::parser::TextSpan>(begin, end - begin);
    };
    for (auto& op : projected->ops) {
        project(op->source_span);
        if (op->target_span) {
            auto begin = target.text.ResolveByteBoundary(op->target_span->offset());
            auto end = target.text.ResolveByteBoundary(op->target_span->offset() + op->target_span->length());
            if (!begin || !end) throw std::logic_error("diff span is not on a UTF-8 codepoint boundary");
            op->target_span = std::make_unique<buffers::parser::TextSpan>(
                begin->utf16_code_units, end->utf16_code_units - begin->utf16_code_units);
        }
        for (auto& change : op->target_changes) {
            auto begin = target.text.ResolveByteBoundary(change.offset());
            auto end = target.text.ResolveByteBoundary(change.offset() + change.length());
            if (!begin || !end) throw std::logic_error("diff change is not on a UTF-8 codepoint boundary");
            change = buffers::parser::TextSpan(begin->utf16_code_units,
                                               end->utf16_code_units - begin->utf16_code_units);
        }
    }
    return buffers::diff::ScriptDiff::Pack(builder, projected.get());
}

void ScriptSession::LoadIntoCatalog(CatalogEntry::Rank rank) {
    catalog_.LoadScript(script_, rank);
    // Publishing advances the catalog generation. The analyzed snapshot still needs a refresh
    // against that generation before it can be used by the planner.
    analyzed_catalog_revision_ = catalog_.GetVersion();
    cursor_catalog_revision_ = catalog_.GetVersion();
}

void ScriptSession::DropFromCatalog() { catalog_.DropScript(script_); }

ScriptSession::EditorUpdate ScriptSession::Analyze() {
    auto update = MakeUpdate();
    if (Analyze(update)) {
        const bool cursor_outdated =
            update.analysis_updated || script_.cursor == nullptr || cursor_text_version_ != GetTextVersion() ||
            cursor_catalog_revision_ != catalog_.GetVersion();
        if (primary_selection_ && cursor_outdated) {
            auto cursor = ResolveOffset(script_.text, primary_selection_->head);
            if (cursor) script_.MoveCursor(cursor->text_bytes);
            cursor_text_version_ = GetTextVersion();
            cursor_catalog_revision_ = catalog_.GetVersion();
        }
        if (update.analysis_updated) {
            ++state_revision_;
        }
    }
    update.text_version = GetTextVersion();
    update.state_revision = state_revision_;
    update.catalog_revision = catalog_.GetVersion();
    return FinalizeUpdate(std::move(update));
}

ScriptSession::EditorUpdate ScriptSession::Apply(const EditorEvent& event) {
    auto update = MakeUpdate();
    update.origin = event.origin;
    update.intent = event.intent;
    update.action = event.action;
    if (event.expected_text_version != GetTextVersion()) {
        update.status = EditorUpdateStatus::STALE_TEXT_VERSION;
        update.status_message = "editor event targets a stale text version";
        return FinalizeUpdate(std::move(update));
    }

    auto current_text = script_.ToString();
    const auto document_end = offset_unit_ == buffers::editor::EditorOffsetUnit::UTF16_CODE_UNITS
                                  ? script_.text.GetStats().utf16_code_units
                                  : script_.text.GetStats().text_bytes;
    std::vector<PreparedChange> changes;
    changes.reserve(event.changes.size());
    for (size_t i = 0; i < event.changes.size(); ++i) {
        const auto& change = event.changes[i];
        if (!change) {
            update.status = EditorUpdateStatus::INVALID_EVENT;
            update.status_message = "editor event contains a null text change";
            return FinalizeUpdate(std::move(update));
        }
        if (!utf8::Utf8Proc::IsValid(change->insert)) {
            update.status = EditorUpdateStatus::INVALID_UTF8;
            update.status_message = "inserted text is not valid UTF-8";
            return FinalizeUpdate(std::move(update));
        }
        const bool insert_past_end = change->from == change->to && change->from > document_end;
        const auto from_offset = insert_past_end ? document_end : change->from;
        const auto to_offset = insert_past_end ? document_end : change->to;
        auto from = ResolveOffset(script_.text, from_offset);
        auto to = ResolveOffset(script_.text, to_offset);
        if (change->from > change->to || !from || !to) {
            update.status = EditorUpdateStatus::INVALID_RANGE;
            update.status_message = "text change range is not on codepoint boundaries in the session offset unit";
            return FinalizeUpdate(std::move(update));
        }
        changes.push_back({
            .from_byte = from->text_bytes,
            .to_byte = to->text_bytes,
            .from_codepoint = from->utf8_codepoints,
            .to_codepoint = to->utf8_codepoints,
            .insert = change->insert,
            .input_order = i,
        });
    }
    std::stable_sort(changes.begin(), changes.end(), [](const PreparedChange& left, const PreparedChange& right) {
        if (left.from_byte != right.from_byte) return left.from_byte < right.from_byte;
        if (left.to_byte != right.to_byte) return left.to_byte < right.to_byte;
        return left.input_order < right.input_order;
    });
    for (size_t i = 1; i < changes.size(); ++i) {
        if (changes[i].from_byte < changes[i - 1].to_byte) {
            update.status = EditorUpdateStatus::OVERLAPPING_CHANGES;
            update.status_message = "text changes overlap in the pre-change document";
            return FinalizeUpdate(std::move(update));
        }
    }

    std::optional<rope::Rope> edited_text;
    if (!changes.empty()) {
        try {
            edited_text.emplace(1024, current_text);
            for (auto iter = changes.rbegin(); iter != changes.rend(); ++iter) {
                edited_text->Remove(iter->from_codepoint, iter->to_codepoint - iter->from_codepoint);
                edited_text->Insert(iter->from_codepoint, iter->insert);
            }
        } catch (const std::exception& error) {
            update.status = EditorUpdateStatus::INVALID_UTF8;
            update.status_message = error.what();
            return FinalizeUpdate(std::move(update));
        }
    }
    const rope::Rope& next_rope = edited_text ? *edited_text : script_.text;
    std::string next_text = edited_text ? edited_text->ToString() : current_text;

    std::optional<EditorSelection> next_selection = primary_selection_;
    if (event.primary_selection) {
        if (!utf8::Utf8Proc::IsValid(next_text)) {
            update.status = EditorUpdateStatus::INVALID_UTF8;
            update.status_message = "updated document is not valid UTF-8";
            return FinalizeUpdate(std::move(update));
        }
        if (!ResolveOffset(next_rope, event.primary_selection->anchor) ||
            !ResolveOffset(next_rope, event.primary_selection->head)) {
            update.status = EditorUpdateStatus::INVALID_RANGE;
            update.status_message = "primary selection is not on codepoint boundaries in the session offset unit";
            return FinalizeUpdate(std::move(update));
        }
        next_selection = *event.primary_selection;
    } else if (next_text != current_text && next_selection) {
        if (!ResolveOffset(next_rope, next_selection->anchor) || !ResolveOffset(next_rope, next_selection->head)) {
            next_selection.reset();
        }
    }

    update.text_changed = next_text != current_text;
    update.selection_changed = !SelectionsEqual(primary_selection_, next_selection);
    if (update.text_changed) {
        // Never leave a catalog entry pointing at the previous analyzed snapshot while this script
        // is being replaced and reanalyzed.
        catalog_.DropScript(script_);
        script_.ReplaceText(next_text);
        script_.cursor.reset();
        cursor_text_version_ = std::numeric_limits<TextVersion>::max();
        cursor_catalog_revision_ = std::numeric_limits<uint64_t>::max();
    }
    primary_selection_ = std::move(next_selection);

    const bool analysis_stale = !IsAnalysisCurrent();
    // Selection updates also publish a complete EditorUpdate projection. Refresh stale analysis first;
    // otherwise a catalog revision change would turn a cursor move into an empty projection.
    const bool analysis_succeeded = !(event.analyze || (event.primary_selection && analysis_stale)) || Analyze(update);
    const bool analysis_current = IsAnalysisCurrent();
    const bool cursor_outdated = event.primary_selection != nullptr || update.text_changed || update.analysis_updated ||
                                 script_.cursor == nullptr ||
                                 cursor_text_version_ != GetTextVersion() ||
                                 cursor_catalog_revision_ != catalog_.GetVersion();
    if (analysis_succeeded && analysis_current && primary_selection_ && cursor_outdated) {
        auto cursor = ResolveOffset(script_.text, primary_selection_->head);
        if (cursor) {
            script_.MoveCursor(cursor->text_bytes);
            cursor_text_version_ = GetTextVersion();
            cursor_catalog_revision_ = catalog_.GetVersion();
        }
    } else if (analysis_succeeded && analysis_current && !primary_selection_) {
        script_.cursor.reset();
        cursor_text_version_ = std::numeric_limits<TextVersion>::max();
        cursor_catalog_revision_ = std::numeric_limits<uint64_t>::max();
    }
    if (update.text_changed || update.selection_changed || update.analysis_updated) {
        ++state_revision_;
    }

    update.text_version = GetTextVersion();
    update.state_revision = state_revision_;
    update.catalog_revision = catalog_.GetVersion();
    update.analysis_available = IsAnalysisCurrent();
    if (primary_selection_) {
        update.primary_selection = std::make_unique<EditorSelection>(*primary_selection_);
    } else {
        update.primary_selection.reset();
    }
    return FinalizeUpdate(std::move(update));
}

}  // namespace dashql
