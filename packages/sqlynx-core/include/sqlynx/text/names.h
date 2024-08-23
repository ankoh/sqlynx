#pragma once

#include <type_traits>

#include "ankerl/unordered_dense.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/utils/chunk_buffer.h"
#include "sqlynx/utils/overlay_list.h"

namespace sqlynx {

namespace sx = proto;

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

/// A type of a catalog object
enum NamedObjectType {
    Database = 0,
    Schema = 1,
    Table = 2,
    Column = 3,
};

/// A catalog object
struct NamedObject {
    /// The object type
    NamedObjectType object_type;
    /// Constructor
    NamedObject(NamedObjectType type) : object_type(type) {}
};

/// An indexed name id
using RegisteredNameID = uint32_t;

/// A indexed name
struct RegisteredName {
    /// The unique name id within the schema
    RegisteredNameID name_id;
    /// The text
    std::string_view text;
    /// The location (if any)
    sx::Location location;
    /// The occurences
    size_t occurrences;
    /// The name tags resolved by the Analyzer.
    /// These tags are only available when the script was analyzed and are cleaned up when re-analyzing.
    NameTags resolved_tags;
    /// The catalog objects resolved by the Analyzer.
    /// These objects are only available when the script was analyzed and are cleaned up when re-analyzing.
    OverlayList<NamedObject> resolved_objects;
    /// Return the name text
    operator std::string_view() { return text; }
};

/// A name search index
struct NameRegistry {
    /// The names
    ChunkBuffer<RegisteredName, 32> names;
    /// The name infos by text
    ankerl::unordered_dense::map<std::string_view, std::reference_wrapper<RegisteredName>> names_by_text;

    /// Constructor
    NameRegistry() { names_by_text.reserve(64); }

    /// Get the chunks
    auto& GetChunks() const { return names.GetChunks(); }
    /// Get the chunks
    auto& GetChunks() { return names.GetChunks(); }
    /// Get the size
    size_t GetSize() const { return names.GetSize(); }
    /// Get the byte size
    size_t GetByteSize() const;

    /// Get the name
    RegisteredName& At(RegisteredNameID name_id);
    /// Register a name
    RegisteredName& Register(std::string_view s, sx::Location location = sx::Location(),
                             sx::NameTag tag = sx::NameTag::NONE);
    /// Register a name
    RegisteredName& Register(std::string_view s, NameTags tags);
};

}  // namespace sqlynx
