#include "sqlynx/api.h"

#include <flatbuffers/detached_buffer.h>
#include <flatbuffers/flatbuffer_builder.h>

#include <span>

#include "flatbuffers/flatbuffers.h"
#include "sqlynx/analyzer/completion.h"
#include "sqlynx/parser/parser.h"
#include "sqlynx/parser/scanner.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/schema.h"
#include "sqlynx/script.h"
#include "sqlynx/text/rope.h"
#include "sqlynx/version.h"
#include "sqlynx/vis/schema_grid.h"

using namespace sqlynx;
using namespace sqlynx::parser;

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

/// Get the SQLynx version
extern "C" SQLynxVersion* sqlynx_version() { return &sqlynx::VERSION; }

/// Allocate memory
extern "C" std::byte* sqlynx_malloc(size_t length) { return new std::byte[length]; }
/// Delete memory
extern "C" void sqlynx_free(void* buffer) { delete[] reinterpret_cast<std::byte*>(buffer); }

/// Delete a result
extern "C" void sqlynx_result_delete(FFIResult* result) {
    result->owner_deleter(result->owner_ptr);
    result->owner_ptr = nullptr;
    result->owner_deleter = nullptr;
    delete result;
}

/// Create a schema search path
extern "C" sqlynx::SchemaSearchPath* sqlynx_search_path_new() { return new sqlynx::SchemaSearchPath(); }
/// Create a schema search path
extern "C" void sqlynx_search_path_delete(sqlynx::SchemaSearchPath* search_path) { delete search_path; }
/// Erase entry in the schema search path
extern "C" void sqlynx_search_path_erase_at(sqlynx::SchemaSearchPath* path, size_t index) { path->Erase(index); }
/// Insert a script in the schema search path
extern "C" void sqlynx_search_path_insert_script_at(sqlynx::SchemaSearchPath* path, size_t index,
                                                    sqlynx::Script* script) {
    path->InsertScript(index, *script);
}
/// Update a script in the schema search path
extern "C" void sqlynx_search_path_update_script(sqlynx::SchemaSearchPath* path, sqlynx::Script* script) {
    path->UpdateScript(*script);
}

/// Create a script
extern "C" Script* sqlynx_script_new(uint32_t context_id) { return new Script(context_id); }
/// Delete a script
extern "C" void sqlynx_script_delete(Script* script) { delete script; }
/// Insert char at a position
extern "C" void sqlynx_script_insert_char_at(Script* script, size_t offset, uint32_t unicode) {
    script->InsertCharAt(offset, unicode);
}
/// Insert text at a position
extern "C" void sqlynx_script_insert_text_at(Script* script, size_t offset, const char* text_ptr, size_t text_length) {
    std::string_view text{text_ptr, text_length};
    script->InsertTextAt(offset, text);
}
/// Erase a text range
extern "C" void sqlynx_script_erase_text_range(Script* script, size_t offset, size_t count) {
    script->EraseTextRange(offset, count);
}
/// Get the script content as string
extern "C" FFIResult* sqlynx_script_to_string(Script* script) {
    auto text = std::make_unique<std::string>(std::move(script->ToString()));
    auto result = new FFIResult();
    result->status_code = static_cast<uint32_t>(proto::StatusCode::OK);
    result->data_ptr = text->data();
    result->data_length = text->length();
    result->owner_ptr = text.release();
    result->owner_deleter = [](void* buffer) { delete reinterpret_cast<std::string*>(buffer); };
    return result;
}

static FFIResult* packError(proto::StatusCode status) {
    std::string_view message;
    switch (status) {
        case proto::StatusCode::PARSER_INPUT_INVALID:
            message = "Parser input is invalid";
            break;
        case proto::StatusCode::ANALYZER_INPUT_INVALID:
            message = "Analyzer input is invalid";
            break;
        case proto::StatusCode::GRAPH_INPUT_INVALID:
            message = "Graph input is invalid";
            break;
        case proto::StatusCode::COMPLETION_MISSES_CURSOR:
            message = "Completion requires a script cursor";
            break;
        case proto::StatusCode::COMPLETION_MISSES_SCANNER_TOKEN:
            message = "Completion requires a scanner token";
            break;
        case proto::StatusCode::EXTERNAL_CONTEXT_COLLISION:
            message = "Collision on external context identifier";
            break;
        case proto::StatusCode::OK:
            message = "";
            break;
    }
    auto result = new FFIResult();
    result->status_code = static_cast<uint32_t>(status);
    result->data_ptr = static_cast<const void*>(message.data());
    result->data_length = message.size();
    result->owner_ptr = nullptr;
    result->owner_deleter = [](void*) {};
    return result;
}

