#pragma once

#include <type_traits>

#include "flatsql/proto/proto_generated.h"

namespace flatsql {

struct NameTagBitmap {
    using ValueType = uint8_t;

    /// The value
    ValueType value;
    /// Constructor
    NameTagBitmap(ValueType value = 0) : value(value) {}
    /// Constructor
    NameTagBitmap(proto::NameTag value) : value(static_cast<ValueType>(value)) {}
    /// Get the value
    operator ValueType() const { return value; }
    /// Tag a name
    NameTagBitmap& operator|=(proto::NameTag tag) {
        value |= static_cast<ValueType>(tag);
        return *this;
    }
    /// Untag a name
    NameTagBitmap& operator^=(proto::NameTag tag) {
        value &= ~static_cast<ValueType>(tag);
        return *this;
    }
};
static_assert(std::is_trivially_copyable<NameTagBitmap::ValueType>::value);
static_assert(sizeof(NameTagBitmap::ValueType) == sizeof(NameTagBitmap));
static_assert(sizeof(NameTagBitmap::ValueType) == sizeof(proto::NameTag));

}  // namespace flatsql
