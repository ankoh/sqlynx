#include "sqlynx/schema.h"

#include "sqlynx/proto/proto_generated.h"

using namespace sqlynx;

flatbuffers::Offset<proto::TableColumn> Schema::TableColumn::Pack(flatbuffers::FlatBufferBuilder& builder) const {
    flatbuffers::Offset<flatbuffers::String> column_name_ofs;
    if (!column_name.empty()) {
        column_name_ofs = builder.CreateString(column_name);
    }
    proto::TableColumnBuilder out{builder};
    out.add_ast_node_id(ast_node_id.value_or(PROTO_NULL_U32));
    out.add_column_name(column_name_ofs);
    return out.Finish();
}

flatbuffers::Offset<proto::Table> Schema::Table::Pack(flatbuffers::FlatBufferBuilder& builder) const {
    flatbuffers::Offset<flatbuffers::String> table_name_ofs;
    if (!table_name.empty()) {
        table_name_ofs = builder.CreateString(table_name);
    }
    proto::TableBuilder out{builder};
    out.add_ast_node_id(ast_node_id.value_or(PROTO_NULL_U32));
    out.add_ast_statement_id(ast_statement_id.value_or(PROTO_NULL_U32));
    out.add_ast_scope_root(ast_scope_root.value_or(PROTO_NULL_U32));
    out.add_table_name(table_name_ofs);
    out.add_columns_begin(columns_begin);
    out.add_column_count(column_count);
    return out.Finish();
}

Schema::Schema(uint32_t context_id, std::string database_name, std::string schema_name)
    : context_id(context_id), database_name(std::move(database_name)), schema_name(std::move(schema_name)) {}

std::optional<Schema::ResolvedTable> Schema::ResolveTable(ContextObjectID table_id) const {
    if (table_id.GetContext() != context_id || table_id.GetIndex() >= tables.size()) {
        return std::nullopt;
    }
    auto& table = tables[table_id.GetIndex()];
    auto columns = std::span<const TableColumn>{table_columns}.subspan(table.columns_begin, table.column_count);
    return ResolvedTable{table_id, table, columns};
}

std::optional<Schema::ResolvedTable> Schema::ResolveTable(std::string_view table_name) const {
    auto iter = tables_by_name.find(table_name);
    if (iter == tables_by_name.end()) {
        return std::nullopt;
    }
    assert(iter->second < tables.size());
    auto& table = tables[iter->second];
    auto columns = std::span<const TableColumn>{table_columns}.subspan(table.columns_begin, table.column_count);
    ContextObjectID table_id{context_id, static_cast<uint32_t>(iter->second)};
    return ResolvedTable{table_id, table, columns};
}

std::span<Schema::ResolvedTableColumn> Schema::ResolveTableColumn(std::string_view table_column,
                                                                  std::vector<Schema::ResolvedTableColumn>& tmp) const {
    tmp.clear();
    auto [begin, end] = table_columns_by_name.equal_range(table_column);
    for (auto iter = begin; iter != end; ++iter) {
        assert(iter->second < table_columns.size());
        auto& column = table_columns[iter->second];
        auto& table = tables[column.table_id];
        auto columns = std::span<const TableColumn>{table_columns}.subspan(table.columns_begin, table.column_count);
        auto column_id = &column - columns.data();
        ContextObjectID table_id{context_id, static_cast<uint32_t>(iter->second)};
        tmp.push_back(ResolvedTableColumn{table_id, table, columns, static_cast<size_t>(column_id)});
    }
    return tmp;
}
