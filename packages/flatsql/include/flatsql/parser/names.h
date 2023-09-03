#pragma once

#include <type_traits>

#include "flatsql/proto/proto_generated.h"

namespace flatsql {

struct NameTags {
    using ValueType = uint8_t;

    /// The value
    ValueType value;
    /// Constructor
    NameTags(ValueType value = 0) : value(value) {}
    /// Constructor
    NameTags(proto::NameTag value) : value(static_cast<ValueType>(value)) {}
    /// Get the value
    operator ValueType() const { return value; }
    /// Tag a name
    NameTags& operator|=(proto::NameTag tag) {
        value |= static_cast<ValueType>(tag);
        return *this;
    }
    /// Tag a name
    NameTags operator|(proto::NameTag tag) {
        ValueType v = value | static_cast<ValueType>(tag);
        return NameTags{v};
    }
    /// Untag a name
    NameTags& operator^=(proto::NameTag tag) {
        value &= ~static_cast<ValueType>(tag);
        return *this;
    }
};
static_assert(std::is_trivially_copyable<NameTags::ValueType>::value);
static_assert(sizeof(NameTags::ValueType) == sizeof(NameTags));
static_assert(sizeof(NameTags::ValueType) == sizeof(proto::NameTag));

}  // namespace flatsql
