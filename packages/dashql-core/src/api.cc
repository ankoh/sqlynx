#include "dashql/api.h"

#include <flatbuffers/buffer.h>
#include <flatbuffers/detached_buffer.h>
#include <flatbuffers/flatbuffer_builder.h>
#include <flatbuffers/verifier.h>

#include <stdexcept>

#include "dashql/analyzer/completion.h"
#include "dashql/buffers/index_generated.h"
#include "dashql/catalog.h"
#include "dashql/batch.h"
#include "dashql/catalog_object.h"
#include "dashql/exception.h"
#include "dashql/planner.h"
#include "dashql/script_session.h"
#include "dashql/script_diff.h"
#include "dashql/script.h"
#include "dashql/script_compiler.h"
#include "dashql/script_execution.h"
#include "dashql/view/plan_view_model.h"
#include "dashql/visualize/vegalite.h"
#include "rapidjson/document.h"

using namespace dashql;
using namespace dashql::parser;

/// Log to console
#ifdef WASM
__attribute__((__import_module__("env"), __import_name__("log"))) extern void log(const char* text, size_t textLength);
#else
extern void log(const char* text, size_t textLength) { std::cout << std::string_view{text, textLength} << std::endl; }
#endif

namespace console {
/// Log a std::string
void log(std::string text) { return ::log(text.data(), text.size()); }
/// Log a string_view
void log(std::string_view text) { return ::log(text.data(), text.size()); }
}  // namespace console

template <typename T> static void packPtr(FFIResult* result, std::unique_ptr<T> ptr) {
    auto raw_ptr = ptr.release();
    result->data_ptr = nullptr;
    result->data_length = 0;
    result->owner_ptr = raw_ptr;
    result->owner_deleter = [](void* p) { delete reinterpret_cast<T*>(p); };
}

static void packBuffer(FFIResult* result, std::unique_ptr<flatbuffers::DetachedBuffer> detached) {
    result->data_ptr = detached->data();
    result->data_length = detached->size();
    result->owner_ptr = detached.release();
    result->owner_deleter = [](void* buffer) { delete reinterpret_cast<flatbuffers::DetachedBuffer*>(buffer); };
}

static buffers::formatting::FormattingConfigT makeFormattingConfig(size_t dialect, size_t mode, size_t max_width,
                                                                   size_t indentation_width, bool debug_mode = false) {
    buffers::formatting::FormattingConfigT config;
    config.dialect = static_cast<buffers::formatting::FormattingDialect>(dialect);
    config.mode = static_cast<buffers::formatting::FormattingMode>(mode);
    config.max_width = max_width;
    config.indentation_width = indentation_width;
    config.debug_mode = debug_mode;
    return config;
}

template <typename Pack> static void packFlatBuffer(FFIResult* result, Pack&& pack) {
    flatbuffers::FlatBufferBuilder builder;
    pack(builder);
    packBuffer(result, std::make_unique<flatbuffers::DetachedBuffer>(builder.Release()));
}

static void packEditorUpdate(FFIResult* result, const buffers::editor::EditorUpdateT& update) {
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(buffers::editor::EditorUpdate::Pack(fb, &update));
    packBuffer(result, std::make_unique<flatbuffers::DetachedBuffer>(fb.Release()));
}

static void packScriptExecutionUpdate(FFIResult* result,
                                      const buffers::execution::ScriptExecutionUpdateT& update) {
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(buffers::execution::ScriptExecutionUpdate::Pack(fb, &update));
    packBuffer(result, std::make_unique<flatbuffers::DetachedBuffer>(fb.Release()));
}

static void packInvalidEditorEvent(FFIResult* result, const ScriptSession& session) {
    auto update = buffers::editor::EditorUpdateT{};
    update.status = buffers::editor::EditorUpdateStatus::INVALID_EVENT;
    update.status_message = "invalid EditorEvent FlatBuffer";
    update.offset_unit = session.GetOffsetUnit();
    update.catalog_entry_id = session.GetCatalogEntryId();
    update.text_version = session.GetTextVersion();
    update.state_revision = session.GetStateRevision();
    update.catalog_revision = session.GetCatalogRevision();
    packEditorUpdate(result, update);
}

