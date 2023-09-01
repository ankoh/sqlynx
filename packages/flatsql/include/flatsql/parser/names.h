#pragma once

#include "flatsql/proto/proto_generated.h"

namespace flatsql {

struct NameTagBitmap {
    /// The value
    uint64_t value;
    /// Constructor
    NameTagBitmap(uint64_t value) : value(value) {}
    /// Constructor
    NameTagBitmap(proto::NameTag value) : value(static_cast<uint64_t>(value)) {}
    /// Get the value
    operator uint64_t() const { return value; }
    /// Tag a name
    NameTagBitmap& operator|=(proto::NameTag tag) {
        value |= static_cast<uint64_t>(tag);
        return *this;
    }
    /// Untag a name
    NameTagBitmap& operator^=(proto::NameTag tag) {
        value &= ~static_cast<uint64_t>(tag);
        return *this;
    }
};

}  // namespace flatsql
