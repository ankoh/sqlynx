#pragma once

#include <flatbuffers/buffer.h>

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
        QualifiedID database_name;
        /// The schema name, may refer to different context
        QualifiedID schema_name;
        /// The table name, may refer to different context
        QualifiedID table_name;
        /// Constructor
        QualifiedTableName(std::optional<uint32_t> ast_node_id = std::nullopt, QualifiedID database_name = {},
                           QualifiedID schema_name = {}, QualifiedID table_name = {})
            : ast_node_id(ast_node_id),
              database_name(database_name),
              schema_name(schema_name),
              table_name(table_name) {}
        /// Create FlatBuffer
        operator proto::QualifiedTableName() {
            return proto::QualifiedTableName{ast_node_id.value_or(PROTO_NULL_U32), database_name.Pack(),
                                             schema_name.Pack(), table_name.Pack()};
        }
    };
    /// A qualified column name
    struct QualifiedColumnName {
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The table alias, may refer to different context
        QualifiedID table_alias;
        /// The column name, may refer to different context
        QualifiedID column_name;
        /// Constructor
        QualifiedColumnName(std::optional<uint32_t> ast_node_id = std::nullopt, QualifiedID table_alias = {},
                            QualifiedID column_name = {})
            : ast_node_id(ast_node_id), table_alias(table_alias), column_name(column_name) {}
        /// Create FlatBuffer
        operator proto::QualifiedColumnName() {
            return proto::QualifiedColumnName{ast_node_id.value_or(PROTO_NULL_U32), table_alias.Pack(),
                                              column_name.Pack()};
        }
    };
    /// A table column
    struct TableColumn {
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The column name, may refer to different context
        QualifiedID column_name;
        /// Constructor
        TableColumn(std::optional<uint32_t> ast_node_id = std::nullopt, QualifiedID column_name = {})
            : ast_node_id(ast_node_id), column_name(column_name) {}
        /// Create FlatBuffer
        operator proto::TableColumn() {
            return proto::TableColumn{ast_node_id.value_or(PROTO_NULL_U32), column_name.Pack()};
        }
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
        /// Create FlatBuffer
        operator proto::Table() {
            return proto::Table{ast_node_id.value_or(PROTO_NULL_U32),
                                ast_statement_id.value_or(PROTO_NULL_U32),
                                ast_scope_root.value_or(PROTO_NULL_U32),
                                table_name,
                                columns_begin,
                                column_count};
        }
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