static void packUInt32Vector(FFIResult* result, std::unique_ptr<std::vector<uint32_t>> values) {
    result->data_ptr = values->data();
    result->data_length = values->size() * sizeof(uint32_t);
    result->owner_ptr = values.release();
    result->owner_deleter = [](void* data) { delete reinterpret_cast<std::vector<uint32_t>*>(data); };
}

/// Allocate memory
extern "C" std::byte* dashql_malloc(size_t length) { return new std::byte[length]; }
/// Delete memory
extern "C" void dashql_free(const void* buffer) { delete[] reinterpret_cast<const std::byte*>(buffer); }

/// Delete an owner by calling its deleter (for stack-allocated FFIResult)
extern "C" void dashql_delete_owner(void* owner_ptr, void (*owner_deleter)(void*)) {
    if (owner_deleter && owner_ptr) {
        owner_deleter(owner_ptr);
    }
}

extern "C" void dashql_planner_plan(FFIResult* result, ScriptSession* const* sessions,
                                     uint32_t session_count) noexcept {
    if (!result) return;
    *result = {};
    try {
        buffers::execution::ExecutionGraphT graph;
        try {
            if (!sessions && session_count != 0) throw std::invalid_argument("null planner session array");
            std::vector<PlannerInput> inputs;
            inputs.reserve(session_count);
            for (uint32_t i = 0; i < session_count; ++i) {
                auto* session = sessions[i];
                inputs.push_back({session ? &session->GetScript() : nullptr});
            }
            graph = Planner::Plan(inputs);
        } catch (const std::exception& error) {
            graph = {};
            graph.valid = false;
            auto diagnostic = std::make_unique<buffers::execution::ExecutionGraphDiagnosticT>();
            diagnostic->message = error.what();
            graph.diagnostics.push_back(std::move(diagnostic));
        } catch (...) {
            graph = {};
            graph.valid = false;
            auto diagnostic = std::make_unique<buffers::execution::ExecutionGraphDiagnosticT>();
            diagnostic->message = "planner failed";
            graph.diagnostics.push_back(std::move(diagnostic));
        }
        packFlatBuffer(result, [&](auto& builder) {
            builder.Finish(buffers::execution::ExecutionGraph::Pack(builder, &graph));
        });
    } catch (...) {
        // Even diagnostic serialization can fail. Never unwind across the C/Wasm boundary.
    }
}

extern "C" void dashql_script_execution_new(FFIResult* result, ScriptSession* session,
                                               size_t dialect, size_t mode, size_t max_width,
                                               size_t indentation_width, bool debug_mode) {
    if (!session) throw Exception(buffers::status::StatusCode::SCRIPT_NOT_PARSED);
    auto formatting_config = makeFormattingConfig(dialect, mode, max_width, indentation_width, debug_mode);
    packPtr(result, std::make_unique<execution::ScriptExecution>(*session, std::move(formatting_config)));
}

extern "C" void dashql_script_execution_start(FFIResult* result, execution::ScriptExecution* execution) {
    if (!execution) throw Exception(buffers::status::StatusCode::SCRIPT_NOT_PARSED);
    packScriptExecutionUpdate(result, execution->Start());
}

