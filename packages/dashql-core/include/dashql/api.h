#pragma once

#include <cstddef>
#include <cstdint>

#include "dashql/catalog.h"
#include "dashql/script_session.h"
#include "dashql/script.h"
#include "dashql/view/plan_view_model.h"

namespace dashql::execution {
class ScriptExecution;
}

namespace console {
/// Log a text to the console
void log(std::string_view text);
}  // namespace console

/// Allocate memory
extern "C" std::byte* dashql_malloc(size_t length);
/// Delete memory
extern "C" void dashql_free(const void* buffer);

// -----------------------------------------------------------------------------

/// FFI result container (allocated on stack by caller, populated by callee)
/// Used for data-returning functions. Caller allocates FFIResult on stack, passes pointer to function,
/// function fills in the fields, caller reads the fields and calls dashql_delete_owner to clean up.
/// Functions that only perform operations throw exceptions directly without returning FFIResult.
struct FFIResult {
    uint32_t data_length = 0;
    const void* data_ptr = nullptr;
    void* owner_ptr = nullptr;
    void (*owner_deleter)(void*) = nullptr;

    template <typename T> T* CastOwnerPtr() { return static_cast<T*>(owner_ptr); }
};

/// Delete an owner by calling its deleter
extern "C" void dashql_delete_owner(void* owner_ptr, void (*owner_deleter)(void*));

/// Plan sessions in notebook order without analyzing or publishing them.
/// Borrows the session pointer array and returns an owned ExecutionGraph FlatBuffer.
/// Non-null session pointers must refer to live sessions with live borrowed catalogs;
/// native callers own their lifetime for the duration of this call.
/// Null entries and invalid analysis are reported as graph diagnostics, not dangling pointers.
/// Allocation failure leaves an empty result.
extern "C" void dashql_planner_plan(FFIResult* result, dashql::ScriptSession* const* sessions,
                                     uint32_t session_count) noexcept;

// -----------------------------------------------------------------------------

extern "C" void dashql_script_execution_new(FFIResult* result, dashql::ScriptSession* session,
                                               size_t dialect, size_t mode, size_t max_width,
                                               size_t indentation_width, bool debug_mode);
extern "C" void dashql_script_execution_start(FFIResult* result, dashql::execution::ScriptExecution* execution);
extern "C" void dashql_script_execution_resume(FFIResult* result,
                                                  dashql::execution::ScriptExecution* execution,
                                                  const uint8_t* statement_result_ptr,
                                                  size_t statement_result_length);
extern "C" void dashql_script_execution_cancel(FFIResult* result, dashql::execution::ScriptExecution* execution);

// -----------------------------------------------------------------------------

/// Create a script (fills in result buffer allocated by caller)
extern "C" void dashql_script_new(FFIResult* result, dashql::Catalog* catalog);
/// Get the entry id
extern "C" uint32_t dashql_script_get_catalog_entry_id(dashql::Script* script);
/// Insert char at a position
extern "C" void dashql_script_insert_char_at(dashql::Script* script, size_t offset, uint32_t unicode);
/// Insert text at a position
extern "C" void dashql_script_insert_text_at(dashql::Script* script, size_t offset, const char* text_ptr,
                                             size_t text_length);
/// Replace text in a script
extern "C" void dashql_script_replace_text(dashql::Script* script, const char* text_ptr, size_t text_length);
/// Erase a text range
extern "C" void dashql_script_erase_text_range(dashql::Script* script, size_t offset, size_t count);
/// Get the script content as a string. A zero-length span selects the entire script.
extern "C" void dashql_script_to_string(FFIResult* result, dashql::Script* script, size_t offset, size_t length);
/// Get the first parsed statement without its separator or surrounding trivia.
extern "C" void dashql_script_get_statement_text(FFIResult* result, dashql::Script* script, bool parse_if_outdated);
/// Compile the script into an executable query.
extern "C" void dashql_script_compile_query(FFIResult* result, dashql::Script* script, size_t dialect, size_t mode,
                                              size_t max_width, size_t indentation_width, bool allow_extensions,
                                              bool parse_if_outdated);
/// Scan a script (throws exception on error)
extern "C" void dashql_script_scan(dashql::Script* script);
/// Parse a script (throws exception on error)
extern "C" void dashql_script_parse(dashql::Script* script);
/// Analyze a script (throws exception on error)
extern "C" void dashql_script_analyze(dashql::Script* script, bool parse_if_outdated);
/// Get a pretty-printed version of the SQL query
extern "C" void dashql_script_format(FFIResult* result, dashql::Script* script, size_t dialect, size_t mode,
                                        size_t max_width, size_t indentation_width, bool debug_mode, size_t keyword_case,
                                       bool parse_if_outdated, dashql::Catalog* catalog);
