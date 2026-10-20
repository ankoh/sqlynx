// Editor session and script execution functions of the differential test oracle (see tools/oracle_ffi.cc).
//
// Unlike the other oracle functions, these are stateful: the caller creates a catalog, sessions on it and
// executions of sessions, and drives them step by step. Sessions must be deleted before their catalog, executions
// before their session. Calls that answer with a FlatBuffer return the packed buffer; failures return status 1 with
// `status:<StatusCode name>` for dashql::Exception and `error:<what()>` for other exceptions.

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include "dashql/catalog.h"
#include "dashql/exception.h"
#include "dashql/script.h"
#include "dashql/script_compiler.h"
#include "dashql/script_execution.h"
#include "dashql/script_session.h"

using namespace dashql;

extern "C" {

/// The result of an oracle call, declared in tools/oracle_ffi.cc
struct DashQLOracleResult {
    uint32_t status;
    char* data;
    size_t length;
};

/// Create a catalog
void* dashql_oracle_session_catalog_new();
/// Delete a catalog
void dashql_oracle_session_catalog_delete(void* catalog);
/// The version of a catalog
uint64_t dashql_oracle_session_catalog_version(void* catalog);
/// Create a session with an offset unit (0 = UTF-8 bytes, 1 = UTF-16 code units)
void* dashql_oracle_session_new(void* catalog, uint8_t offset_unit);
/// Delete a session, which drops its script from the catalog
void dashql_oracle_session_delete(void* session);
/// The text, text version, state revision and entry id of a session: little-endian u64 text version, u64 state
/// revision, u32 entry id, then the text
DashQLOracleResult dashql_oracle_session_state(void* session);
/// Apply a packed EditorEvent and return the packed EditorUpdate
DashQLOracleResult dashql_oracle_session_apply(void* session, const uint8_t* event, size_t length);
/// Replace the text and return the packed EditorUpdate
DashQLOracleResult dashql_oracle_session_replace_text(void* session, uint64_t expected_text_version, const char* text,
                                                      size_t length);
/// Move the primary cursor and return the packed EditorUpdate
DashQLOracleResult dashql_oracle_session_set_primary_cursor(void* session, uint64_t expected_text_version,
                                                            uint64_t offset);
/// Analyze and return the packed EditorUpdate
DashQLOracleResult dashql_oracle_session_analyze(void* session);
/// Complete at the cursor and return the packed Completion
DashQLOracleResult dashql_oracle_session_complete(void* session, size_t limit, uint8_t keyword_case);
/// Compile with a packed FormattingConfig and return the packed ScriptCompilationResult
DashQLOracleResult dashql_oracle_session_compile(void* session, const uint8_t* config, size_t config_length,
                                                 uint8_t allow_extensions, uint8_t parse_if_outdated);
/// Format with a packed FormattingConfig into a new script of the session catalog: a little-endian u32 with the entry
/// id of the new script, then its text
DashQLOracleResult dashql_oracle_session_format(void* session, const uint8_t* config, size_t config_length,
                                                uint8_t parse_if_outdated);
/// Is the script fully formattable with a packed FormattingConfig? Returns "0" or "1"
DashQLOracleResult dashql_oracle_session_is_fully_formattable(void* session, const uint8_t* config,
                                                              size_t config_length, uint8_t parse_if_outdated);
/// Rewrite the dashboard clause, negative row and column mean none (like the C API)
DashQLOracleResult dashql_oracle_session_rewrite_dashboard(void* session, int32_t row, int32_t column, int32_t width,
                                                           int32_t height, uint8_t parse_if_outdated);
/// Diff against a new parsed target script of the session catalog and return the packed ScriptDiff
DashQLOracleResult dashql_oracle_session_diff(void* session, const char* target, size_t length);
/// Load the script into the catalog, returns an empty result
DashQLOracleResult dashql_oracle_session_load(void* session, uint32_t rank);
/// Drop the script from the catalog
void dashql_oracle_session_drop(void* session);
/// The text of the first statement of the session script (`Script::GetStatementText`)
DashQLOracleResult dashql_oracle_session_statement_text(void* session, uint8_t parse_if_outdated);
/// Create an execution of a session with a packed FormattingConfig, null if it throws
void* dashql_oracle_execution_new(void* session, const uint8_t* config, size_t config_length);
/// Delete an execution
void dashql_oracle_execution_delete(void* execution);
/// Start an execution and return the packed ScriptExecutionUpdate
DashQLOracleResult dashql_oracle_execution_start(void* execution);
/// Resume an execution with a packed StatementResult and return the packed ScriptExecutionUpdate
DashQLOracleResult dashql_oracle_execution_resume(void* execution, const uint8_t* result, size_t length);
/// Cancel an execution and return the packed ScriptExecutionUpdate
DashQLOracleResult dashql_oracle_execution_cancel(void* execution);
}