extern "C" void dashql_script_execution_resume(FFIResult* result, execution::ScriptExecution* execution,
                                                  const uint8_t* statement_result_ptr,
                                                  size_t statement_result_length) {
    if (!execution || !statement_result_ptr) throw Exception(buffers::status::StatusCode::SCRIPT_NOT_PARSED);
    flatbuffers::Verifier verifier{statement_result_ptr, statement_result_length};
    if (!verifier.VerifyBuffer<buffers::execution::StatementResult>(nullptr)) {
        buffers::execution::ScriptExecutionUpdateT update;
        update.protocol_error = buffers::execution::ScriptExecutionProtocolError::INVALID_ARGUMENT;
        update.protocol_error_message = "invalid StatementResult FlatBuffer";
        update.snapshot = std::make_unique<buffers::execution::ScriptExecutionSnapshotT>();
        packScriptExecutionUpdate(result, update);
        return;
    }
    auto statement_result = std::unique_ptr<buffers::execution::StatementResultT>{
        flatbuffers::GetRoot<buffers::execution::StatementResult>(statement_result_ptr)->UnPack()};
    packScriptExecutionUpdate(result, execution->Resume(*statement_result));
}

extern "C" void dashql_script_execution_cancel(FFIResult* result, execution::ScriptExecution* execution) {
    if (!execution) throw Exception(buffers::status::StatusCode::SCRIPT_NOT_PARSED);
    packScriptExecutionUpdate(result, execution->Cancel());
}

/// Create a script
extern "C" void dashql_script_new(FFIResult* result, dashql::Catalog* catalog) {
    if (!catalog) {
        throw Exception(buffers::status::StatusCode::CATALOG_NULL);
    }
    // Construct the script
    auto script = std::make_unique<Script>(*catalog);
    packPtr(result, std::move(script));
}
/// Get the catalog entry id
extern "C" uint32_t dashql_script_get_catalog_entry_id(dashql::Script* script) {
    return script->GetCatalogEntryId();
}
/// Insert char at a position
extern "C" void dashql_script_insert_char_at(Script* script, size_t offset, uint32_t unicode) {
    script->InsertCharAt(offset, unicode);
}
/// Insert text at a position
extern "C" void dashql_script_insert_text_at(Script* script, size_t offset, const char* text_ptr, size_t text_length) {
    std::unique_ptr<const char[]> text_buffer{text_ptr};
    std::string_view text{text_ptr, text_length};
    script->InsertTextAt(offset, text);
}
/// Replace text in a script
extern "C" void dashql_script_replace_text(dashql::Script* script, const char* text_ptr, size_t text_length) {
    std::unique_ptr<const char[]> text_buffer{text_ptr};
    std::string_view text{text_ptr, text_length};
    script->ReplaceText(text);
}
/// Erase a text range
extern "C" void dashql_script_erase_text_range(Script* script, size_t offset, size_t count) {
    script->EraseTextRange(offset, count);
}
/// Get the script content as string
extern "C" void dashql_script_to_string(FFIResult* result, Script* script, size_t offset, size_t length) {
    auto text = std::make_unique<std::string>(
        length == 0 ? script->ToString()
                    : script->ToString(TextSpan(static_cast<uint32_t>(offset), static_cast<uint32_t>(length))));
    result->data_ptr = text->data();
    result->data_length = text->length();
    result->owner_ptr = text.release();
    result->owner_deleter = [](void* buffer) { delete reinterpret_cast<std::string*>(buffer); };
}

/// Get the first parsed statement without its separator or surrounding trivia.
extern "C" void dashql_script_get_statement_text(FFIResult* result, Script* script, bool parse_if_outdated) {
    auto text = std::make_unique<std::string>(script->GetStatementText(parse_if_outdated));
    result->data_ptr = text->data();
    result->data_length = text->length();
    result->owner_ptr = text.release();
    result->owner_deleter = [](void* buffer) { delete reinterpret_cast<std::string*>(buffer); };
}

extern "C" void dashql_script_compile_query(FFIResult* result, Script* script, size_t dialect, size_t mode,
                                             size_t max_width, size_t indentation_width, bool allow_extensions,
                                             bool parse_if_outdated) {
    buffers::formatting::FormattingConfigT config;
    config.dialect = static_cast<buffers::formatting::FormattingDialect>(dialect);
    config.mode = static_cast<buffers::formatting::FormattingMode>(mode);
    config.max_width = max_width;
    config.indentation_width = indentation_width;
    auto compiled = ScriptCompiler::Compile(
        *script, config, {.allow_extensions = allow_extensions, .parse_if_outdated = parse_if_outdated});
    packFlatBuffer(result, [&](auto& builder) { builder.Finish(compiled.Pack(builder)); });
}

