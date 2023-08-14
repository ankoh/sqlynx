#pragma once

#include <cassert>
#include <cstdint>
#include <limits>

#include "flatsql/utils/hash.h"

namespace flatsql {

/// A FlatBuffer identifier annotated with a context
struct QualifiedID {
   protected:
    /// The context id
    uint32_t context_id;
    /// The value
    uint32_t value;

   public:
    /// Constructor
    QualifiedID() : context_id(std::numeric_limits<uint32_t>::max()), value(std::numeric_limits<uint32_t>::max()) {}
    /// Constructor
    explicit QualifiedID(uint32_t context_id, uint32_t value) : context_id(context_id), value(value) {}
    /// Get the context identifier
    inline uint32_t GetContext() const { return context_id; }
    /// Get the index
    inline uint32_t GetIndex() const { return value; }
    /// Is a null id?
    inline bool IsNull() const { return GetIndex() == std::numeric_limits<uint32_t>::max(); }
    /// Is a null id?
    inline uint64_t Pack() const { return (static_cast<uint64_t>(context_id) << 32) | value; }

    /// Comparison
    bool operator==(const QualifiedID& other) const { return context_id == other.context_id && value == other.value; }
    /// A hasher
    struct Hasher {
        size_t operator()(const QualifiedID& key) const {
            size_t hash = 0;
            hash_combine(hash, key.context_id);
            hash_combine(hash, key.value);
            return hash;
        }
    };
};
}  // namespace flatsql
