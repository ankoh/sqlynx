#pragma once

#include <type_traits>

#include "sqlynx/proto/proto_generated.h"

namespace sqlynx {

struct NameTags {
    using ValueType = uint8_t;

    /// The value
    ValueType value;
    /// Constructor
    NameTags(ValueType value = 0) : value(value) {}
    /// Constructor
    NameTags(proto::NameTag value) : value(static_cast<ValueType>(value)) {}
    /// Contains a name tag
    bool contains(proto::NameTag tag) const { return (value & static_cast<ValueType>(tag)) != 0; }
    /// Get the value
    operator ValueType() const { return value; }
    /// Tag a name
    NameTags& operator|=(proto::NameTag tag) {
        value |= static_cast<ValueType>(tag);
        return *this;
    }
    /// Tag a name
    NameTags& operator|=(NameTags tags) {
        value |= tags.value;
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

    template <typename Fn> void ForEach(Fn f) const {
        for (auto tag = proto::NameTag::KEYWORD; tag <= proto::NameTag::MAX;
             tag = static_cast<proto::NameTag>(static_cast<uint8_t>(tag) << 1)) {
            if (contains(tag)) {
                f(tag);
            }
        }
    }
};
static_assert(std::is_trivially_copyable<NameTags::ValueType>::value);
static_assert(sizeof(NameTags::ValueType) == sizeof(NameTags));
static_assert(sizeof(NameTags::ValueType) == sizeof(proto::NameTag));

}  // namespace sqlynx
