#pragma once

#include <unordered_set>

#include "flatsql/analyzer/pass_manager.h"
#include "flatsql/program.h"
#include "flatsql/proto/proto_generated.h"

namespace flatsql::schema {

struct ObjectName {
    /// The database
    std::optional<NameID> database;
    /// The schema
    std::optional<NameID> schema;
    /// The table
    std::optional<NameID> table;
};

struct ColumnInfo {
    /// A column
    std::optional<NameID> name;
    /// XXX Collect everything that we can get easily (type, keys, collation)
};

struct TableInfo {
    /// The name of the table
    ObjectName name;
    /// The columns
    std::vector<ColumnInfo> columns;
};

struct TableReference {
    /// The node id
    NodeID node_id;
    /// The table name
    ObjectName table_name;
    /// The table alias (if any)
    std::optional<NameID> table_alias;
};

struct ColumnReference {
    /// The node id
    NodeID node_id;
    /// The column name
    NameID column_name;

    using ExternalTableName = ObjectName;
    using LocalColumnDefintion = NodeID;
    /// The reference target (if resolved)
    std::optional<std::variant<ExternalTableName, LocalColumnDefintion>> target_table;
};

struct ColumnDefinition {
    /// The node id
    NodeID node_id;
    /// A column name (alias or external name id)
    std::optional<NameID> name;
};

}  // namespace flatsql::schema

namespace std {

template <> struct std::hash<flatsql::schema::ObjectName> {
    std::size_t operator()(flatsql::schema::ObjectName const& s) const noexcept { return 42; }
};

}  // namespace std