/// Scan a script
extern "C" void dashql_script_scan(Script* script) { script->Scan(); }
/// Parse a script
extern "C" void dashql_script_parse(Script* script) { script->Parse(); }
/// Analyze a script
extern "C" void dashql_script_analyze(Script* script, bool parse_if_outdated) { script->Analyze(parse_if_outdated); }
/// Format a script
extern "C" void dashql_script_format(FFIResult* result, Script* script, size_t dialect, size_t mode,
                                       size_t max_width, size_t indentation_width, bool debug_mode, size_t keyword_case,
                                      bool parse_if_outdated, Catalog* catalog) {
    buffers::formatting::FormattingConfigT config;
    config.dialect = static_cast<dashql::buffers::formatting::FormattingDialect>(dialect);
    config.mode = static_cast<dashql::buffers::formatting::FormattingMode>(mode);
    config.max_width = max_width;
    config.indentation_width = indentation_width;
    config.debug_mode = debug_mode;
    config.keyword_case = static_cast<buffers::formatting::KeywordCase>(keyword_case);

    // Format the script
    auto text = script->Format(config, parse_if_outdated);

    // Use the provided catalog, or fall back to the source script's catalog.
    // The returned Script holds a reference to the catalog, so it must outlive the Script.
    if (catalog == nullptr) {
        catalog = &script->catalog;
    }

    // Construct a new script from the text
    auto new_script = std::make_unique<Script>(*catalog);
    new_script->InsertTextAt(0, text);

    // Pack the script pointer
    packPtr(result, std::move(new_script));
}

extern "C" uint32_t dashql_script_is_fully_formattable(Script* script, size_t dialect, size_t mode, size_t max_width,
                                                            size_t indentation_width, bool debug_mode,
                                                            bool parse_if_outdated) {
    buffers::formatting::FormattingConfigT config;
    config.dialect = static_cast<dashql::buffers::formatting::FormattingDialect>(dialect);
    config.mode = static_cast<dashql::buffers::formatting::FormattingMode>(mode);
    config.max_width = max_width;
    config.indentation_width = indentation_width;
    config.debug_mode = debug_mode;
    return script->IsFullyFormattable(config, parse_if_outdated) ? 1 : 0;
}

extern "C" void dashql_script_get_unformattable_nodes(
    FFIResult* result, Script* script, size_t dialect, size_t mode, size_t max_width, size_t indentation_width,
    bool debug_mode, bool parse_if_outdated) {
    buffers::formatting::FormattingConfigT config;
    config.dialect = static_cast<dashql::buffers::formatting::FormattingDialect>(dialect);
    config.mode = static_cast<dashql::buffers::formatting::FormattingMode>(mode);
    config.max_width = max_width;
    config.indentation_width = indentation_width;
    config.debug_mode = debug_mode;
    packUInt32Vector(result, std::make_unique<std::vector<uint32_t>>(
                                 script->GetUnformattableNodes(config, parse_if_outdated)));
}

/// Get the parsed script
extern "C" void dashql_script_get_scanned(FFIResult* result, Script* script) {
    if (script->scanned_script == nullptr) {
        throw Exception(buffers::status::StatusCode::SCRIPT_NOT_ANALYZED);
    }

    // Pack a parsed script
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(script->scanned_script->Pack(fb));
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(fb.Release());
    packBuffer(result, std::move(detached));
}

/// Get the parsed script
extern "C" void dashql_script_get_parsed(FFIResult* result, Script* script) {
    if (script->parsed_script == nullptr) {
        throw Exception(buffers::status::StatusCode::SCRIPT_NOT_ANALYZED);
    }

    // Pack a parsed script
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(script->parsed_script->Pack(fb));
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(fb.Release());
    packBuffer(result, std::move(detached));
}

