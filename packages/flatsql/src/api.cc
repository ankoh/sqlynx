#include "flatsql/api.h"

#include <span>

#include "flatbuffers/flatbuffers.h"
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

/// Log a std::string
void log(std::string text) { return log(text.data(), text.size()); }
/// Log a string_view
void log(std::string_view text) { return log(text.data(), text.size()); }

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
extern "C" Script* flatsql_script_new() { return new Script(); }
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
        case proto::StatusCode::COMPLETION_DATA_INVALID:
            message = "Completion data is invalid";
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

    // Pack the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(std::move(fb.Release()));
    auto result = new FFIResult();
    result->status_code = static_cast<uint32_t>(proto::StatusCode::OK);
    result->data_ptr = detached->data();
    result->data_length = detached->size();
    result->owner_ptr = detached.release();
    result->owner_deleter = [](void* buffer) { delete reinterpret_cast<flatbuffers::DetachedBuffer*>(buffer); };

    // Store the buffer
    return result;
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

    // Pack the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(std::move(fb.Release()));
    auto result = new FFIResult();
    result->status_code = static_cast<uint32_t>(proto::StatusCode::OK);
    result->data_ptr = detached->data();
    result->data_length = detached->size();
    result->owner_ptr = detached.release();
    result->owner_deleter = [](void* buffer) { delete reinterpret_cast<flatbuffers::DetachedBuffer*>(buffer); };
    return result;
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

    // Store the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(std::move(fb.Release()));
    auto result = new FFIResult();
    result->status_code = static_cast<uint32_t>(proto::StatusCode::OK);
    result->data_ptr = detached->data();
    result->data_length = detached->size();
    result->owner_ptr = detached.release();
    result->owner_deleter = [](void* buffer) { delete reinterpret_cast<flatbuffers::DetachedBuffer*>(buffer); };
    return result;
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

/// Update the completion index
extern "C" uint32_t flatsql_script_update_completion_index(Script* script) {
    return static_cast<uint32_t>(script->UpdateCompletionIndex());
}

/// Create a schema graph
extern "C" flatsql::SchemaGraph* flatsql_schemagraph_new() { return new flatsql::SchemaGraph(); }
/// Delete a schema graph
extern "C" void flatsql_schemagraph_delete(flatsql::SchemaGraph* graph) { delete graph; }
/// Configure a schema graph
extern "C" void flatsql_schemagraph_configure(flatsql::SchemaGraph* graph, double width, double height,
                                              double gravity_x, double gravity_y, double gravity_force,
                                              double edge_force) {
    graph->Configure(width, height, gravity_x, gravity_y, gravity_force, edge_force);
}
/// Update a schema graph
extern "C" FFIResult* flatsql_schemagraph_load_script(flatsql::SchemaGraph* graph, flatsql::Script* script) {
    graph->LoadScript(*script);

    // Pack a schema graph
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(graph->Pack(fb));

    // Store the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(std::move(fb.Release()));
    auto result = new FFIResult();
    result->status_code = static_cast<uint32_t>(proto::StatusCode::OK);
    result->data_ptr = detached->data();
    result->data_length = detached->size();
    result->owner_ptr = detached.release();
    result->owner_deleter = [](void* buffer) { delete reinterpret_cast<flatbuffers::DetachedBuffer*>(buffer); };
    return result;
}

#ifdef WASM
extern "C" int main() { return 0; }
#endif
