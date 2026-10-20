// Script compiler function of the differential test oracle (see tools/oracle_ffi.cc).

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>
#include <string>
#include <string_view>

#include "dashql/catalog.h"
#include "dashql/exception.h"
#include "dashql/script.h"
#include "dashql/script_compiler.h"

using namespace dashql;

extern "C" {

/// The result of an oracle call, declared in tools/oracle_ffi.cc
struct DashQLOracleResult {
    uint32_t status;
    char* data;
    size_t length;
};

/// Compile a script with the default formatting config (after analyzing a catalog script, if `catalog_text` is not
/// null) and return the packed ScriptCompilationResult. The script is analyzed first if `analyze` is set.
DashQLOracleResult dashql_oracle_compile(const char* catalog_text, size_t catalog_length, const char* text, size_t length,
                                         uint8_t analyze, uint8_t allow_extensions);
}

namespace {

DashQLOracleResult CompilerResult(uint32_t status, std::string_view out) {
    auto* data = static_cast<char*>(std::malloc(std::max<size_t>(out.size(), 1)));
    std::memcpy(data, out.data(), out.size());
    return DashQLOracleResult{.status = status, .data = data, .length = out.size()};
}

}  // namespace

DashQLOracleResult dashql_oracle_compile(const char* catalog_text, size_t catalog_length, const char* text, size_t length,
                                         uint8_t analyze, uint8_t allow_extensions) {
    try {
        Catalog catalog;
        std::unique_ptr<Script> catalog_script;
        if (catalog_text != nullptr) {
            catalog_script = std::make_unique<Script>(catalog);
            catalog_script->InsertTextAt(0, std::string_view{catalog_text, catalog_length});
            catalog_script->Analyze();
            catalog.LoadScript(*catalog_script, catalog_script->GetCatalogEntryId());
        }
        Script script{catalog};
        script.InsertTextAt(0, std::string_view{text, length});
        if (analyze) script.Analyze();
        buffers::formatting::FormattingConfigT config;
        auto result = script.CompileQuery(config, ScriptCompilationOptions{.allow_extensions = allow_extensions != 0});
        flatbuffers::FlatBufferBuilder builder;
        builder.Finish(result.Pack(builder));
        return CompilerResult(0, std::string_view{reinterpret_cast<const char*>(builder.GetBufferPointer()), builder.GetSize()});
    } catch (const dashql::Exception& e) {
        return CompilerResult(1, buffers::status::EnumNameStatusCode(e.GetCode()));
    } catch (const std::exception& e) {
        return CompilerResult(1, e.what());
    } catch (...) {
        return CompilerResult(1, "unknown exception");
    }
}
