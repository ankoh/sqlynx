#pragma once

#include "dashql/proto/proto_generated.h"
#include "dashql/utils/intrusive_list.h"

namespace dashql {

/// A type of a catalog object
enum CatalogObjectType {
    DatabaseReference = 1,
    SchemaReference = 2,
    TableDeclaration = 3,
    ColumnDeclaration = 4,
};
static_assert(static_cast<uint8_t>(proto::CompletionCandidateObjectType::COLUMN) ==
              CatalogObjectType::ColumnDeclaration);
static_assert(static_cast<uint8_t>(proto::CompletionCandidateObjectType::DATABASE) ==
              CatalogObjectType::DatabaseReference);
static_assert(static_cast<uint8_t>(proto::CompletionCandidateObjectType::SCHEMA) == CatalogObjectType::SchemaReference);
static_assert(static_cast<uint8_t>(proto::CompletionCandidateObjectType::TABLE) == CatalogObjectType::TableDeclaration);

/// A catalog object
struct CatalogObject : public IntrusiveListNode {
    /// The object type
    CatalogObjectType object_type;
    /// Constructor
    CatalogObject(CatalogObjectType type) : IntrusiveListNode(), object_type(type) {}

    /// Cast to monostate object
    const CatalogObject& CastToBase() const { return *reinterpret_cast<const CatalogObject*>(this); }
    /// Cast to monostate object
    CatalogObject& CastToBase() { return *reinterpret_cast<CatalogObject*>(this); }
    /// Cast unsafely to specific child object
    template <typename T, typename std::enable_if<std::is_base_of<CatalogObject, T>::value>::type* = nullptr>
    const T& CastUnsafe() const {
        return *reinterpret_cast<const T*>(this);
    }
};

}  // namespace dashql
