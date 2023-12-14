#include "sqlynx/schema.h"

#include "sqlynx/proto/proto_generated.h"

using namespace sqlynx;

flatbuffers::Offset<proto::QualifiedTableName> Schema::QualifiedTableName::Pack(
    flatbuffers::FlatBufferBuilder& builder) const {
    flatbuffers::Offset<flatbuffers::String> database_name_ofs;
    flatbuffers::Offset<flatbuffers::String> schema_name_ofs;
    flatbuffers::Offset<flatbuffers::String> table_name_ofs;
    if (database_name.empty()) {
        database_name_ofs = builder.CreateString(database_name);
    }
    if (schema_name.empty()) {
        schema_name_ofs = builder.CreateString(schema_name);
    }
    if (table_name.empty()) {
        table_name_ofs = builder.CreateString(table_name);
    }
    proto::QualifiedTableNameBuilder out{builder};
    out.add_ast_node_id(ast_node_id.value_or(PROTO_NULL_U32));
    out.add_database_name(database_name_ofs);
    out.add_schema_name(schema_name_ofs);
    out.add_table_name(table_name_ofs);
    return out.Finish();
}

flatbuffers::Offset<proto::QualifiedColumnName> Schema::QualifiedColumnName::Pack(
    flatbuffers::FlatBufferBuilder& builder) const {
    flatbuffers::Offset<flatbuffers::String> table_alias_ofs;
    flatbuffers::Offset<flatbuffers::String> column_name_ofs;
    if (table_alias.empty()) {
        table_alias_ofs = builder.CreateString(table_alias);
    }
    if (column_name.empty()) {
        column_name_ofs = builder.CreateString(column_name);
    }
    proto::QualifiedColumnNameBuilder out{builder};
    out.add_ast_node_id(ast_node_id.value_or(PROTO_NULL_U32));
    out.add_table_alias(table_alias_ofs);
    out.add_column_name(column_name_ofs);
    return out.Finish();
}

flatbuffers::Offset<proto::TableColumn> Schema::TableColumn::Pack(flatbuffers::FlatBufferBuilder& builder) const {
    flatbuffers::Offset<flatbuffers::String> column_name_ofs;
    if (column_name.empty()) {
        column_name_ofs = builder.CreateString(column_name);
    }
    proto::TableColumnBuilder out{builder};
    out.add_ast_node_id(ast_node_id.value_or(PROTO_NULL_U32));
    out.add_column_name(column_name_ofs);
    return out.Finish();
}

flatbuffers::Offset<proto::Table> Schema::Table::Pack(flatbuffers::FlatBufferBuilder& builder) const {
    auto table_name_ofs = table_name.Pack(builder);
    proto::TableBuilder out{builder};
    out.add_ast_node_id(ast_node_id.value_or(PROTO_NULL_U32));
    out.add_ast_statement_id(ast_statement_id.value_or(PROTO_NULL_U32));
    out.add_ast_scope_root(ast_scope_root.value_or(PROTO_NULL_U32));
    out.add_table_name(table_name_ofs);
    out.add_columns_begin(columns_begin);
    out.add_column_count(column_count);
    return out.Finish();
}

Schema::Schema(uint32_t context_id) : context_id(context_id) {}

std::optional<std::pair<std::reference_wrapper<const Schema::Table>, std::span<const Schema::TableColumn>>>
Schema::FindTable(QualifiedID table_id) const {
    if (table_id.GetContext() != context_id || table_id.GetIndex() >= tables.size()) {
        return std::nullopt;
    }
    auto& table = tables[table_id.GetIndex()];
    auto columns = std::span{table_columns}.subspan(table.columns_begin, table.column_count);
    return std::make_pair(table, columns);
}
