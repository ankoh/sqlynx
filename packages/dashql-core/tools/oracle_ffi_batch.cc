// Batch function of the differential test oracle (see tools/oracle_ffi.cc).

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <span>
#include <string_view>

#include "dashql/batch.h"
#include "dashql/exception.h"

extern "C" {

/// The result of an oracle call, declared in tools/oracle_ffi.cc
struct DashQLOracleResult {
    uint32_t status;
    char* data;
    size_t length;
};

/// Process a batch request (`ProcessBatch`) and return the BatchResult bytes
DashQLOracleResult dashql_oracle_batch(const uint8_t* request, size_t length);
}

namespace {

DashQLOracleResult BatchResult(uint32_t status, std::string_view out) {
    auto* data = static_cast<char*>(std::malloc(std::max<size_t>(out.size(), 1)));
    std::memcpy(data, out.data(), out.size());
    return DashQLOracleResult{.status = status, .data = data, .length = out.size()};
}

}  // namespace

DashQLOracleResult dashql_oracle_batch(const uint8_t* request, size_t length) {
    try {
        auto result = dashql::ProcessBatch(std::span<const uint8_t>{request, length});
        return BatchResult(0, std::string_view{reinterpret_cast<const char*>(result.data()), result.size()});
    } catch (const dashql::Exception& e) {
        return BatchResult(1, dashql::buffers::status::EnumNameStatusCode(e.GetCode()));
    } catch (const std::exception& e) {
        return BatchResult(1, e.what());
    } catch (...) {
        return BatchResult(1, "unknown exception");
    }
}
