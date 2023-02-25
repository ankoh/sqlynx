#include <cstddef>
#include <cstdint>
#include <span>

namespace flatsql {

/// Taken from here:
/// https://github.com/rust-lang/rust/blob/master/library/core/src/num/mod.rs#L1016
constexpr bool isUTF8CodepointBoundary(std::byte b) {
    auto v = static_cast<uint8_t>(b);
    return v < 128 || v >= 192;
}    

constexpr bool isUTF8CodepointBoundary(std::span<const std::byte> buffer, size_t pos) {
    if (pos == 0 || pos == buffer.size()) {
        return true;
    } else if (pos > buffer.size()) {
        return false;
    } else {
        return isUTF8CodepointBoundary(buffer[pos]);
    }
}    

}