static FFIResult* packBuffer(std::unique_ptr<flatbuffers::DetachedBuffer> detached) {
    auto result = new FFIResult();
    result->status_code = static_cast<uint32_t>(proto::StatusCode::OK);
    result->data_ptr = detached->data();
    result->data_length = detached->size();
    result->owner_ptr = detached.release();
    result->owner_deleter = [](void* buffer) { delete reinterpret_cast<flatbuffers::DetachedBuffer*>(buffer); };
    return result;
}

/// Scan a script
extern "C" FFIResult* sqlynx_script_scan(Script* script) {
    // Scan the script
    auto [scanned, status] = script->Scan();
    if (status != proto::StatusCode::OK) {
        return packError(status);
    }

    // Pack a parsed script
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(scanned->Pack(fb));

    // Return the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(std::move(fb.Release()));
    return packBuffer(std::move(detached));
}

/// Parse a script
extern "C" FFIResult* sqlynx_script_parse(Script* script) {
    // Parse the script
    auto [parsed, status] = script->Parse();
    if (status != proto::StatusCode::OK) {
        return packError(status);
    }

    // Pack a parsed script
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(parsed->Pack(fb));

    // Return the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(std::move(fb.Release()));
    return packBuffer(std::move(detached));
}

/// Analyze a script
extern "C" FFIResult* sqlynx_script_analyze(Script* script, const SchemaSearchPath* search_path) {
    // Analyze the script
    auto [analyzed, status] = script->Analyze(search_path);
    if (status != proto::StatusCode::OK) {
        return packError(status);
    }

    // Pack a parsed script
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(analyzed->Pack(fb));

    // Return the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(std::move(fb.Release()));
    return packBuffer(std::move(detached));
}

/// Get a pretty-printed version of the SQL query
extern "C" FFIResult* sqlynx_script_format(sqlynx::Script* script) {
    auto text = std::make_unique<std::string>(script->Format());
    auto result = new FFIResult();
    result->status_code = static_cast<uint32_t>(proto::StatusCode::OK);
    result->data_ptr = text->data();
    result->data_length = text->length();
    result->owner_ptr = text.release();
    result->owner_deleter = [](void* buffer) { delete reinterpret_cast<std::string*>(buffer); };
    return result;
}

/// Move the cursor to a script at a position
extern "C" FFIResult* sqlynx_script_move_cursor(sqlynx::Script* script, size_t text_offset) {
    auto [cursor, status] = script->MoveCursor(text_offset);
    if (status != proto::StatusCode::OK) {
        return packError(status);
    }

    // Pack the cursor info
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(cursor->Pack(fb));

    // Store the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(std::move(fb.Release()));
    return packBuffer(std::move(detached));
}

extern "C" FFIResult* sqlynx_script_complete_at_cursor(sqlynx::Script* script, size_t limit) {
    auto [completion, status] = script->CompleteAtCursor(limit);
    if (status != proto::StatusCode::OK) {
        return packError(status);
    }

    // Pack the completion
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(completion->Pack(fb));

    // Store the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(std::move(fb.Release()));
    return packBuffer(std::move(detached));
}

extern "C" FFIResult* sqlynx_script_get_statistics(sqlynx::Script* script) {
    auto stats = script->GetStatistics();

    // Pack a schema graph
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(proto::ScriptStatistics::Pack(fb, stats.get()));

    // Return the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(std::move(fb.Release()));
    return packBuffer(std::move(detached));
}

/// Create a schema graph
extern "C" sqlynx::SchemaGrid* sqlynx_schemagraph_new() { return new sqlynx::SchemaGrid(); }
/// Delete a schema graph
extern "C" void sqlynx_schemagraph_delete(sqlynx::SchemaGrid* graph) { delete graph; }
/// Configure a schema graph
extern "C" void sqlynx_schemagraph_configure(sqlynx::SchemaGrid* graph, double board_width, double board_height,
                                             double cell_width, double cell_height, double table_width,
                                             double table_height) {
    SchemaGrid::Config config;
    config.board_width = board_width;
    config.board_height = board_height;
    config.cell_width = cell_width;
    config.cell_height = cell_height;
    config.table_width = table_width;
    config.table_height = table_height;
    graph->Configure(config);
}
/// Update a schema graph
extern "C" FFIResult* sqlynx_schemagraph_load_script(sqlynx::SchemaGrid* graph, sqlynx::Script* script) {
    auto analyzed = script->analyzed_script;
    if (!analyzed) {
        return packError(proto::StatusCode::GRAPH_INPUT_INVALID);
    }
    graph->LoadScript(analyzed);

    // Pack a schema graph
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(graph->Pack(fb));

    // Store the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(std::move(fb.Release()));
    return packBuffer(std::move(detached));
}

#ifdef WASM
extern "C" int main() {
    sqlynx::CompletionIndex::Keywords();
    return 0;
}
#endif
