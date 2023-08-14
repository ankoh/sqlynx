#pragma once

#include <cassert>
#include <cstdint>
#include <limits>

namespace flatsql {

constexpr bool allowZeroContext() {
#ifdef NDEBUG
    return true;
#else
    return false;
#endif
}

enum RawTag { Raw };

/// A FlatBuffer identifier annotated with a context
struct FID {
   protected:
    /// The context id
    uint32_t context_id;
    /// The value
    uint32_t value;

   public:
    /// Constructor
    explicit FID() : context_id(std::numeric_limits<uint32_t>::max()), value(std::numeric_limits<uint32_t>::max()) {}
    /// Constructor
    explicit FID(uint64_t raw, RawTag) : context_id(raw >> 32), value(raw & std::numeric_limits<uint32_t>::max()) {
        assert(allowZeroContext() || context_id != 0);
    }
    /// Constructor
    explicit FID(uint32_t context_id, uint32_t value) : context_id(context_id), value(value) {
        assert(context_id != 0);
    }
    /// Get the context identifier
    inline uint32_t GetContext() const { return context_id; }
    /// Get the index
    inline uint32_t GetIndex() const { return value; }
    /// Is a null id?
    inline bool IsNull() const { return GetIndex() == std::numeric_limits<uint32_t>::max(); }
    /// Convert to 64 bit integer
    operator uint64_t() const { return (static_cast<uint64_t>(context_id) << 32) | value; }
    /// Convert to bool
    operator bool() const { return !IsNull(); }
};
}  // namespace flatsql
