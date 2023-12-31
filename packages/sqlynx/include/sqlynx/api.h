#pragma once

#include <cstddef>
#include <cstdint>

#include "sqlynx/catalog.h"
#include "sqlynx/script.h"
#include "sqlynx/version.h"
#include "sqlynx/vis/query_graph_layout.h"

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

    template <typename T> T* CastOwnerPtr() { return static_cast<T*>(owner_ptr); }
};
/// Delete a result
extern "C" void sqlynx_delete_result(FFIResult* result);

/// Create a script
extern "C" FFIResult* sqlynx_script_new(sqlynx::Catalog* catalog, uint32_t external_id,
                                        const char* database_name_ptr = nullptr, size_t database_name_length = 0,
                                        const char* schema_name_ptr = nullptr, size_t schema_name_length = 0);
/// Insert char at a position
extern "C" void sqlynx_script_insert_char_at(sqlynx::Script* script, size_t offset, uint32_t unicode);
/// Insert text at a position
extern "C" void sqlynx_script_insert_text_at(sqlynx::Script* script, size_t offset, const char* text_ptr,
                                             size_t text_length);
/// Replace text in a script
extern "C" void sqlynx_script_replace_text(sqlynx::Script* script, const char* text_ptr, size_t text_length);
/// Erase a text range
extern "C" void sqlynx_script_erase_text_range(sqlynx::Script* script, size_t offset, size_t count);
/// Get the script content as string
extern "C" FFIResult* sqlynx_script_to_string(sqlynx::Script* script);
/// Scan a script
extern "C" FFIResult* sqlynx_script_scan(sqlynx::Script* script);
/// Parse a script
extern "C" FFIResult* sqlynx_script_parse(sqlynx::Script* script);
/// Analyze a script
extern "C" FFIResult* sqlynx_script_analyze(sqlynx::Script* script);
/// Get a pretty-printed version of the SQL query
extern "C" FFIResult* sqlynx_script_format(sqlynx::Script* script);
/// Get script statistics
extern "C" FFIResult* sqlynx_script_get_statistics(sqlynx::Script* script);
/// Move the cursor in a script to a position
extern "C" FFIResult* sqlynx_script_move_cursor(sqlynx::Script* script, size_t text_offset);
/// Complete at a cursor in the script
extern "C" FFIResult* sqlynx_script_complete_at_cursor(sqlynx::Script* script, size_t limit);

/// Create a catalog
extern "C" FFIResult* sqlynx_catalog_new();
/// Add a script to the catalog
extern "C" FFIResult* sqlynx_catalog_add_script(sqlynx::Catalog* catalog, sqlynx::Script* script, size_t rank);
/// Drop script from the catalog
extern "C" void sqlynx_catalog_drop_script(sqlynx::Catalog* catalog, sqlynx::Script* script);
/// Add a descriptor pool to the catalog
extern "C" FFIResult* sqlynx_catalog_add_descriptor_pool(sqlynx::Catalog* catalog, size_t external_id, size_t rank);
/// Drop a descriptor pool from the catalog
extern "C" void sqlynx_catalog_drop_descriptor_pool(sqlynx::Catalog* catalog, size_t external_id);
/// Add schema descriptor to a catalog
extern "C" FFIResult* sqlynx_catalog_add_schema_descriptor(sqlynx::Catalog* catalog, size_t external_id,
                                                           const void* data_ptr, size_t data_size);

/// Create a query graph layout
extern "C" FFIResult* sqlynx_query_graph_layout_new();
/// Configure a query graph layout
extern "C" void sqlynx_query_graph_layout_configure(sqlynx::QueryGraphLayout* graph, double board_width,
                                                    double board_height, double cell_width, double cell_height,
                                                    double table_width, double table_height);
/// Update a query graph layout
extern "C" FFIResult* sqlynx_query_graph_layout_load_script(sqlynx::QueryGraphLayout* graph, sqlynx::Script* script);