/// Get the analyzed script
extern "C" void dashql_script_get_analyzed(FFIResult* result, Script* script) {
    if (script->analyzed_script == nullptr) {
        throw Exception(buffers::status::StatusCode::SCRIPT_NOT_ANALYZED);
    }

    // Pack a parsed script
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(script->analyzed_script->Pack(fb));
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(fb.Release());
    packBuffer(result, std::move(detached));
}

/// Compute a statement-level semantic diff from a source (old) script to a target (new) script
extern "C" void dashql_script_compute_diff(FFIResult* result, Script* source, Script* target) {
    if (source->parsed_script == nullptr || target->parsed_script == nullptr) {
        throw Exception(buffers::status::StatusCode::SCRIPT_NOT_PARSED);
    }

    // Compute and pack the diff
    ScriptDiff diff{*source->parsed_script, *target->parsed_script};
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(diff.Pack(fb));
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(fb.Release());
    packBuffer(result, std::move(detached));
}

/// Get catalog entry id of the script
extern "C" uint32_t dashql_script_get_catalog_entry_id(dashql::Script* script);

/// Move the cursor to a script at a position
extern "C" void dashql_script_move_cursor(FFIResult* result, dashql::Script* script, size_t text_offset) {
    auto cursor = script->MoveCursor(text_offset);

    // Pack the cursor info
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(cursor->Pack(fb));

    // Store the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(fb.Release());
    packBuffer(result, std::move(detached));
}

extern "C" void dashql_script_complete_at_cursor(FFIResult* result, dashql::Script* script, size_t limit,
                                                    size_t keyword_case) {
    auto completion = script->CompleteAtCursor(limit);

    // Pack the completion
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(completion->Pack(fb, static_cast<buffers::formatting::KeywordCase>(keyword_case)));

    // Store the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(fb.Release());
    packBuffer(result, std::move(detached));
}

extern "C" void dashql_script_get_statistics(FFIResult* result, dashql::Script* script) {
    auto stats = script->GetStatistics();

    // Pack a schema graph
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(buffers::statistics::ScriptStatistics::Pack(fb, stats.get()));

    // Return the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(fb.Release());
    packBuffer(result, std::move(detached));
}

extern "C" void dashql_script_session_new(FFIResult* result, Catalog* catalog, size_t offset_unit) {
    if (!catalog) {
        throw Exception(buffers::status::StatusCode::CATALOG_NULL);
    }
    if (offset_unit > static_cast<size_t>(buffers::editor::EditorOffsetUnit::UTF16_CODE_UNITS)) {
        throw std::invalid_argument("invalid editor offset unit");
    }
    packPtr(result, std::make_unique<ScriptSession>(
                        *catalog, static_cast<buffers::editor::EditorOffsetUnit>(offset_unit)));
}

extern "C" void dashql_script_session_destroy(ScriptSession* session) { delete session; }

extern "C" uint32_t dashql_script_session_get_catalog_entry_id(ScriptSession* session) {
    return session->GetCatalogEntryId();
}

extern "C" void dashql_script_session_get_text(FFIResult* result, ScriptSession* session) {
    auto text = std::make_unique<std::string>(session->GetText());
    result->data_ptr = text->data();
    result->data_length = text->length();
    result->owner_ptr = text.release();
    result->owner_deleter = [](void* buffer) { delete reinterpret_cast<std::string*>(buffer); };
}

extern "C" uint64_t dashql_script_session_get_text_version(ScriptSession* session) {
    return session->GetTextVersion();
}

extern "C" uint64_t dashql_script_session_get_state_revision(ScriptSession* session) {
    return session->GetStateRevision();
}

extern "C" uint64_t dashql_script_session_get_catalog_revision(ScriptSession* session) {
    return session->GetCatalogRevision();
}

