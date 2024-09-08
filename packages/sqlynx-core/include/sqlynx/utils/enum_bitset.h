#pragma once

#include <cstddef>
#include <initializer_list>
#include <type_traits>

namespace sqlynx {

template <typename ValueType, typename EnumType, EnumType MaxEnum,
          typename std::enable_if<std::is_enum<EnumType>::value>::type* = nullptr>
struct EnumBitset {
    static_assert(std::is_trivially_copyable<ValueType>::value);

    /// The value
    ValueType value;
    /// Constructor
    EnumBitset(ValueType value = 0) : value(value) {}
    /// Constructor
    EnumBitset(EnumType value) : value(static_cast<ValueType>(value)) {}
    /// Constructor
    EnumBitset(std::initializer_list<EnumType> values) : value(0) {
        for (auto v : values) {
            value |= static_cast<ValueType>(v);
        }
    }
    /// Contains a name tag
    bool contains(EnumType tag) const { return (value & static_cast<ValueType>(tag)) != 0; }
    /// Get the value
    operator ValueType() const { return value; }
    /// Tag a name
    EnumBitset& operator|=(EnumType tag) {
        value |= static_cast<ValueType>(tag);
        return *this;
    }
    /// Tag a name
    EnumBitset& operator|=(EnumBitset tags) {
        value |= tags.value;
        return *this;
    }
    /// Tag a name
    EnumBitset operator|(EnumType tag) {
        ValueType v = value | static_cast<ValueType>(tag);
        return EnumBitset{v};
    }
    /// Untag a name
    EnumBitset& operator^=(EnumType tag) {
        value &= ~static_cast<ValueType>(tag);
        return *this;
    }

    template <typename Fn> void ForEach(Fn f) const {
        for (ValueType tag = 1; tag <= static_cast<ValueType>(MaxEnum); tag = static_cast<ValueType>(tag) << 1) {
            if (contains(static_cast<EnumType>(tag))) {
                f(static_cast<EnumType>(tag));
            }
        }
    }
};

}  // namespace sqlynx
