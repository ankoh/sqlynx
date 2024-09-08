#pragma once

#include "sqlynx/utils/intrusive_list.h"

namespace sqlynx {

/// A type of a catalog object
enum CatalogObjectType {
    DatabaseReference = 0,
    SchemaReference = 1,
    TableDeclaration = 2,
    ColumnDeclaration = 3,
};

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

}  // namespace sqlynx
