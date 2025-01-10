#pragma once

#include <cassert>
#include <cstdint>
#include <limits>

#include "sqlynx/utils/hash.h"

namespace sqlynx {

using CatalogEntryID = uint32_t;

/// An identifier annotated with an external id
struct ContextObjectID {
    constexpr static CatalogEntryID KEYWORD_EXTERNAL_ID = 0xFFFFFFFF;

   protected:
    /// The external id
    CatalogEntryID external_id;
    /// The value
    uint32_t value;

   public:
    /// Constructor
    ContextObjectID()
        : external_id(std::numeric_limits<uint32_t>::max()), value(std::numeric_limits<uint32_t>::max()) {}
    /// Constructor
    explicit ContextObjectID(uint32_t origin, uint32_t value) : external_id(origin), value(value) {}
    /// Get the external identifier
    inline uint32_t GetContext() const { return external_id; }
    /// Get the index
    inline uint32_t GetObject() const { return value; }
    /// Is a null id?
    inline bool IsNull() const { return GetObject() == std::numeric_limits<uint32_t>::max(); }
    /// Is a null id?
    inline uint64_t Pack() const { return (static_cast<uint64_t>(external_id) << 32) | value; }

    /// Comparison
    bool operator==(const ContextObjectID& other) const {
        return external_id == other.external_id && value == other.value;
    }
    /// A hasher
    struct Hasher {
        size_t operator()(const ContextObjectID& key) const {
            size_t hash = 0;
            hash_combine(hash, key.external_id);
            hash_combine(hash, key.value);
            return hash;
        }
    };
};
}  // namespace sqlynx
