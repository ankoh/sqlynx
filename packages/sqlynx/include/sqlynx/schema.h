#pragma once

#include <flatbuffers/buffer.h>
#include <flatbuffers/flatbuffer_builder.h>

#include <functional>
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
#include "sqlynx/utils/hash.h"
#include "sqlynx/utils/string_pool.h"
#include "sqlynx/utils/suffix_trie.h"

namespace sqlynx {

constexpr uint32_t PROTO_NULL_U32 = 0xFFFFFFFF;

/// A schema stores database metadata.
/// It is used as a virtual container to expose table and column information to the analyzer.
class Schema {
   public:
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
        TableColumn(std::optional<uint32_t> ast_node_id = std::nullopt, std::string_view column_name = {})
            : ast_node_id(ast_node_id), column_name(column_name) {}
        /// Pack as FlatBuffer
        flatbuffers::Offset<proto::TableColumn> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };
    /// A table
    struct Table {
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
        Table(std::optional<uint32_t> ast_node_id = std::nullopt, std::optional<uint32_t> ast_statement_id = {},
              std::optional<uint32_t> ast_scope_root = {}, QualifiedTableName table_name = {},
              uint32_t columns_begin = 0, uint32_t column_count = 0)
            : ast_node_id(ast_node_id),
              ast_statement_id(ast_statement_id),
              ast_scope_root(ast_scope_root),
              table_name(table_name),
              columns_begin(columns_begin),
              column_count(column_count) {}
        /// Pack as FlatBuffer
        flatbuffers::Offset<proto::Table> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };

    /// The context id
    const uint32_t context_id;
    /// The local tables
    std::vector<Table> tables;
    /// The local table columns
    std::vector<TableColumn> table_columns;

    /// Construcutor
    Schema(uint32_t context_id);

    /// Get a table by id
    std::optional<std::pair<std::reference_wrapper<const Schema::Table>, std::span<const Schema::TableColumn>>>
    FindTable(QualifiedID table_id) const;
};

}  // namespace sqlynx
