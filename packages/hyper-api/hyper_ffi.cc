#include "hyper_ffi.h"

#include <limits>

#include <hyperapi/hyperapi.hpp>

#include <cstdlib>
#include <cstring>
#include <exception>
#include <string>
#include <unordered_map>

struct DashQLHyperProcess {
    hyperapi::HyperProcess process;
};

struct DashQLHyperConnection {
    hyperapi::Connection connection;
};

namespace {

char* CopyError(const std::string& text) {
    auto* out = static_cast<char*>(std::malloc(text.size() + 1));
    if (out == nullptr) return nullptr;
    std::memcpy(out, text.data(), text.size());
    out[text.size()] = 0;
    return out;
}

/// Run a function and translate any exception into an error text
template <typename Fn> char* Catch(Fn fn) noexcept {
    try {
        fn();
        return nullptr;
    } catch (const hyperapi::HyperException& e) {
        return CopyError(e.toString());
    } catch (const std::exception& e) {
        return CopyError(e.what());
    } catch (...) {
        return CopyError("unknown error");
    }
}

}  // namespace

extern "C" {

DashQLHyperProcess* dashql_hyper_process_start(const char* hyper_path, const char* user_agent,
                                               const char* const* parameter_names,
                                               const char* const* parameter_values, size_t parameter_count,
                                               char** error) {
    DashQLHyperProcess* out = nullptr;
    *error = Catch([&] {
        std::unordered_map<std::string, std::string> parameters;
        for (size_t i = 0; i < parameter_count; ++i) {
            parameters.insert_or_assign(parameter_names[i], parameter_values[i]);
        }
        out = new DashQLHyperProcess{hyperapi::HyperProcess{
            hyper_path,
            hyperapi::Telemetry::DoNotSendUsageDataToTableau,
            user_agent,
            parameters,
        }};
    });
    return out;
}

void dashql_hyper_process_stop(DashQLHyperProcess* process) { delete process; }

DashQLHyperConnection* dashql_hyper_connect(DashQLHyperProcess* process, const char* database_path, char** error) {
    DashQLHyperConnection* out = nullptr;
    *error = Catch([&] {
        out = new DashQLHyperConnection{hyperapi::Connection{
            process->process.getEndpoint(),
            database_path,
            hyperapi::CreateMode::CreateAndReplace,
        }};
    });
    return out;
}

void dashql_hyper_disconnect(DashQLHyperConnection* connection) { delete connection; }

char* dashql_hyper_execute_command(DashQLHyperConnection* connection, const char* command, size_t length) {
    return Catch([&] { connection->connection.executeCommand(std::string{command, length}); });
}

void dashql_hyper_free_error(char* error) { std::free(error); }

}  // extern "C"
