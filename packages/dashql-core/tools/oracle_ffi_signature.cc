// Script signature function of the differential test oracle (see tools/oracle_ffi.cc).

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>
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

/// Compute the signature of a script (`Script::ComputeSignature`)
DashQLOracleResult dashql_oracle_signature(const char* text, size_t length);
}

namespace {

DashQLOracleResult SignatureResult(uint32_t status, std::string_view out) {
    auto* data = static_cast<char*>(std::malloc(std::max<size_t>(out.size(), 1)));
    std::memcpy(data, out.data(), out.size());
    return DashQLOracleResult{.status = status, .data = data, .length = out.size()};
}

}  // namespace

DashQLOracleResult dashql_oracle_signature(const char* text, size_t length) {
    try {
        Catalog catalog;
        Script script{catalog};
        script.InsertTextAt(0, std::string_view{text, length});
        return SignatureResult(0, script.ComputeSignature(true));
    } catch (const dashql::Exception& e) {
        return SignatureResult(1, buffers::status::EnumNameStatusCode(e.GetCode()));
    } catch (const std::exception& e) {
        return SignatureResult(1, e.what());
    } catch (...) {
        return SignatureResult(1, "unknown exception");
    }
}