extern "C" void dashql_script_session_replace_text(FFIResult* result, ScriptSession* session,
                                                     uint64_t expected_text_version, const char* text_ptr,
                                                     size_t text_length) {
    std::unique_ptr<const std::byte[]> text_buffer{reinterpret_cast<const std::byte*>(text_ptr)};
    std::string_view text{text_ptr ? text_ptr : "", text_ptr ? text_length : 0};
    packEditorUpdate(result, session->ReplaceText(expected_text_version, text));
}

extern "C" void dashql_script_session_apply(FFIResult* result, ScriptSession* session,
                                              const uint8_t* event_ptr, size_t event_length) {
    if (!event_ptr) {
        packInvalidEditorEvent(result, *session);
        return;
    }
    flatbuffers::Verifier verifier{event_ptr, event_length};
    if (!verifier.VerifyBuffer<buffers::editor::EditorEvent>(nullptr)) {
        packInvalidEditorEvent(result, *session);
        return;
    }
    std::unique_ptr<buffers::editor::EditorEventT> event{
        flatbuffers::GetRoot<buffers::editor::EditorEvent>(event_ptr)->UnPack()};
    packEditorUpdate(result, session->Apply(*event));
}

extern "C" void dashql_script_session_set_primary_cursor(FFIResult* result, ScriptSession* session,
                                                           uint64_t expected_text_version, uint64_t offset) {
    packEditorUpdate(result, session->SetPrimaryCursor(expected_text_version, offset));
}

extern "C" void dashql_script_session_analyze(FFIResult* result, ScriptSession* session) {
    packEditorUpdate(result, session->Analyze());
}

extern "C" void dashql_script_session_complete_at_cursor(FFIResult* result, ScriptSession* session,
                                                              size_t limit, size_t keyword_case) {
    packFlatBuffer(result, [&](auto& builder) {
        builder.Finish(session->PackCompletion(builder, limit,
                                               static_cast<buffers::formatting::KeywordCase>(keyword_case)));
    });
}

extern "C" void dashql_script_session_compile_query(FFIResult* result, ScriptSession* session,
                                                      size_t dialect, size_t mode, size_t max_width,
                                                      size_t indentation_width, bool allow_extensions,
                                                      bool parse_if_outdated) {
    auto config = makeFormattingConfig(dialect, mode, max_width, indentation_width);
    auto compiled = session->CompileQuery(config, allow_extensions, parse_if_outdated);
    packFlatBuffer(result, [&](auto& builder) {
        builder.Finish(compiled.Pack(builder));
    });
}

extern "C" void dashql_script_session_format(FFIResult* result, ScriptSession* session, size_t dialect,
                                                size_t mode, size_t max_width, size_t indentation_width,
                                                bool debug_mode, size_t keyword_case, bool parse_if_outdated, Catalog* catalog) {
    auto config = makeFormattingConfig(dialect, mode, max_width, indentation_width, debug_mode);
    config.keyword_case = static_cast<buffers::formatting::KeywordCase>(keyword_case);
    packPtr(result, session->Format(config, parse_if_outdated, catalog));
}

extern "C" void dashql_script_session_rewrite_dashboard(FFIResult* result, ScriptSession* session, int32_t row,
                                                           int32_t column, int32_t width, int32_t height,
                                                           bool parse_if_outdated) {
    auto text = std::make_unique<std::string>(session->RewriteDashboard(
        row < 0 ? std::nullopt : std::optional<int32_t>{row},
        column < 0 ? std::nullopt : std::optional<int32_t>{column}, width, height, parse_if_outdated));
    result->data_ptr = text->data();
    result->data_length = text->size();
    result->owner_ptr = text.release();
    result->owner_deleter = [](void* ptr) { delete reinterpret_cast<std::string*>(ptr); };
}

extern "C" uint32_t dashql_script_session_is_fully_formattable(ScriptSession* session, size_t dialect,
                                                                 size_t mode, size_t max_width,
                                                                 size_t indentation_width, bool debug_mode,
                                                                 bool parse_if_outdated) {
    auto config = makeFormattingConfig(dialect, mode, max_width, indentation_width, debug_mode);
    return session->IsFullyFormattable(config, parse_if_outdated) ? 1 : 0;
}

