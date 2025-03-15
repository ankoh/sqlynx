#pragma once

#include "ankerl/unordered_dense.h"
#include "dashql/catalog_object.h"
#include "dashql/proto/proto_generated.h"
#include "dashql/utils/chunk_buffer.h"
#include "dashql/utils/enum_bitset.h"
#include "dashql/utils/intrusive_list.h"

namespace dashql {

namespace sx = proto;

using NameTags = EnumBitset<uint8_t, proto::NameTag, proto::NameTag::MAX>;

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
    /// The coarse name tags resolved by the Analyzer.
    /// These tags are only available when the script was analyzed and are cleaned up when re-analyzing.
    /// Note that a name may occur in multiple situations so these tags only really provide a semantic hint.
    NameTags coarse_analyzer_tags;
    /// The catalog objects resolved by the Analyzer.
    /// These objects are only available when the script was analyzed and are cleaned up when re-analyzing.
    IntrusiveList<CatalogObject> resolved_objects;
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

}  // namespace dashql