namespace {

DashQLOracleResult SessionResult(uint32_t status, std::string_view out) {
    auto* data = static_cast<char*>(std::malloc(std::max<size_t>(out.size(), 1)));
    std::memcpy(data, out.data(), out.size());
    return DashQLOracleResult{.status = status, .data = data, .length = out.size()};
}

template <typename Fn> DashQLOracleResult Guard(Fn&& fn) {
    try {
        return SessionResult(0, fn());
    } catch (const dashql::Exception& e) {
        return SessionResult(1, std::string{"status:"} + buffers::status::EnumNameStatusCode(e.GetCode()));
    } catch (const std::exception& e) {
        return SessionResult(1, std::string{"error:"} + e.what());
    } catch (...) {
        return SessionResult(1, "error:unknown exception");
    }
}

template <typename T> std::string Finish(flatbuffers::FlatBufferBuilder& builder, flatbuffers::Offset<T> offset) {
    builder.Finish(offset);
    return std::string{reinterpret_cast<const char*>(builder.GetBufferPointer()), builder.GetSize()};
}

std::string PackUpdate(const buffers::editor::EditorUpdateT& update) {
    flatbuffers::FlatBufferBuilder builder;
    return Finish(builder, buffers::editor::EditorUpdate::Pack(builder, &update));
}

std::string PackExecutionUpdate(const buffers::execution::ScriptExecutionUpdateT& update) {
    flatbuffers::FlatBufferBuilder builder;
    return Finish(builder, buffers::execution::ScriptExecutionUpdate::Pack(builder, &update));
}

buffers::formatting::FormattingConfigT ReadConfig(const uint8_t* config, size_t length) {
    flatbuffers::Verifier verifier{config, length};
    if (!verifier.VerifyBuffer<buffers::formatting::FormattingConfig>(nullptr)) {
        throw std::invalid_argument("invalid FormattingConfig FlatBuffer");
    }
    buffers::formatting::FormattingConfigT out;
    flatbuffers::GetRoot<buffers::formatting::FormattingConfig>(config)->UnPackTo(&out);
    return out;
}

template <typename T> void AppendInteger(std::string& out, T value) {
    out.append(reinterpret_cast<const char*>(&value), sizeof(T));
}

auto* AsCatalog(void* catalog) { return static_cast<Catalog*>(catalog); }
auto* AsSession(void* session) { return static_cast<ScriptSession*>(session); }
auto* AsExecution(void* execution) { return static_cast<execution::ScriptExecution*>(execution); }

}  // namespace

void* dashql_oracle_session_catalog_new() { return new Catalog(); }

void dashql_oracle_session_catalog_delete(void* catalog) { delete AsCatalog(catalog); }

uint64_t dashql_oracle_session_catalog_version(void* catalog) { return AsCatalog(catalog)->GetVersion(); }

void* dashql_oracle_session_new(void* catalog, uint8_t offset_unit) {
    return new ScriptSession(*AsCatalog(catalog), static_cast<buffers::editor::EditorOffsetUnit>(offset_unit));
}

void dashql_oracle_session_delete(void* session) { delete AsSession(session); }

DashQLOracleResult dashql_oracle_session_state(void* session) {
    return Guard([&]() {
        auto* s = AsSession(session);
        std::string out;
        AppendInteger<uint64_t>(out, s->GetTextVersion());
        AppendInteger<uint64_t>(out, s->GetStateRevision());
        AppendInteger<uint32_t>(out, s->GetCatalogEntryId());
        out.append(s->GetText());
        return out;
    });
}

DashQLOracleResult dashql_oracle_session_apply(void* session, const uint8_t* event, size_t length) {
    return Guard([&]() {
        flatbuffers::Verifier verifier{event, length};
        if (!verifier.VerifyBuffer<buffers::editor::EditorEvent>(nullptr)) {
            throw std::invalid_argument("invalid EditorEvent FlatBuffer");
        }
        std::unique_ptr<buffers::editor::EditorEventT> unpacked{
            flatbuffers::GetRoot<buffers::editor::EditorEvent>(event)->UnPack()};
        return PackUpdate(AsSession(session)->Apply(*unpacked));
    });
}

DashQLOracleResult dashql_oracle_session_replace_text(void* session, uint64_t expected_text_version, const char* text,
                                                      size_t length) {
    return Guard([&]() {
        return PackUpdate(AsSession(session)->ReplaceText(expected_text_version, std::string_view{text, length}));
    });
}

DashQLOracleResult dashql_oracle_session_set_primary_cursor(void* session, uint64_t expected_text_version,
                                                            uint64_t offset) {
    return Guard([&]() { return PackUpdate(AsSession(session)->SetPrimaryCursor(expected_text_version, offset)); });
}

