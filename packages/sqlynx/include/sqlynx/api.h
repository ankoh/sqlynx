#pragma once

#include <cstddef>
#include <cstdint>

#include "sqlynx/schema.h"
#include "sqlynx/script.h"
#include "sqlynx/version.h"
#include "sqlynx/vis/schema_grid.h"

namespace console {
/// Log a text to the console
void log(std::string_view text);
}  // namespace console

/// Get the SQLynx version
extern "C" sqlynx::SQLynxVersion* sqlynx_version();

/// Allocate memory
extern "C" std::byte* sqlynx_malloc(size_t length);
/// Delete memory
extern "C" void sqlynx_free(void* buffer);

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
extern "C" sqlynx::Script* sqlynx_script_new(uint32_t context_id);
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
extern "C" FFIResult* sqlynx_script_analyze(sqlynx::Script* script, const sqlynx::SchemaSearchPath* search_path);
/// Get a pretty-printed version of the SQL query
extern "C" FFIResult* sqlynx_script_format(sqlynx::Script* script);
/// Get script statistics
extern "C" FFIResult* sqlynx_script_get_statistics(sqlynx::Script* script);
/// Move the cursor in a script to a position
extern "C" FFIResult* sqlynx_script_move_cursor(sqlynx::Script* script, size_t text_offset);
/// Complete at a cursor in the script
extern "C" FFIResult* sqlynx_script_complete_at_cursor(sqlynx::Script* script, size_t limit);

/// Create a schema search path
extern "C" sqlynx::SchemaSearchPath* sqlynx_search_path_new();
/// Create a schema search path
extern "C" void sqlynx_search_path_delete(sqlynx::SchemaSearchPath* search_path);
/// Append a script to the schema search path
extern "C" FFIResult* sqlynx_search_path_append_script(sqlynx::SchemaSearchPath* path, sqlynx::Script* script);
/// Insert a script in the schema search path
extern "C" FFIResult* sqlynx_search_path_insert_script_at(sqlynx::SchemaSearchPath* path, size_t index,
                                                          sqlynx::Script* script);
/// Update a script in the schema search path
extern "C" FFIResult* sqlynx_search_path_update_script(sqlynx::SchemaSearchPath* path, sqlynx::Script* script);
/// Erase script in the schema search path
extern "C" FFIResult* sqlynx_search_path_erase_script(sqlynx::SchemaSearchPath* path, sqlynx::Script* script);

/// Create schema graph
extern "C" sqlynx::SchemaGrid* sqlynx_schemagraph_new();
/// Delete a schema graph
extern "C" void sqlynx_schemagraph_delete(sqlynx::SchemaGrid* graph);
/// Configure a schema graph
extern "C" void sqlynx_schemagraph_configure(sqlynx::SchemaGrid* graph, double board_width, double board_height,
                                             double cell_width, double cell_height, double table_width,
                                             double table_height);
/// Update a schema graph
extern "C" FFIResult* sqlynx_schemagraph_load_script(sqlynx::SchemaGrid* graph, sqlynx::Script* script);
