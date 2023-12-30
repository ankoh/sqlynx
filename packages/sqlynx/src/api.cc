#include "sqlynx/api.h"

#include <flatbuffers/detached_buffer.h>
#include <flatbuffers/flatbuffer_builder.h>

#include <span>

#include "flatbuffers/flatbuffers.h"
#include "sqlynx/analyzer/completion.h"
#include "sqlynx/catalog.h"
#include "sqlynx/parser/parser.h"
#include "sqlynx/parser/scanner.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/text/rope.h"
#include "sqlynx/version.h"
#include "sqlynx/vis/query_graph_layout.h"

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

static FFIResult* packOK() {
    auto result = std::make_unique<FFIResult>();
    result->status_code = static_cast<uint32_t>(proto::StatusCode::OK);
    result->data_ptr = nullptr;
    result->data_length = 0;
    result->owner_ptr = nullptr;
    result->owner_deleter = [](void*) {};
    return result.release();
}

template <typename T> static FFIResult* packPtr(std::unique_ptr<T> ptr) {
    auto result = std::make_unique<FFIResult>();
    auto raw_ptr = ptr.release();
    result->status_code = static_cast<uint32_t>(proto::StatusCode::OK);
    result->data_ptr = nullptr;
    result->data_length = 0;
    result->owner_ptr = raw_ptr;
    result->owner_deleter = [](void* p) { delete reinterpret_cast<T*>(p); };
    return result.release();
}

static FFIResult* packBuffer(std::unique_ptr<flatbuffers::DetachedBuffer> detached) {
    auto result = std::make_unique<FFIResult>();
    result->status_code = static_cast<uint32_t>(proto::StatusCode::OK);
    result->data_ptr = detached->data();
    result->data_length = detached->size();
    result->owner_ptr = detached.release();
    result->owner_deleter = [](void* buffer) { delete reinterpret_cast<flatbuffers::DetachedBuffer*>(buffer); };
    return result.release();
}

