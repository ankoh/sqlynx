#pragma once

#include <cstddef>
#include <cstdint>

#include "flatsql/script.h"

extern "C" std::byte* flatsql_malloc(size_t length);
/// Delete memory
extern "C" void flatsql_free(void* buffer);

/// A managed FFI result container
struct FFIResult {
    uint32_t status_code;
    uint32_t data_length;
    const void* data_ptr;
    void* owner_ptr;
    void (*owner_deleter)(void*);
};

/// Create a script
extern "C" flatsql::Script* flatsql_script_new();
/// Delete a script
extern "C" void flatsql_script_delete(flatsql::Script* script);
/// Delete a result
extern "C" void flatsql_result_delete(FFIResult* result);
/// Insert char at a position
extern "C" void flatsql_script_insert_char_at(flatsql::Script* script, size_t offset, uint32_t unicode);
/// Insert text at a position
extern "C" void flatsql_script_insert_text_at(flatsql::Script* script, size_t offset, const char* text_ptr,
                                              size_t text_length);
/// Erase a text range
extern "C" void flatsql_script_erase_text_range(flatsql::Script* script, size_t offset, size_t count);
/// Get the script content as string
extern "C" FFIResult* flatsql_script_to_string(flatsql::Script* script);
/// Scan a script
extern "C" FFIResult* flatsql_script_scan(flatsql::Script* script);
/// Parse a script
extern "C" FFIResult* flatsql_script_parse(flatsql::Script* script);
/// Analyze a script
extern "C" FFIResult* flatsql_script_analyze(flatsql::Script* script, flatsql::Script* external);
/// Update the completion index
extern "C" uint32_t flatsql_script_update_completion_index(flatsql::Script* script);
