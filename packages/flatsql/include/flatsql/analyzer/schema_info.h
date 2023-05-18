#pragma once

#include "flatsql/analyzer/pass_manager.h"
#include "flatsql/program.h"
#include "flatsql/proto/proto_generated.h"

namespace flatsql::schema {

struct QualifiedTableName {
    /// The node id
    std::optional<NodeID> node_id;
    /// The database
    std::optional<NameID> database;
    /// The schema
    std::optional<NameID> schema;
    /// The table
    std::optional<NameID> table;
};

struct QualifiedColumnName : public QualifiedTableName {
    /// The column
    std::optional<NameID> column;
};

struct ExternalColumnInfo {
    /// A column
    std::optional<NameID> name;
    /// XXX Collect everything that we can get easily (type, keys, collation)
};

struct ExternalTableInfo {
    /// The name of the table
    QualifiedTableName name;
    /// The columns
    std::vector<ExternalColumnInfo> columns;
};

struct ColumnDefinition {
    /// The node id
    NodeID node_id;
    /// The table alias (if any)
    std::optional<NameID> column_alias;
};

struct TableDefinition {
    /// The node id
    NodeID node_id;
    /// The table alias (if any)
    std::optional<NameID> table_alias;
    /// The columns
    std::vector<ColumnDefinition> columns;
};

struct TableReference {
    /// The node id
    NodeID node_id;
    /// The table name
    QualifiedTableName table_name;
    /// The table alias
    std::optional<NodeID> table_alias;
    /// Constructor
    TableReference(NodeID node_id, QualifiedTableName name, std::optional<NodeID> table_alias = std::nullopt)
        : node_id(node_id), table_name(name), table_alias(table_alias) {}
};

struct ColumnReference {
    /// The node id
    NodeID node_id;
    /// The column name
    QualifiedColumnName column_name;
    /// Constructor
    ColumnReference(NodeID node_id, QualifiedColumnName name) : node_id(node_id), column_name(name) {}
};

}  // namespace flatsql::schema

namespace std {

template <> struct hash<flatsql::schema::QualifiedTableName> {
    std::size_t operator()(flatsql::schema::QualifiedTableName const& s) const noexcept { return 42; }
};

}  // namespace std