static FFIResult* packError(proto::StatusCode status) {
    std::string_view message;
    switch (status) {
        case proto::StatusCode::PARSER_INPUT_NOT_SCANNED:
            message = "Parser input is not scanned";
            break;
        case proto::StatusCode::ANALYZER_INPUT_NOT_PARSED:
            message = "Analyzer input is not parsed";
            break;
        case proto::StatusCode::GRAPH_INPUT_NOT_ANALYZED:
            message = "Graph input is not analyzed";
            break;
        case proto::StatusCode::CATALOG_SCRIPT_NOT_ANALYZED:
            message = "Unanalyzed scripts cannot be added to the catalog";
            break;
        case proto::StatusCode::CATALOG_SCRIPT_UNKNOWN:
            message = "Script is missing in catalog";
            break;
        case proto::StatusCode::CATALOG_DESCRIPTOR_TABLES_NULL:
            message = "Schema descriptor field `tables` is null or empty";
            break;
        case proto::StatusCode::CATALOG_DESCRIPTOR_TABLE_NAME_EMPTY:
            message = "Table name in schema descriptor is null or empty";
            break;
        case proto::StatusCode::CATALOG_DESCRIPTOR_TABLE_NAME_COLLISION:
            message = "Schema descriptor contains a duplicate table name";
            break;
        case proto::StatusCode::COMPLETION_MISSES_CURSOR:
            message = "Completion requires a script cursor";
            break;
        case proto::StatusCode::COMPLETION_MISSES_SCANNER_TOKEN:
            message = "Completion requires a scanner token";
            break;
        case proto::StatusCode::EXTERNAL_ID_COLLISION:
            message = "Collision on external identifier";
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

/// Get the SQLynx version
extern "C" SQLynxVersion* sqlynx_version() { return &sqlynx::VERSION; }

/// Allocate memory
extern "C" std::byte* sqlynx_malloc(size_t length) { return new std::byte[length]; }
/// Delete memory
extern "C" void sqlynx_free(const void* buffer) { delete[] reinterpret_cast<const std::byte*>(buffer); }

/// Delete a result
extern "C" void sqlynx_delete_result(FFIResult* result) {
    result->owner_deleter(result->owner_ptr);
    result->owner_ptr = nullptr;
    result->owner_deleter = nullptr;
    delete result;
}

/// Create a script
extern "C" FFIResult* sqlynx_script_new(const sqlynx::Catalog* catalog, uint32_t external_id,
                                        const char* database_name_ptr, size_t database_name_length,
                                        const char* schema_name_ptr, size_t schema_name_length) {
    if (catalog && catalog->Contains(external_id)) {
        return packError(proto::StatusCode::EXTERNAL_ID_COLLISION);
    }
    // Read database and schema names
    std::string database_name, schema_name;
    if (database_name_ptr != nullptr) {
        database_name = {database_name_ptr, database_name_length};
    }
    if (schema_name_ptr != nullptr) {
        schema_name = {schema_name_ptr, schema_name_length};
    }
    // Free argument buffers
    sqlynx_free(database_name_ptr);
    sqlynx_free(schema_name_ptr);
    // Construct the script
    std::unique_ptr<Script> script;
    if (catalog == nullptr) {
        script = std::make_unique<Script>(external_id, std::move(database_name), std::move(schema_name));
    } else {
        script = std::make_unique<Script>(*catalog, external_id, std::move(database_name), std::move(schema_name));
    }
    return packPtr(std::move(script));
}
/// Insert char at a position
extern "C" void sqlynx_script_insert_char_at(Script* script, size_t offset, uint32_t unicode) {
    script->InsertCharAt(offset, unicode);
}
/// Insert text at a position
extern "C" void sqlynx_script_insert_text_at(Script* script, size_t offset, const char* text_ptr, size_t text_length) {
    std::string_view text{text_ptr, text_length};
    script->InsertTextAt(offset, text);
    sqlynx_free(text_ptr);
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
extern "C" FFIResult* sqlynx_script_analyze(Script* script) {
    // Analyze the script
    auto [analyzed, status] = script->Analyze();
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

/// Create a catalog
extern "C" FFIResult* sqlynx_catalog_new() { return packPtr(std::make_unique<sqlynx::Catalog>()); }
/// Add a script in the catalog
extern "C" FFIResult* sqlynx_catalog_add_script(sqlynx::Catalog* catalog, sqlynx::Script* script, size_t rank) {
    auto status = catalog->AddScript(*script, rank);
    if (status != proto::StatusCode::OK) {
        return packError(status);
    }
    return packOK();
}
/// Update a script in the catalog
extern "C" FFIResult* sqlynx_catalog_update_script(sqlynx::Catalog* catalog, sqlynx::Script* script) {
    auto status = catalog->UpdateScript(*script);
    if (status != proto::StatusCode::OK) {
        return packError(status);
    }
    return packOK();
}
/// Drop entry in the catalog
extern "C" void sqlynx_catalog_drop_script(sqlynx::Catalog* catalog, sqlynx::Script* script) {
    catalog->DropScript(*script);
}
/// Add a descriptor pool to the catalog
extern "C" FFIResult* sqlynx_catalog_add_descriptor_pool(sqlynx::Catalog* catalog, size_t external_id, size_t rank) {
    return nullptr;
}
/// Drop a descriptor pool from the catalog
extern "C" void sqlynx_catalog_drop_descriptor_pool(sqlynx::Catalog* catalog, size_t external_id) {}
/// Add schema descriptor to a catalog
extern "C" FFIResult* sqlynx_catalog_add_schema_descriptor(sqlynx::Catalog* catalog, size_t external_id,
                                                           const void* data_ptr, size_t data_size) {
    return nullptr;
}

/// Create a schema graph
extern "C" FFIResult* sqlynx_query_graph_layout_new() { return packPtr(std::make_unique<sqlynx::QueryGraphLayout>()); }
/// Configure a schema graph
extern "C" void sqlynx_query_graph_layout_configure(sqlynx::QueryGraphLayout* graph, double board_width,
                                                    double board_height, double cell_width, double cell_height,
                                                    double table_width, double table_height) {
    QueryGraphLayout::Config config;
    config.board_width = board_width;
    config.board_height = board_height;
    config.cell_width = cell_width;
    config.cell_height = cell_height;
    config.table_width = table_width;
    config.table_height = table_height;
    graph->Configure(config);
}
/// Update a schema graph
extern "C" FFIResult* sqlynx_query_graph_layout_load_script(sqlynx::QueryGraphLayout* graph, sqlynx::Script* script) {
    auto status = graph->LoadScript(*script);
    if (status != proto::StatusCode::OK) {
        return packError(status);
    }

    // Pack a schema graph
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(graph->Pack(fb));

    // Store the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(std::move(fb.Release()));
    return packBuffer(std::move(detached));
}

#ifdef WASM
extern "C" int main() { return 0; }
#endif
