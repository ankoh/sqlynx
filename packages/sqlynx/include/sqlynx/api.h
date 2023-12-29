#pragma once

#include <cstddef>
#include <cstdint>

#include "sqlynx/catalog.h"
#include "sqlynx/script.h"
#include "sqlynx/version.h"
#include "sqlynx/vis/schema_layout.h"

namespace console {
/// Log a text to the console
void log(std::string_view text);
}  // namespace console

/// Get the SQLynx version
extern "C" sqlynx::SQLynxVersion* sqlynx_version();

/// Allocate memory
extern "C" std::byte* sqlynx_malloc(size_t length);
/// Delete memory
extern "C" void sqlynx_free(const void* buffer);

/// A managed FFI result container
struct FFIResult {
    uint32_t status_code;
    uint32_t data_length;
    const void* data_ptr;
    void* owner_ptr;
    void (*owner_deleter)(void*);
};
/// Delete a result
extern "C" void sqlynx_result_delete(FFIResult* result);

/// Create a script
extern "C" sqlynx::Script* sqlynx_script_new(uint32_t external_id, const char* database_name_ptr = nullptr,
                                             size_t database_name_length = 0, const char* schema_name_ptr = nullptr,
                                             size_t schema_name_length = 0);
/// Delete a script
extern "C" void sqlynx_script_delete(sqlynx::Script* script);
/// Insert char at a position
extern "C" void sqlynx_script_insert_char_at(sqlynx::Script* script, size_t offset, uint32_t unicode);
/// Insert text at a position
extern "C" void sqlynx_script_insert_text_at(sqlynx::Script* script, size_t offset, const char* text_ptr,
                                             size_t text_length);
/// Erase a text range
extern "C" void sqlynx_script_erase_text_range(sqlynx::Script* script, size_t offset, size_t count);
/// Get the script content as string
extern "C" FFIResult* sqlynx_script_to_string(sqlynx::Script* script);
/// Scan a script
extern "C" FFIResult* sqlynx_script_scan(sqlynx::Script* script);
/// Parse a script
extern "C" FFIResult* sqlynx_script_parse(sqlynx::Script* script);
/// Analyze a script
extern "C" FFIResult* sqlynx_script_analyze(sqlynx::Script* script, const sqlynx::Catalog* registry);
/// Get a pretty-printed version of the SQL query
extern "C" FFIResult* sqlynx_script_format(sqlynx::Script* script);
/// Get script statistics
extern "C" FFIResult* sqlynx_script_get_statistics(sqlynx::Script* script);
/// Move the cursor in a script to a position
extern "C" FFIResult* sqlynx_script_move_cursor(sqlynx::Script* script, size_t text_offset);
/// Complete at a cursor in the script
extern "C" FFIResult* sqlynx_script_complete_at_cursor(sqlynx::Script* script, size_t limit);

/// Create a catalog
extern "C" sqlynx::Catalog* sqlynx_catalog_new();
/// Create a catalog
extern "C" void sqlynx_catalog_delete(sqlynx::Catalog* registry);
/// Add a script to the catalog
extern "C" FFIResult* sqlynx_catalog_add_script(sqlynx::Catalog* registry, sqlynx::Script* script, size_t rank);
/// Update a script in the catalog
extern "C" FFIResult* sqlynx_catalog_update_script(sqlynx::Catalog* registry, sqlynx::Script* script);
/// Drop script from the catalog
extern "C" void sqlynx_catalog_drop_script(sqlynx::Catalog* registry, sqlynx::Script* script);
/// Add an external schema in the catalog
extern "C" FFIResult* sqlynx_catalog_add_schema(sqlynx::Catalog* registry, size_t external_id, size_t rank,
                                                const char* database_name_ptr, size_t database_name_length,
                                                const char* schema_name_ptr, size_t schema_name_length);
/// Drop an external schema
extern "C" void sqlynx_catalog_drop_schema(sqlynx::Catalog* registry, size_t external_id);
/// Insert tables into an external schema
extern "C" FFIResult* sqlynx_catalog_insert_schema_tables(sqlynx::Catalog* registry, size_t external_id,
                                                          const void* data_ptr, size_t data_size);

/// Create schema graph
extern "C" sqlynx::SchemaGrid* sqlynx_schema_layout_new();
/// Delete a schema graph
extern "C" void sqlynx_schema_layout_delete(sqlynx::SchemaGrid* graph);
/// Configure a schema graph
extern "C" void sqlynx_schema_layout_configure(sqlynx::SchemaGrid* graph, double board_width, double board_height,
                                               double cell_width, double cell_height, double table_width,
                                               double table_height);
/// Update a schema graph
extern "C" FFIResult* sqlynx_schema_layout_load_script(sqlynx::SchemaGrid* graph, sqlynx::Script* script);
