#pragma once

#include <cassert>
#include <cstdint>
#include <limits>

#include "sqlynx/utils/hash.h"

namespace sqlynx {

using ExternalID = uint32_t;

/// An identifier annotated with an external id
struct ExternalObjectID {
    constexpr static ExternalID KEYWORD_EXTERNAL_ID = 0xFFFFFFFF;

   protected:
    /// The external id
    ExternalID external_id;
    /// The value
    uint32_t value;

   public:
    /// Constructor
    ExternalObjectID()
        : external_id(std::numeric_limits<uint32_t>::max()), value(std::numeric_limits<uint32_t>::max()) {}
    /// Constructor
    explicit ExternalObjectID(uint32_t origin, uint32_t value) : external_id(origin), value(value) {}
    /// Get the external identifier
    inline uint32_t GetExternalId() const { return external_id; }
    /// Get the index
    inline uint32_t GetIndex() const { return value; }
    /// Is a null id?
    inline bool IsNull() const { return GetIndex() == std::numeric_limits<uint32_t>::max(); }
    /// Is a null id?
    inline uint64_t Pack() const { return (static_cast<uint64_t>(external_id) << 32) | value; }

    /// Comparison
    bool operator==(const ExternalObjectID& other) const {
        return external_id == other.external_id && value == other.value;
    }
    /// A hasher
    struct Hasher {
        size_t operator()(const ExternalObjectID& key) const {
            size_t hash = 0;
            hash_combine(hash, key.external_id);
            hash_combine(hash, key.value);
            return hash;
        }
    };
};
}  // namespace sqlynx
