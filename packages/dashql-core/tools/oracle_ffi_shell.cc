// Shell helpers of the differential test oracle (see tools/oracle_ffi.cc).
//
// The shell itself is driven through its C ABI (include/dashql/shell/api.h), which the oracle links. These
// helpers create the catalogs and catalog scripts a shell needs, and expose the Arrow renderer and the utf8proc
// functions that the shell uses, so that the Rust port can be compared on them directly.

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>
#include <span>
#include <string>
#include <string_view>

#include "dashql/catalog.h"
#include "dashql/exception.h"
#include "dashql/script.h"
#include "dashql/shell/arrow_renderer.h"
#include "utf8proc/utf8proc_wrapper.hpp"

using namespace dashql;

extern "C" {

/// The result of an oracle call, declared in tools/oracle_ffi.cc
struct DashQLOracleResult {
    uint32_t status;
    char* data;
    size_t length;
};

/// Create a catalog
void* dashql_oracle_catalog_new();
/// Destroy a catalog, after all its scripts
void dashql_oracle_catalog_destroy(void* catalog);
/// Analyze a script and load it into a catalog with a rank. Returns the script (release it with
/// dashql_oracle_catalog_script_destroy before the catalog), or null if the script cannot be loaded.
void* dashql_oracle_catalog_script_load(void* catalog, const char* text, size_t length, uint32_t rank);
/// Destroy a catalog script, which drops it from its catalog
void dashql_oracle_catalog_script_destroy(void* script);
/// Render Arrow IPC data like the shell (`ArrowRenderer::RenderIPC`). Status 1 carries the Arrow status text.
DashQLOracleResult dashql_oracle_shell_render_ipc(const uint8_t* data, size_t length, uint32_t terminal_columns);
/// `Utf8Proc::NextGraphemeCluster`
size_t dashql_oracle_utf8_next_grapheme(const char* text, size_t length, size_t offset);
/// `Utf8Proc::PreviousGraphemeCluster`
size_t dashql_oracle_utf8_previous_grapheme(const char* text, size_t length, size_t offset);
/// `Utf8Proc::RenderWidth(text, offset)`
size_t dashql_oracle_utf8_render_width(const char* text, size_t length, size_t offset);
}

namespace {

DashQLOracleResult ShellResult(uint32_t status, std::string_view out) {
    auto* data = static_cast<char*>(std::malloc(std::max<size_t>(out.size(), 1)));
    std::memcpy(data, out.data(), out.size());
    return DashQLOracleResult{.status = status, .data = data, .length = out.size()};
}

}  // namespace

void* dashql_oracle_catalog_new() { return new Catalog(); }

void dashql_oracle_catalog_destroy(void* catalog) { delete static_cast<Catalog*>(catalog); }

void* dashql_oracle_catalog_script_load(void* catalog, const char* text, size_t length, uint32_t rank) {
    try {
        auto script = std::make_unique<Script>(*static_cast<Catalog*>(catalog));
        script->InsertTextAt(0, std::string_view{text, length});
        script->Analyze();
        static_cast<Catalog*>(catalog)->LoadScript(*script, rank);
        return script.release();
    } catch (...) {
        return nullptr;
    }
}

void dashql_oracle_catalog_script_destroy(void* script) { delete static_cast<Script*>(script); }

DashQLOracleResult dashql_oracle_shell_render_ipc(const uint8_t* data, size_t length, uint32_t terminal_columns) {
    try {
        shell::ArrowRenderer renderer{terminal_columns};
        auto rendered = renderer.RenderIPC(std::span<const uint8_t>{data, length});
        if (!rendered.ok()) {
            return ShellResult(1, rendered.status().ToString());
        }
        return ShellResult(0, *rendered);
    } catch (const std::exception& e) {
        return ShellResult(2, e.what());
    } catch (...) {
        return ShellResult(2, "unknown exception");
    }
}

size_t dashql_oracle_utf8_next_grapheme(const char* text, size_t length, size_t offset) {
    // utf8proc reads one byte past the code point it decodes, provide a NUL terminator like std::string
    std::string buffer{text, length};
    return utf8::Utf8Proc::NextGraphemeCluster(buffer, offset);
}

size_t dashql_oracle_utf8_previous_grapheme(const char* text, size_t length, size_t offset) {
    std::string buffer{text, length};
    return utf8::Utf8Proc::PreviousGraphemeCluster(buffer, offset);
}

size_t dashql_oracle_utf8_render_width(const char* text, size_t length, size_t offset) {
    std::string buffer{text, length};
    return utf8::Utf8Proc::RenderWidth(buffer, offset);
}
