#pragma once

#include <cassert>
#include <cstdint>
#include <limits>

#include "sqlynx/utils/hash.h"

namespace sqlynx {

using OriginID = uint32_t;

/// An identifier annotated with a global context id
struct GlobalObjectID {
    constexpr static OriginID KEYWORD_ORIGIN_ID = 0xFFFFFFFF;

   protected:
    /// The origin
    OriginID origin;
    /// The value
    uint32_t value;

   public:
    /// Constructor
    GlobalObjectID() : origin(std::numeric_limits<uint32_t>::max()), value(std::numeric_limits<uint32_t>::max()) {}
    /// Constructor
    explicit GlobalObjectID(uint32_t origin, uint32_t value) : origin(origin), value(value) {}
    /// Get the context identifier
    inline uint32_t GetOrigin() const { return origin; }
    /// Get the index
    inline uint32_t GetIndex() const { return value; }
    /// Is a null id?
    inline bool IsNull() const { return GetIndex() == std::numeric_limits<uint32_t>::max(); }
    /// Is a null id?
    inline uint64_t Pack() const { return (static_cast<uint64_t>(origin) << 32) | value; }

    /// Comparison
    bool operator==(const GlobalObjectID& other) const { return origin == other.origin && value == other.value; }
    /// A hasher
    struct Hasher {
        size_t operator()(const GlobalObjectID& key) const {
            size_t hash = 0;
            hash_combine(hash, key.origin);
            hash_combine(hash, key.value);
            return hash;
        }
    };
};
}  // namespace sqlynx
