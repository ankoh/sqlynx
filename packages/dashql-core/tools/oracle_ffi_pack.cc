// Script packing function of the differential test oracle (see tools/oracle_ffi.cc).

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

using namespace dashql;

extern "C" {

/// The result of an oracle call, declared in tools/oracle_ffi.cc
struct DashQLOracleResult {
    uint32_t status;
    char* data;
    size_t length;
};

/// Analyze a script (after a catalog script, if `catalog_text` is not null) and pack its scanned (0), parsed (1) or
/// analyzed (2) script as FlatBuffer.
DashQLOracleResult dashql_oracle_pack(const char* catalog_text, size_t catalog_length, const char* text, size_t length,
                                      uint32_t what);
}

namespace {

DashQLOracleResult PackResult(uint32_t status, std::string_view out) {
    auto* data = static_cast<char*>(std::malloc(std::max<size_t>(out.size(), 1)));
    std::memcpy(data, out.data(), out.size());
    return DashQLOracleResult{.status = status, .data = data, .length = out.size()};
}

}  // namespace

DashQLOracleResult dashql_oracle_pack(const char* catalog_text, size_t catalog_length, const char* text, size_t length,
                                      uint32_t what) {
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
        script.Analyze();
        flatbuffers::FlatBufferBuilder builder;
        switch (what) {
            case 0:
                builder.Finish(script.scanned_script->Pack(builder));
                break;
            case 1:
                builder.Finish(script.parsed_script->Pack(builder));
                break;
            default:
                builder.Finish(script.analyzed_script->Pack(builder));
                break;
        }
        return PackResult(0, std::string_view{reinterpret_cast<const char*>(builder.GetBufferPointer()), builder.GetSize()});
    } catch (const dashql::Exception& e) {
        return PackResult(1, buffers::status::EnumNameStatusCode(e.GetCode()));
    } catch (const std::exception& e) {
        return PackResult(1, e.what());
    } catch (...) {
        return PackResult(1, "unknown exception");
    }
}
