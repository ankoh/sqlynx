#include "flatsql/api.h"

#include <flatbuffers/detached_buffer.h>
#include <flatbuffers/flatbuffer_builder.h>

#include <span>

#include "flatbuffers/flatbuffers.h"
#include "flatsql/analyzer/completion.h"
#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/text/rope.h"
#include "flatsql/version.h"
#include "flatsql/vis/schema_graph.h"

using namespace flatsql;
using namespace flatsql::parser;

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

/// Get the FlatSQL version
extern "C" FlatSQLVersion* flatsql_version() { return &flatsql::VERSION; }

/// Allocate memory
extern "C" std::byte* flatsql_malloc(size_t length) { return new std::byte[length]; }
/// Delete memory
extern "C" void flatsql_free(void* buffer) { delete[] reinterpret_cast<std::byte*>(buffer); }

/// Delete a result
extern "C" void flatsql_result_delete(FFIResult* result) {
    result->owner_deleter(result->owner_ptr);
    result->owner_ptr = nullptr;
    result->owner_deleter = nullptr;
    delete result;
}

/// Create a script
extern "C" Script* flatsql_script_new(uint32_t context_id) { return new Script(context_id); }
/// Delete a script
extern "C" void flatsql_script_delete(Script* script) { delete script; }
/// Insert char at a position
extern "C" void flatsql_script_insert_char_at(Script* script, size_t offset, uint32_t unicode) {
    script->InsertCharAt(offset, unicode);
}
/// Insert text at a position
extern "C" void flatsql_script_insert_text_at(Script* script, size_t offset, const char* text_ptr, size_t text_length) {
    std::string_view text{text_ptr, text_length};
    script->InsertTextAt(offset, text);
}
/// Erase a text range
extern "C" void flatsql_script_erase_text_range(Script* script, size_t offset, size_t count) {
    script->EraseTextRange(offset, count);
}
/// Get the script content as string
extern "C" FFIResult* flatsql_script_to_string(Script* script) {
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
        case proto::StatusCode::COMPLETION_DATA_INVALID:
            message = "Completion data is invalid";
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
extern "C" FFIResult* flatsql_script_scan(Script* script) {
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
extern "C" FFIResult* flatsql_script_parse(Script* script) {
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
extern "C" FFIResult* flatsql_script_analyze(Script* script, Script* external) {
    // Analyze the script
    auto [analyzed, status] = script->Analyze(external);
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
extern "C" FFIResult* flatsql_script_format(flatsql::Script* script) {
    auto text = std::make_unique<std::string>(script->Format());
    auto result = new FFIResult();
    result->status_code = static_cast<uint32_t>(proto::StatusCode::OK);
    result->data_ptr = text->data();
    result->data_length = text->length();
    result->owner_ptr = text.release();
    result->owner_deleter = [](void* buffer) { delete reinterpret_cast<std::string*>(buffer); };
    return result;
}

/// Reindex the script
extern "C" uint32_t flatsql_script_reindex(Script* script) { return static_cast<uint32_t>(script->ReIndex()); }

/// Move the cursor to a script at a position
extern "C" FFIResult* flatsql_script_read_cursor(flatsql::Script* script, size_t text_offset) {
    ScriptCursor cursor{*script->analyzed_script, text_offset};

    // Pack the cursor info
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(cursor.Pack(fb));

    // Store the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(std::move(fb.Release()));
    return packBuffer(std::move(detached));
}

extern "C" FFIResult* flatsql_script_get_statistics(flatsql::Script* script) {
    auto stats = script->GetStatistics();

    // Pack a schema graph
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(proto::ScriptStatistics::Pack(fb, stats.get()));

    // Return the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(std::move(fb.Release()));
    return packBuffer(std::move(detached));
}

/// Create a schema graph
extern "C" flatsql::SchemaGraph* flatsql_schemagraph_new() { return new flatsql::SchemaGraph(); }
/// Delete a schema graph
extern "C" void flatsql_schemagraph_delete(flatsql::SchemaGraph* graph) { delete graph; }
/// Configure a schema graph
extern "C" void flatsql_schemagraph_configure(flatsql::SchemaGraph* graph, size_t iterations_clustering,
                                              size_t iterations_refinement, double force_scaling,
                                              double cooldown_factor, double repulsion_force,
                                              double edge_attraction_force, double gravity_force, double initial_radius,
                                              double board_width, double board_height, double table_width,
                                              double table_height, double table_margin, double grid_size) {
    SchemaGraph::Config config;
    config.iterations_clustering = iterations_clustering;
    config.iterations_refinement = iterations_refinement;
    config.force_scaling = force_scaling;
    config.cooldown_factor = cooldown_factor;
    config.repulsion_force = repulsion_force;
    config.edge_attraction_force = edge_attraction_force;
    config.gravity_force = gravity_force;
    config.initial_radius = initial_radius;
    config.board_width = board_width;
    config.board_height = board_height;
    config.table_width = table_width;
    config.table_height = table_height;
    config.table_margin = table_margin;
    config.grid_size = grid_size;
    graph->Configure(config);
}
/// Update a schema graph
extern "C" FFIResult* flatsql_schemagraph_load_script(flatsql::SchemaGraph* graph, flatsql::Script* script) {
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

/// Describe a schema graph
extern "C" FFIResult* flatsql_schemagraph_describe(flatsql::SchemaGraph* graph) {
    auto desc = graph->Describe();

    // Pack a schema graph
    flatbuffers::FlatBufferBuilder fb;
    auto ofs = proto::SchemaGraphDebugInfo::Pack(fb, desc.get());
    fb.Finish(ofs);

    // Store the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(std::move(fb.Release()));
    return packBuffer(std::move(detached));
}

#ifdef WASM
extern "C" int main() { return 0; }
#endif
