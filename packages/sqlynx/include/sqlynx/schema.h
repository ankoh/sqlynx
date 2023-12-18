#pragma once

#include <flatbuffers/buffer.h>
#include <flatbuffers/flatbuffer_builder.h>

#include <functional>
#include <limits>
#include <optional>
#include <string_view>
#include <tuple>

#include "ankerl/unordered_dense.h"
#include "sqlynx/context.h"
#include "sqlynx/parser/names.h"
#include "sqlynx/parser/parser.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/text/rope.h"
#include "sqlynx/utils/bits.h"
#include "sqlynx/utils/btree/map.h"
#include "sqlynx/utils/hash.h"
#include "sqlynx/utils/string_conversion.h"
#include "sqlynx/utils/string_pool.h"

namespace sqlynx {

constexpr uint32_t PROTO_NULL_U32 = std::numeric_limits<uint32_t>::max();

class SchemaSearchPath;

/// A schema stores database metadata.
/// It is used as a virtual container to expose table and column information to the analyzer.
class Schema {
   public:
    /// The name info
    struct NameInfo {
        /// The text
        std::string_view text;
        /// The location
        sx::Location location;
        /// The tags
        NameTags tags;
        /// The number of occurrences
        size_t occurrences = 0;
        /// Return the name text
        operator std::string_view() { return text; }
        /// Return the name text
        void operator|=(proto::NameTag tag) { tags |= tag; }
    };
    /// A qualified table name
    struct QualifiedTableName {
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The database name, may refer to different context
        std::string_view database_name;
        /// The schema name, may refer to different context
        std::string_view schema_name;
        /// The table name, may refer to different context
        std::string_view table_name;
        /// Constructor
        QualifiedTableName(std::optional<uint32_t> ast_node_id = std::nullopt, std::string_view database_name = {},
                           std::string_view schema_name = {}, std::string_view table_name = {})
            : ast_node_id(ast_node_id),
              database_name(database_name),
              schema_name(schema_name),
              table_name(table_name) {}
        /// Pack as FlatBuffer
        flatbuffers::Offset<proto::QualifiedTableName> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };
    /// A qualified column name
    struct QualifiedColumnName {
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The table alias, may refer to different context
        std::string_view table_alias;
        /// The column name, may refer to different context
        std::string_view column_name;
        /// Constructor
        QualifiedColumnName(std::optional<uint32_t> ast_node_id = std::nullopt, std::string_view table_alias = {},
                            std::string_view column_name = {})
            : ast_node_id(ast_node_id), table_alias(table_alias), column_name(column_name) {}
        /// Pack as FlatBuffer
        flatbuffers::Offset<proto::QualifiedColumnName> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };
    /// A table column
    struct TableColumn {
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The column name, may refer to different context
        std::string_view column_name;
        /// Constructor
        TableColumn(std::optional<uint32_t> ast_node_id, std::string_view column_name = {})
            : ast_node_id(ast_node_id), column_name(column_name) {}
        /// Pack as FlatBuffer
        flatbuffers::Offset<proto::TableColumn> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };
    /// A table
    struct Table {
        /// The table id
        ContextObjectID table_id;
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The AST statement id in the target script
        std::optional<uint32_t> ast_statement_id;
        /// The AST scope root id in the target script
        std::optional<uint32_t> ast_scope_root;
        /// The table name, may refer to different context
        QualifiedTableName table_name;
        /// The begin of the column
        uint32_t columns_begin;
        /// The column count
        uint32_t column_count;
        /// Constructor
        Table(ContextObjectID table_id = {}, std::optional<uint32_t> ast_node_id = std::nullopt,
              std::optional<uint32_t> ast_statement_id = {}, std::optional<uint32_t> ast_scope_root = {},
              QualifiedTableName table_name = {}, uint32_t columns_begin = 0, uint32_t column_count = 0)
            : table_id(table_id),
              ast_node_id(ast_node_id),
              ast_statement_id(ast_statement_id),
              ast_scope_root(ast_scope_root),
              table_name(table_name),
              columns_begin(columns_begin),
              column_count(column_count) {}
        /// Pack as FlatBuffer
        flatbuffers::Offset<proto::Table> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };
    /// A resolved table
    struct ResolvedTable {
        /// The database name
        std::string_view database_name;
        /// The schema name
        std::string_view schema_name;
        /// The table
        const Table& table;
        /// The table columns
        std::span<const TableColumn> table_columns;
    };
    /// A resolved table column
    struct ResolvedTableColumn : public ResolvedTable {
        /// The index in the table
        size_t table_column_index;
    };

   protected:
    /// The context id
    const uint32_t context_id;
    /// The database name (if any)
    const std::string database_name;
    /// The schema name (if any)
    const std::string schema_name;
    /// The local tables
    std::vector<Table> tables;
    /// The local table columns
    std::vector<TableColumn> table_columns;
    /// The tables, indexed by name
    std::unordered_multimap<std::string_view, std::reference_wrapper<Table>> tables_by_name;
    /// The table columns, indexed by the name
    std::unordered_multimap<std::string_view,
                            std::pair<std::reference_wrapper<Table>, std::reference_wrapper<TableColumn>>>
        table_columns_by_name;

   public:
    /// Construcutor
    Schema(uint32_t context_id, std::string database_name, std::string schema_name);

    /// Get the context id
    uint32_t GetContextId() const { return context_id; }
    /// Get the database name
    std::string_view GetDatabaseName() const { return database_name; }
    /// Get the schema name
    std::string_view GetSchemaName() const { return schema_name; }
    /// Get the tables
    std::span<const Table> GetTables() const { return tables; }
    /// Get the tables
    std::span<const TableColumn> GetTableColumns() const { return table_columns; }

    /// Get the name search index
    virtual btree::multimap<fuzzy_ci_string_view, std::reference_wrapper<const NameInfo>> GetNameSearchIndex()
        const = 0;

    /// Resolve a table by id
    std::optional<ResolvedTable> ResolveTable(ContextObjectID table_id) const;
    /// Resolve a table by id
    std::optional<ResolvedTable> ResolveTable(ContextObjectID table_id, const SchemaSearchPath& search_path) const;
    /// Resolve a table by name
    std::optional<ResolvedTable> ResolveTable(std::string_view table_name) const;
    /// Resolve a table by name
    std::optional<ResolvedTable> ResolveTable(QualifiedTableName table_name, const SchemaSearchPath& search_path) const;
    /// Find table columns by name
    void ResolveTableColumn(std::string_view table_column, std::vector<ResolvedTableColumn>& out) const;
    /// Find table columns by name
    void ResolveTableColumn(std::string_view table_column, const SchemaSearchPath& search_path,
                            std::vector<ResolvedTableColumn>& out) const;
};

class SchemaSearchPath {
   protected:
    /// The schemas
    std::vector<std::shared_ptr<Schema>> schemas;

   public:
    /// Create a copy of the schema search path.
    /// Every analyzed script has a lifetime dependency on the schema search path that was used to analyze it.
    /// We can later think about only extracting the real dependencies
    SchemaSearchPath CreateSnapshot() const { return {*this}; }

    /// Get the schemas
    auto& GetSchemas() const { return schemas; }
    /// Resolve a table by id
    std::optional<Schema::ResolvedTable> ResolveTable(ContextObjectID table_id) const;
    /// Resolve a table by id
    std::optional<Schema::ResolvedTable> ResolveTable(Schema::QualifiedTableName table_name) const;
    /// Find table columns by name
    void ResolveTableColumn(std::string_view table_column, std::vector<Schema::ResolvedTableColumn>& out) const;
};

}  // namespace sqlynx