extern "C" void dashql_script_session_compute_diff(FFIResult* result, ScriptSession* session,
                                                      Script* target) {
    packFlatBuffer(result, [&](auto& builder) { builder.Finish(session->PackDiff(builder, *target)); });
}

extern "C" void dashql_script_session_load_into_catalog(ScriptSession* session, size_t rank) {
    session->LoadIntoCatalog(static_cast<CatalogEntry::Rank>(rank));
}

extern "C" void dashql_script_session_drop_from_catalog(ScriptSession* session) {
    session->DropFromCatalog();
}

/// Create a catalog
extern "C" void dashql_catalog_new(FFIResult* result) { packPtr(result, std::make_unique<dashql::Catalog>()); }
extern "C" void dashql_process_batch(FFIResult* result, const uint8_t* request_ptr, size_t request_length) {
    if (!request_ptr) throw std::invalid_argument("null BatchRequest buffer");
    packBuffer(result, std::make_unique<flatbuffers::DetachedBuffer>(ProcessBatch({request_ptr, request_length})));
}
extern "C" uint32_t dashql_catalog_allocate_entry_id(dashql::Catalog* catalog) {
    if (!catalog) throw Exception(buffers::status::StatusCode::CATALOG_NULL);
    return catalog->AllocateEntryId();
}
extern "C" void dashql_catalog_replace_descriptor(dashql::Catalog* catalog, uint32_t id, uint32_t rank,
                                                  const uint8_t* descriptor_ptr, uint32_t descriptor_length) {
    if (!catalog) throw Exception(buffers::status::StatusCode::CATALOG_NULL);
    if (!descriptor_ptr) throw std::invalid_argument("null CatalogDescriptor buffer");
    catalog->ReplaceDescriptor(id, rank, {descriptor_ptr, descriptor_length});
}
extern "C" void dashql_catalog_drop_descriptor(dashql::Catalog* catalog, uint32_t entry_id) {
    if (!catalog) throw Exception(buffers::status::StatusCode::CATALOG_NULL);
    catalog->DropDescriptor(entry_id);
}
/// Clear a catalog
extern "C" void dashql_catalog_clear(dashql::Catalog* catalog) { catalog->Clear(); }
/// Get script id
extern "C" bool dashql_catalog_contains_entry_id(dashql::Catalog* catalog, uint32_t entry_id) {
    return catalog->Contains(entry_id);
}
/// Describe all entries
extern "C" void dashql_catalog_describe_entries(FFIResult* result, dashql::Catalog* catalog) {
    flatbuffers::FlatBufferBuilder fb;
    auto entries = catalog->DescribeEntries(fb);
    fb.Finish(entries);

    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(fb.Release());
    packBuffer(result, std::move(detached));
}
/// Describe all entries
extern "C" void dashql_catalog_describe_entries_of(FFIResult* result, dashql::Catalog* catalog, size_t entry_id) {
    flatbuffers::FlatBufferBuilder fb;
    auto entries = catalog->DescribeEntriesOf(fb, entry_id);
    fb.Finish(entries);

    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(fb.Release());
    packBuffer(result, std::move(detached));
}
/// Flatten the catalog
extern "C" void dashql_catalog_flatten(FFIResult* result, dashql::Catalog* catalog) {
    flatbuffers::FlatBufferBuilder fb;
    auto entries = catalog->Flatten(fb);
    fb.Finish(entries);

    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(fb.Release());
    packBuffer(result, std::move(detached));
}
/// Add a script in the catalog
extern "C" void dashql_catalog_load_script(dashql::Catalog* catalog, dashql::Script* script, size_t rank) {
    catalog->LoadScript(*script, rank);
}
extern "C" void dashql_catalog_load_scripts(dashql::Catalog* catalog, dashql::Script* const* scripts,
                                              const uint32_t* ranks, uint32_t script_count) {
    std::vector<dashql::Catalog::ScriptBatchEntry> batch;
    batch.reserve(script_count);
    for (uint32_t i = 0; i < script_count; ++i) {
        batch.push_back({scripts[i], ranks[i]});
    }
    catalog->LoadScripts(batch);
}
/// Drop entry in the catalog
extern "C" void dashql_catalog_drop_script(dashql::Catalog* catalog, dashql::Script* script) {
    catalog->DropScript(*script);
}

