// A minimal C ABI over the Tableau Hyper API for callers that cannot use its C++ SDK (the Rust tests).
//
// No function throws. Failing calls return null (or an error) and hand out the error text as a NUL-terminated
// string that the caller releases with dashql_hyper_free_error.

#pragma once

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct DashQLHyperProcess DashQLHyperProcess;
typedef struct DashQLHyperConnection DashQLHyperConnection;

/// Start a Hyper process with telemetry disabled.
/// `hyper_path` is the directory containing hyperd, the parameters are `parameter_count` name/value pairs.
/// Returns null and sets `*error` on failure.
DashQLHyperProcess* dashql_hyper_process_start(const char* hyper_path, const char* user_agent,
                                               const char* const* parameter_names,
                                               const char* const* parameter_values, size_t parameter_count,
                                               char** error);
/// Shut down a Hyper process. Its connections must be closed before.
void dashql_hyper_process_stop(DashQLHyperProcess* process);

/// Connect to a database of the process, creating or replacing the database file at `database_path`.
/// Returns null and sets `*error` on failure.
DashQLHyperConnection* dashql_hyper_connect(DashQLHyperProcess* process, const char* database_path, char** error);
/// Close a connection.
void dashql_hyper_disconnect(DashQLHyperConnection* connection);

/// Execute one SQL command. Returns null on success and the error text otherwise.
char* dashql_hyper_execute_command(DashQLHyperConnection* connection, const char* command, size_t length);

/// Release an error text.
void dashql_hyper_free_error(char* error);

#ifdef __cplusplus
}
#endif
