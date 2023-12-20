#include "sqlynx/schema.h"

#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"

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

Schema::Schema(uint32_t context_id, std::string database_name, std::string schema_name)
    : context_id(context_id), database_name(std::move(database_name)), schema_name(std::move(schema_name)) {}

std::optional<Schema::ResolvedTable> Schema::ResolveTable(ContextObjectID table_id) const {
    if (table_id.GetContext() != context_id || table_id.GetIndex() >= tables.size()) {
        return std::nullopt;
    }
    auto& table = tables[table_id.GetIndex()];
    auto columns = std::span<const TableColumn>{table_columns}.subspan(table.columns_begin, table.column_count);
    return ResolvedTable{database_name, schema_name, table, columns};
}

std::optional<Schema::ResolvedTable> Schema::ResolveTable(ContextObjectID table_id,
                                                          const SchemaSearchPath& search_path) const {
    if (context_id == table_id.GetContext()) {
        auto& table = tables[table_id.GetIndex()];
        auto columns = std::span<const TableColumn>{table_columns}.subspan(table.columns_begin, table.column_count);
        return ResolvedTable{database_name, schema_name, table, columns};
    } else {
        return search_path.ResolveTable(table_id);
    }
}

std::optional<Schema::ResolvedTable> Schema::ResolveTable(std::string_view table_name) const {
    auto iter = tables_by_name.find(table_name);
    if (iter == tables_by_name.end()) {
        return std::nullopt;
    }
    auto& table = iter->second.get();
    auto columns = std::span<const TableColumn>{table_columns}.subspan(table.columns_begin, table.column_count);
    return ResolvedTable{database_name, schema_name, table, columns};
}

std::optional<Schema::ResolvedTable> Schema::ResolveTable(QualifiedTableName table_name,
                                                          const SchemaSearchPath& search_path) const {
    if (table_name.database_name == database_name && table_name.schema_name == schema_name) {
        if (auto resolved = ResolveTable(table_name.table_name)) {
            return resolved;
        } else {
            return std::nullopt;
        }
    } else {
        return search_path.ResolveTable(table_name);
    }
}

void Schema::ResolveTableColumn(std::string_view table_column, std::vector<Schema::ResolvedTableColumn>& out) const {
    auto [begin, end] = table_columns_by_name.equal_range(table_column);
    for (auto iter = begin; iter != end; ++iter) {
        auto& [table, column] = iter->second;
        auto columns =
            std::span<const TableColumn>{table_columns}.subspan(table.get().columns_begin, table.get().column_count);
        auto column_id = &column.get() - columns.data();
        out.push_back(ResolvedTableColumn{database_name, schema_name, table, columns, static_cast<size_t>(column_id)});
    }
}

void Schema::ResolveTableColumn(std::string_view table_column, const SchemaSearchPath& search_path,
                                std::vector<Schema::ResolvedTableColumn>& tmp) const {
    search_path.ResolveTableColumn(table_column, tmp);
    ResolveTableColumn(table_column, tmp);
}

proto::StatusCode SchemaSearchPath::PushBack(std::shared_ptr<Schema> schema) {
    auto iter = schema_by_context_id.find(schema->GetContextId());
    if (iter != schema_by_context_id.end() && &iter->second.get() != schema.get()) {
        return proto::StatusCode::EXTERNAL_CONTEXT_COLLISION;
    }
    schema_by_context_id.insert({schema->GetContextId(), *schema});
    schemas.push_back(schema);
    return proto::StatusCode::OK;
}

proto::StatusCode SchemaSearchPath::InsertScript(size_t idx, Script& script) {
    if (!script.analyzed_script) {
        return proto::StatusCode::SCHEMA_SEARCH_PATH_INPUT_INVALID;
    }
    schemas.insert(schemas.begin() + idx, script.analyzed_script);
    return proto::StatusCode::OK;
}

proto::StatusCode SchemaSearchPath::UpdateScript(Script& script) {
    if (!script.analyzed_script) {
        return proto::StatusCode::SCHEMA_SEARCH_PATH_INPUT_INVALID;
    }
    for (auto iter = schemas.begin(); iter != schemas.end(); ++iter) {
        if ((*iter)->GetContextId() == script.context_id) {
            *iter = script.analyzed_script;
            break;
        }
    }
    return proto::StatusCode::OK;
}

proto::StatusCode SchemaSearchPath::EraseScript(Script& script) {
    for (auto iter = schemas.begin(); iter != schemas.end(); ++iter) {
        if ((*iter)->GetContextId() == script.context_id) {
            schema_by_context_id.erase((*iter)->GetContextId());
            schemas.erase(iter);
            break;
        }
    }
    return proto::StatusCode::OK;
}

std::shared_ptr<Schema> SchemaSearchPath::ResolveSchema(uint32_t context_id) const {
    for (auto& schema : schemas) {
        if (schema->GetContextId() == context_id) {
            return schema;
        }
    }
    return nullptr;
}

std::optional<Schema::ResolvedTable> SchemaSearchPath::ResolveTable(ContextObjectID table_id) const {
    for (auto& schema : schemas) {
        if (schema->GetContextId() == table_id.GetContext()) {
            return schema->ResolveTable(table_id);
        }
    }
    return std::nullopt;
}
std::optional<Schema::ResolvedTable> SchemaSearchPath::ResolveTable(Schema::QualifiedTableName table_name) const {
    for (auto& schema : schemas) {
        if (schema->GetDatabaseName() == table_name.database_name &&
            schema->GetSchemaName() == table_name.schema_name) {
            return schema->ResolveTable(table_name.table_name);
        }
    }
    return std::nullopt;
}

void SchemaSearchPath::ResolveTableColumn(std::string_view table_column,
                                          std::vector<Schema::ResolvedTableColumn>& out) const {
    for (auto& schema : schemas) {
        schema->ResolveTableColumn(table_column, out);
    }
}
