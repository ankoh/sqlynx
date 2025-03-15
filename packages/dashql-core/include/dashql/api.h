#pragma once

#include <cstddef>
#include <cstdint>

#include "dashql/catalog.h"
#include "dashql/script.h"
#include "dashql/version.h"

namespace console {
/// Log a text to the console
void log(std::string_view text);
}  // namespace console

/// Get the DashQL version
extern "C" dashql::DashQLVersion* dashql_version();

/// Allocate memory
extern "C" std::byte* dashql_malloc(size_t length);
/// Delete memory
extern "C" void dashql_free(const void* buffer);

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
extern "C" void dashql_delete_result(FFIResult* result);

/// Create a script
extern "C" FFIResult* dashql_script_new(dashql::Catalog* catalog, uint32_t external_id);
/// Insert char at a position
extern "C" void dashql_script_insert_char_at(dashql::Script* script, size_t offset, uint32_t unicode);
/// Insert text at a position
extern "C" void dashql_script_insert_text_at(dashql::Script* script, size_t offset, const char* text_ptr,
                                             size_t text_length);
/// Replace text in a script
extern "C" void dashql_script_replace_text(dashql::Script* script, const char* text_ptr, size_t text_length);
/// Erase a text range
extern "C" void dashql_script_erase_text_range(dashql::Script* script, size_t offset, size_t count);
/// Get the script content as string
extern "C" FFIResult* dashql_script_to_string(dashql::Script* script);
/// Scan a script
extern "C" FFIResult* dashql_script_scan(dashql::Script* script);
/// Parse a script
extern "C" FFIResult* dashql_script_parse(dashql::Script* script);
/// Analyze a script
extern "C" FFIResult* dashql_script_analyze(dashql::Script* script);
/// Get a pretty-printed version of the SQL query
extern "C" FFIResult* dashql_script_format(dashql::Script* script);
/// Get script statistics
extern "C" FFIResult* dashql_script_get_statistics(dashql::Script* script);
/// Move the cursor in a script to a position
extern "C" FFIResult* dashql_script_move_cursor(dashql::Script* script, size_t text_offset);
/// Complete at a cursor in the script
extern "C" FFIResult* dashql_script_complete_at_cursor(dashql::Script* script, size_t limit);

/// Create a catalog
extern "C" FFIResult* dashql_catalog_new(const char* database_name_ptr = nullptr, size_t database_name_length = 0,
                                         const char* schema_name_ptr = nullptr, size_t schema_name_length = 0);
/// Clear a catalog
extern "C" void dashql_catalog_clear(dashql::Catalog* catalog);
/// Describe all entries
extern "C" FFIResult* dashql_catalog_describe_entries(dashql::Catalog* catalog);
/// Describe all entries
extern "C" FFIResult* dashql_catalog_describe_entries_of(dashql::Catalog* catalog, size_t external_id);
/// Add a script to the catalog
extern "C" FFIResult* dashql_catalog_load_script(dashql::Catalog* catalog, dashql::Script* script, size_t rank);
/// Drop script from the catalog
extern "C" void dashql_catalog_drop_script(dashql::Catalog* catalog, dashql::Script* script);
/// Add a descriptor pool to the catalog
extern "C" FFIResult* dashql_catalog_add_descriptor_pool(dashql::Catalog* catalog, size_t external_id, size_t rank);
/// Drop a descriptor pool from the catalog
extern "C" void dashql_catalog_drop_descriptor_pool(dashql::Catalog* catalog, size_t external_id);
/// Add schema descriptor to a catalog
extern "C" FFIResult* dashql_catalog_add_schema_descriptor(dashql::Catalog* catalog, size_t external_id,
                                                           const void* data_ptr, size_t data_size);
/// Get catalog statistics
extern "C" FFIResult* dashql_catalog_get_statistics(dashql::Catalog* catalog);