DashQLOracleResult dashql_oracle_session_analyze(void* session) {
    return Guard([&]() { return PackUpdate(AsSession(session)->Analyze()); });
}

DashQLOracleResult dashql_oracle_session_complete(void* session, size_t limit, uint8_t keyword_case) {
    return Guard([&]() {
        flatbuffers::FlatBufferBuilder builder;
        return Finish(builder, AsSession(session)->PackCompletion(
                                   builder, limit, static_cast<buffers::formatting::KeywordCase>(keyword_case)));
    });
}

DashQLOracleResult dashql_oracle_session_compile(void* session, const uint8_t* config, size_t config_length,
                                                 uint8_t allow_extensions, uint8_t parse_if_outdated) {
    return Guard([&]() {
        auto result =
            AsSession(session)->CompileQuery(ReadConfig(config, config_length), allow_extensions != 0, parse_if_outdated != 0);
        flatbuffers::FlatBufferBuilder builder;
        return Finish(builder, result.Pack(builder));
    });
}

DashQLOracleResult dashql_oracle_session_format(void* session, const uint8_t* config, size_t config_length,
                                                uint8_t parse_if_outdated) {
    return Guard([&]() {
        auto formatted = AsSession(session)->Format(ReadConfig(config, config_length), parse_if_outdated != 0);
        std::string out;
        AppendInteger<uint32_t>(out, formatted->GetCatalogEntryId());
        out.append(formatted->ToString());
        return out;
    });
}

DashQLOracleResult dashql_oracle_session_is_fully_formattable(void* session, const uint8_t* config,
                                                              size_t config_length, uint8_t parse_if_outdated) {
    return Guard([&]() {
        return std::string{
            AsSession(session)->IsFullyFormattable(ReadConfig(config, config_length), parse_if_outdated != 0) ? "1"
                                                                                                              : "0"};
    });
}

DashQLOracleResult dashql_oracle_session_rewrite_dashboard(void* session, int32_t row, int32_t column, int32_t width,
                                                           int32_t height, uint8_t parse_if_outdated) {
    return Guard([&]() {
        return AsSession(session)->RewriteDashboard(row < 0 ? std::nullopt : std::optional<int32_t>{row},
                                                    column < 0 ? std::nullopt : std::optional<int32_t>{column},
                                                    width, height, parse_if_outdated != 0);
    });
}

DashQLOracleResult dashql_oracle_session_diff(void* session, const char* target, size_t length) {
    return Guard([&]() {
        auto* s = AsSession(session);
        Script target_script{s->GetScript().GetCatalog()};
        target_script.ReplaceText(std::string_view{target, length});
        target_script.Parse();
        flatbuffers::FlatBufferBuilder builder;
        return Finish(builder, s->PackDiff(builder, target_script));
    });
}

DashQLOracleResult dashql_oracle_session_load(void* session, uint32_t rank) {
    return Guard([&]() {
        AsSession(session)->LoadIntoCatalog(rank);
        return std::string{};
    });
}

void dashql_oracle_session_drop(void* session) { AsSession(session)->DropFromCatalog(); }

DashQLOracleResult dashql_oracle_session_statement_text(void* session, uint8_t parse_if_outdated) {
    return Guard([&]() { return AsSession(session)->GetScript().GetStatementText(parse_if_outdated != 0); });
}

void* dashql_oracle_execution_new(void* session, const uint8_t* config, size_t config_length) {
    try {
        return new execution::ScriptExecution(*AsSession(session), ReadConfig(config, config_length));
    } catch (...) {
        return nullptr;
    }
}

void dashql_oracle_execution_delete(void* execution) { delete AsExecution(execution); }

DashQLOracleResult dashql_oracle_execution_start(void* execution) {
    return Guard([&]() { return PackExecutionUpdate(AsExecution(execution)->Start()); });
}

DashQLOracleResult dashql_oracle_execution_resume(void* execution, const uint8_t* result, size_t length) {
    return Guard([&]() {
        flatbuffers::Verifier verifier{result, length};
        if (!verifier.VerifyBuffer<buffers::execution::StatementResult>(nullptr)) {
            throw std::invalid_argument("invalid StatementResult FlatBuffer");
        }
        std::unique_ptr<buffers::execution::StatementResultT> unpacked{
            flatbuffers::GetRoot<buffers::execution::StatementResult>(result)->UnPack()};
        return PackExecutionUpdate(AsExecution(execution)->Resume(*unpacked));
    });
}

DashQLOracleResult dashql_oracle_execution_cancel(void* execution) {
    return Guard([&]() { return PackExecutionUpdate(AsExecution(execution)->Cancel()); });
}
