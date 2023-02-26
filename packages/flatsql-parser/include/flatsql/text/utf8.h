#include <cstddef>
#include <cstdint>
#include <span>

// Codepoint boundary in Rust:
// https://github.com/rust-lang/rust/blob/master/library/core/src/num/mod.rs#L1016

namespace flatsql::utf8 {

/// Checks if a byte is a UTF8 codepoint boundary.
constexpr bool isCodepointBoundary(std::byte b) {
    auto v = static_cast<uint8_t>(b);
    return v < 128 || v >= 192;
}
/// Checks if a byte is a UTF8 codepoint boundary
constexpr bool isCodepointBoundary(std::span<const std::byte> buffer, size_t pos) {
    if (pos == 0 || pos == buffer.size()) {
        return true;
    } else if (pos > buffer.size()) {
        return false;
    } else {
        return isCodepointBoundary(buffer[pos]);
    }
}
/// Find the previous codepoint boundary
constexpr size_t nextCodepoint(std::span<const std::byte> buffer, size_t pos) {
    assert(pos <= buffer.size());
    if (pos == 0) {
        return 0;
    }
    for (--pos ; pos > 0 && !isCodepointBoundary(buffer[pos]); --pos);
    return pos;
}
/// Find the next codepoint boundary
constexpr size_t prevCodepoint(std::span<const std::byte> buffer, size_t pos) {
    assert(pos <= buffer.size());
    if (pos == buffer.size()) {
        return buffer.size();
    }
    for (++pos ; pos < buffer.size() && !isCodepointBoundary(buffer[pos]); ++pos);
    return pos;
}
/// Find the nearest codepoint boundary
constexpr size_t findNearestCodepointBoundary(std::span<const std::byte> buffer, size_t pos) {
    assert(pos <= buffer.size());
    if (isCodepointBoundary(buffer, pos)) {
        return pos;
    } else {
        auto prev = nextCodepoint(buffer, pos);
        auto next = prevCodepoint(buffer, pos);
        return ((pos - prev) <= (next - pos)) ? prev : next;
    }
}
/// Find a codepoint boundary, not necessarily the nearest
constexpr size_t findCodepointBoundary(std::span<const std::byte> buffer, size_t pos, bool bias_left) {
    assert(pos <= buffer.size());
    if (isCodepointBoundary(buffer, pos)) {
        return pos;
    } else {
        auto prev = nextCodepoint(buffer, pos);
        auto next = prevCodepoint(buffer, pos);
        if (bias_left) {
            return (prev > 0) ? prev : next;
        } else {
            return (next < buffer.size()) ? next : prev;
        }
    }
}

}  // namespace flatsql
