#pragma once

#include <cstddef>
#include <cstdint>
#include <type_traits>

namespace sqlynx {

template <typename T> constexpr size_t UnsignedBitWidth() {
    if constexpr (std::is_same_v<T, uint64_t>) return 64;
    if constexpr (std::is_same_v<T, uint32_t>) return 32;
    if constexpr (std::is_same_v<T, uint16_t>) return 16;
    if constexpr (std::is_same_v<T, uint8_t>) return 8;
    __builtin_unreachable();
}

}  // namespace sqlynx