/// Whether formatting this script can complete without placeholders.
extern "C" uint32_t dashql_script_is_fully_formattable(dashql::Script* script, size_t dialect, size_t mode,
                                                             size_t max_width, size_t indentation_width, bool debug_mode,
                                                             bool parse_if_outdated);
/// Get the node ids that prevent full formatting.
extern "C" void dashql_script_get_unformattable_nodes(
    FFIResult* result, dashql::Script* script, size_t dialect, size_t mode, size_t max_width,
    size_t indentation_width, bool debug_mode, bool parse_if_outdated);
/// Get script id
extern "C" uint32_t dashql_script_get_catalog_entry_id(dashql::Script* script);
/// Get the scanned script
extern "C" void dashql_script_get_scanned(FFIResult* result, dashql::Script* script);
/// Get the parsed script
extern "C" void dashql_script_get_parsed(FFIResult* result, dashql::Script* script);
/// Get the analyzed script
extern "C" void dashql_script_get_analyzed(FFIResult* result, dashql::Script* script);
/// Compute a statement-level semantic diff from a source (old) script to a target (new) script
extern "C" void dashql_script_compute_diff(FFIResult* result, dashql::Script* source, dashql::Script* target);
/// Get script statistics
extern "C" void dashql_script_get_statistics(FFIResult* result, dashql::Script* script);
/// Move the cursor in a script to a position
extern "C" void dashql_script_move_cursor(FFIResult* result, dashql::Script* script, size_t text_offset);
/// Complete at a cursor in the script
extern "C" void dashql_script_complete_at_cursor(FFIResult* result, dashql::Script* script, size_t limit,
                                                   size_t keyword_case);

// -----------------------------------------------------------------------------

/// Create an editor session borrowing the catalog. Destroy it before destroying the catalog.
extern "C" void dashql_script_session_new(FFIResult* result, dashql::Catalog* catalog, size_t offset_unit);
/// Destroy an editor session.
extern "C" void dashql_script_session_destroy(dashql::ScriptSession* session);
/// Get the owned script's catalog entry id.
extern "C" uint32_t dashql_script_session_get_catalog_entry_id(dashql::ScriptSession* session);
/// Get the current document as UTF-8 text.
extern "C" void dashql_script_session_get_text(FFIResult* result, dashql::ScriptSession* session);
/// Get revisions directly.
extern "C" uint64_t dashql_script_session_get_text_version(dashql::ScriptSession* session);
extern "C" uint64_t dashql_script_session_get_state_revision(dashql::ScriptSession* session);
extern "C" uint64_t dashql_script_session_get_catalog_revision(dashql::ScriptSession* session);
/// Replace all UTF-8 text and return an owned EditorUpdate FlatBuffer.
/// Takes ownership of text_ptr, which must be null or allocated by dashql_malloc.
extern "C" void dashql_script_session_replace_text(FFIResult* result, dashql::ScriptSession* session,
                                                    uint64_t expected_text_version, const char* text_ptr,
                                                    size_t text_length);
/// Apply a serialized EditorEvent and return an owned EditorUpdate FlatBuffer.
extern "C" void dashql_script_session_apply(FFIResult* result, dashql::ScriptSession* session,
                                             const uint8_t* event_ptr, size_t event_length);
/// Set a collapsed primary selection and return an owned EditorUpdate FlatBuffer.
extern "C" void dashql_script_session_set_primary_cursor(FFIResult* result, dashql::ScriptSession* session,
                                                          uint64_t expected_text_version, uint64_t offset);
/// Analyze and publish the session script synchronously, returning an owned EditorUpdate FlatBuffer.
extern "C" void dashql_script_session_analyze(FFIResult* result, dashql::ScriptSession* session);
extern "C" void dashql_script_session_complete_at_cursor(FFIResult* result,
                                                           dashql::ScriptSession* session, size_t limit,
                                                           size_t keyword_case);
/// Compile the session script into an executable query FlatBuffer.
extern "C" void dashql_script_session_compile_query(FFIResult* result, dashql::ScriptSession* session,
                                                      size_t dialect, size_t mode, size_t max_width,
                                                      size_t indentation_width, bool allow_extensions,
                                                      bool parse_if_outdated);
/// Format the session into a separately owned normal Script.
extern "C" void dashql_script_session_format(FFIResult* result, dashql::ScriptSession* session,
                                                 size_t dialect, size_t mode, size_t max_width,
                                                 size_t indentation_width, bool debug_mode, size_t keyword_case, bool parse_if_outdated,
                                                dashql::Catalog* catalog);
