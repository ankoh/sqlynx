#include <bitset>
#include <cstdint>
#include <limits>

namespace flatsql {

template <typename T> constexpr size_t UnsignedBitWidth() {
    T max = std::numeric_limits<T>::max();
    T value = 0b1;
    size_t width = 1;
    do {
        ++width;
        value = (value << 1) | 0b1;
    } while (value != max);
    return width;
}

}  // namespace flatsql
