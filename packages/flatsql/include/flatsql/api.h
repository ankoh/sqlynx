#pragma once

#include <cstddef>
#include <cstdint>

#include "flatsql/script.h"
#include "flatsql/version.h"
#include "flatsql/vis/schema_graph.h"

/// Get the FlatSQL version
extern "C" flatsql::FlatSQLVersion* flatsql_version();

/// Allocate memory
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
/// Delete a result
extern "C" void flatsql_result_delete(FFIResult* result);

/// Create a script
extern "C" flatsql::Script* flatsql_script_new();
/// Delete a script
extern "C" void flatsql_script_delete(flatsql::Script* script);
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
/// Get a pretty-printed version of the SQL query
extern "C" FFIResult* flatsql_script_format(flatsql::Script* script);
/// Update the completion index
extern "C" uint32_t flatsql_script_update_completion_index(flatsql::Script* script);

/// Create schema graph
extern "C" flatsql::SchemaGraph* flatsql_schemagraph_new();
/// Delete a schema graph
extern "C" void flatsql_schemagraph_delete(flatsql::SchemaGraph* graph);
/// Configure a schema graph
extern "C" void flatsql_schemagraph_configure(flatsql::SchemaGraph* graph, size_t iteration_count, double force_scaling,
                                              double cooldown_factor, double repulsion_force,
                                              double edge_attraction_force, double gravity_force, double initial_radius,
                                              double board_width, double board_height, double tableWidth,
                                              double tableConstantHeight, double tableColumnHeight,
                                              double tableMaxHeight, double tableMargin);
/// Update a schema graph
extern "C" FFIResult* flatsql_schemagraph_load_script(flatsql::SchemaGraph* graph, flatsql::Script* script);
