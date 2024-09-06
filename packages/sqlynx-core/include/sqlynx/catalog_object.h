#pragma once

#include "sqlynx/utils/intrusive_list.h"

namespace sqlynx {

/// A type of a catalog object
enum CatalogObjectType {
    DatabaseDeclaration = 1,
    DatabaseReference = 2,
    SchemaDeclaration = 3,
    SchemaReference = 4,
    TableDeclaration = 5,
    ColumnDeclaration = 6,
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
    T& CastUnsafe() {
        return *reinterpret_cast<T*>(this);
    }
};

}  // namespace sqlynx