extern "C" void dashql_catalog_get_statistics(FFIResult* result, dashql::Catalog* catalog) {
    auto stats = catalog->GetStatistics();

    // Pack the catalog statistics
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(buffers::catalog::CatalogStatistics::Pack(fb, stats.get()));

    // Return the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(fb.Release());
    packBuffer(result, std::move(detached));
}

/// Transcode a (constrained) Vega-Lite JSON spec into a VISUALIZE statement
extern "C" void dashql_parse_vegalite_to_visualize(FFIResult* result, const char* json_ptr, size_t json_length) {
    std::unique_ptr<const char[]> json_buffer{json_ptr};
    std::string json = (json_ptr && json_length > 0) ? std::string(json_ptr, json_length) : std::string{};
    auto text = std::make_unique<std::string>(visualize::ParseVegaLiteToVisualize(json));
    result->data_ptr = text->data();
    result->data_length = text->length();
    result->owner_ptr = text.release();
    result->owner_deleter = [](void* buffer) { delete reinterpret_cast<std::string*>(buffer); };
}

/// Create a plan view model
extern "C" void dashql_plan_view_model_new(FFIResult* result) {
    packPtr(result, std::make_unique<dashql::PlanViewModel>());
}
/// Configure a plan view model
extern "C" void dashql_plan_view_model_configure(dashql::PlanViewModel* view_model, double level_height,
                                                 double node_height, double node_margin_horizontal,
                                                 double node_padding_left, double node_padding_right, double icon_width,
                                                 double icon_margin_right, uint32_t max_label_chars,
                                                 double width_per_label_char, double node_min_width) {
    buffers::view::PlanLayoutConfig config;
    config.mutate_level_height(level_height);
    config.mutate_node_height(node_height);
    config.mutate_node_margin_horizontal(node_margin_horizontal);
    config.mutate_node_padding_left(node_padding_left);
    config.mutate_node_padding_right(node_padding_right);
    config.mutate_icon_width(icon_width);
    config.mutate_icon_margin_right(icon_margin_right);
    config.mutate_max_label_chars(max_label_chars);
    config.mutate_width_per_label_char(width_per_label_char);
    config.mutate_node_min_width(node_min_width);
    view_model->Configure(config);
}
/// Load a Hyper plan view model
extern "C" void dashql_plan_view_model_load_hyper_plan(dashql::PlanViewModel* view_model, char* text_ptr,
                                                       size_t text_length) {
    // We're the owner of the text buffer now
    std::unique_ptr<char[]> input_buffer{static_cast<char*>(text_ptr)};
    std::string_view input_view{text_ptr, text_length};

    // Parse the Hyper plan
    view_model->ParseHyperPlan(input_view, std::move(input_buffer));

    // Compute the initial view layout
    view_model->ComputeLayout();
}

/// Reset the plan view model
extern "C" void dashql_plan_view_model_reset(dashql::PlanViewModel* view_model) { view_model->Reset(); }
/// Reset the plan view model execution
extern "C" void dashql_plan_view_model_reset_execution(dashql::PlanViewModel* view_model) {
    view_model->ResetExecution();
}
/// Reset the plan view model
extern "C" void dashql_plan_view_model_pack(FFIResult* result, dashql::PlanViewModel* view_model) {
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(view_model->Pack(fb));
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(fb.Release());
    packBuffer(result, std::move(detached));
}