/// Rewrite dashboard placement and return the resulting UTF-8 source text.
/// Negative row/column values mean that the corresponding coordinate is omitted.
extern "C" void dashql_script_session_rewrite_dashboard(FFIResult* result, dashql::ScriptSession* session,
                                                          int32_t row, int32_t column, int32_t width,
                                                          int32_t height, bool parse_if_outdated);
/// Whether formatting the session can complete without placeholders.
extern "C" uint32_t dashql_script_session_is_fully_formattable(dashql::ScriptSession* session,
                                                                 size_t dialect, size_t mode, size_t max_width,
                                                                 size_t indentation_width, bool debug_mode,
                                                                 bool parse_if_outdated);
/// Compute a semantic diff from the session to a parsed normal Script target.
extern "C" void dashql_script_session_compute_diff(FFIResult* result, dashql::ScriptSession* session,
                                                     dashql::Script* target);
/// Publish or remove the session-owned script in its borrowed catalog.
extern "C" void dashql_script_session_load_into_catalog(dashql::ScriptSession* session, size_t rank);
extern "C" void dashql_script_session_drop_from_catalog(dashql::ScriptSession* session);

// -----------------------------------------------------------------------------

/// Create a catalog
extern "C" void dashql_catalog_new(FFIResult* result);
/// Process independent inputs synchronously. Borrows input and returns owned FlatBuffer bytes.
extern "C" void dashql_process_batch(FFIResult* result, const uint8_t* request_ptr, size_t request_length);
/// Allocate an authoritative receiver entry ID for descriptor replacement.
extern "C" uint32_t dashql_catalog_allocate_entry_id(dashql::Catalog* catalog);
/// Atomically replace one pool from a borrowed CatalogDescriptor FlatBuffer.
extern "C" void dashql_catalog_replace_descriptor(dashql::Catalog* catalog, uint32_t id, uint32_t rank,
                                                  const uint8_t* descriptor_ptr, uint32_t descriptor_length);
extern "C" void dashql_catalog_drop_descriptor(dashql::Catalog* catalog, uint32_t entry_id);
/// Clear a catalog
extern "C" void dashql_catalog_clear(dashql::Catalog* catalog);
/// Check if a catalog contains an entry id
extern "C" bool dashql_catalog_contains_entry_id(dashql::Catalog* catalog, uint32_t entry_id);
/// Describe all entries
extern "C" void dashql_catalog_describe_entries(FFIResult* result, dashql::Catalog* catalog);
/// Describe all entries
extern "C" void dashql_catalog_describe_entries_of(FFIResult* result, dashql::Catalog* catalog, size_t external_id);
/// Add a script to the catalog (throws exception on error)
extern "C" void dashql_catalog_load_script(dashql::Catalog* catalog, dashql::Script* script, size_t rank);
/// Atomically add or replace scripts using parallel arrays of wasm32 pointers and uint32 ranks.
extern "C" void dashql_catalog_load_scripts(dashql::Catalog* catalog, dashql::Script* const* scripts,
                                             const uint32_t* ranks, uint32_t script_count);
/// Drop script from the catalog
extern "C" void dashql_catalog_drop_script(dashql::Catalog* catalog, dashql::Script* script);
/// Get catalog statistics
extern "C" void dashql_catalog_get_statistics(FFIResult* result, dashql::Catalog* catalog);

// -----------------------------------------------------------------------------

/// Transcode a (constrained) Vega-Lite JSON spec into a VISUALIZE statement.
/// The result string is owned by the FFIResult and must be released via dashql_delete_owner.
extern "C" void dashql_parse_vegalite_to_visualize(FFIResult* result, const char* json_ptr, size_t json_length);

// -----------------------------------------------------------------------------

/// Create a plan view model
extern "C" void dashql_plan_view_model_new(FFIResult* result);
/// Configure a plan view model
extern "C" void dashql_plan_view_model_configure(dashql::PlanViewModel* view_model, double level_height,
                                                 double node_height, double node_margin_horizontal,
                                                 double node_padding_left, double node_padding_right, double icon_width,
                                                 double icon_margin_right, uint32_t max_label_chars,
                                                 double width_per_label_char, double min_node_width);
/// Load a Hyper plan (throws exception on error)
extern "C" void dashql_plan_view_model_load_hyper_plan(dashql::PlanViewModel* view_model, char* text_ptr,
                                                       size_t text_length);
/// Reset the plan view model
extern "C" void dashql_plan_view_model_reset(dashql::PlanViewModel* view_model);
/// Reset the plan view model execution
extern "C" void dashql_plan_view_model_reset_execution(dashql::PlanViewModel* view_model);
/// Pack the plan view model (throws exception on error)
extern "C" void dashql_plan_view_model_pack(FFIResult* result, dashql::PlanViewModel* view_model);
