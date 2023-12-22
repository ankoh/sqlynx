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

Schema::Schema(uint32_t context_id, std::string_view database_name, std::string_view schema_name)
    : context_id(context_id), database_name(database_name), schema_name(schema_name) {}

std::optional<Schema::ResolvedTable> Schema::ResolveTable(ContextObjectID table_id) const {
    if (table_id.GetContext() != context_id || table_id.GetIndex() >= tables.size()) {
        return std::nullopt;
    }
    auto& table = tables[table_id.GetIndex()];
    auto columns = std::span<const TableColumn>{table_columns}.subspan(table.columns_begin, table.column_count);
    return ResolvedTable{database_name, schema_name, table, columns};
}

std::optional<Schema::ResolvedTable> Schema::ResolveTable(ContextObjectID table_id,
                                                          const SchemaRegistry& registry) const {
    if (context_id == table_id.GetContext()) {
        auto& table = tables[table_id.GetIndex()];
        auto columns = std::span<const TableColumn>{table_columns}.subspan(table.columns_begin, table.column_count);
        return ResolvedTable{database_name, schema_name, table, columns};
    } else {
        return registry.ResolveTable(table_id);
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
                                                          const SchemaRegistry& registry) const {
    if (table_name.database_name == database_name && table_name.schema_name == schema_name) {
        if (auto resolved = ResolveTable(table_name.table_name)) {
            return resolved;
        } else {
            return std::nullopt;
        }
    } else {
        if (table_name.database_name.empty()) {
            table_name.database_name = database_name;
        }
        if (table_name.schema_name.empty()) {
            table_name.schema_name = schema_name;
        }
        return registry.ResolveTable(table_name);
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

void Schema::ResolveTableColumn(std::string_view table_column, const SchemaRegistry& registry,
                                std::vector<Schema::ResolvedTableColumn>& tmp) const {
    registry.ResolveTableColumn(table_column, tmp);
    ResolveTableColumn(table_column, tmp);
}

proto::StatusCode SchemaRegistry::AddScript(Script& script, Rank rank) {
    if (!script.analyzed_script) {
        return proto::StatusCode::SCHEMA_REGISTRY_SCRIPT_NOT_ANALYZED;
    }
    auto& schema = script.analyzed_script;
    auto iter = scripts.find(schema->GetContextId());
    if (iter != scripts.end() && iter->second.script.get() != schema.get()) {
        return proto::StatusCode::EXTERNAL_CONTEXT_COLLISION;
    }
    scripts.insert({schema->GetContextId(), {.script = schema, .rank = rank}});
    schemas.insert({schema->GetContextId(), *schema});
    ranked_schemas.insert({rank, schema.get()});
    return proto::StatusCode::OK;
}

proto::StatusCode SchemaRegistry::UpdateScript(Script& script) {
    if (!script.analyzed_script) {
        return proto::StatusCode::SCHEMA_REGISTRY_SCRIPT_NOT_ANALYZED;
    }
    auto iter = scripts.find(script.GetContextId());
    if (iter == scripts.end()) {
        return proto::StatusCode::SCHEMA_REGISTRY_SCRIPT_UNKNOWN;
    }
    iter->second.script = script.analyzed_script;
    return proto::StatusCode::OK;
}

proto::StatusCode SchemaRegistry::EraseScript(Script& script) {
    auto iter = scripts.find(script.context_id);
    if (iter == scripts.end()) {
        return proto::StatusCode::SCHEMA_REGISTRY_SCRIPT_UNKNOWN;
    }
    auto rank = iter->second.rank;
    ranked_schemas.erase({rank, iter->second.script.get()});
    scripts.erase(iter);
    schemas.erase(script.context_id);
    return proto::StatusCode::OK;
}

std::optional<Schema::ResolvedTable> SchemaRegistry::ResolveTable(ContextObjectID table_id) const {
    if (auto iter = schemas.find(table_id.GetContext()); iter != schemas.end()) {
        return iter->second.get().ResolveTable(table_id);
    }
    return std::nullopt;
}
std::optional<Schema::ResolvedTable> SchemaRegistry::ResolveTable(Schema::QualifiedTableName table_name) const {
    if (auto iter = ranked_schemas.begin(); iter != ranked_schemas.end()) {
        auto& schema = *iter->second;
        if (schema.GetDatabaseName() == table_name.database_name && schema.GetSchemaName() == table_name.schema_name) {
            return schema.ResolveTable(table_name.table_name);
        }
    }
    return std::nullopt;
}

void SchemaRegistry::ResolveTableColumn(std::string_view table_column,
                                        std::vector<Schema::ResolvedTableColumn>& out) const {
    if (auto iter = ranked_schemas.begin(); iter != ranked_schemas.end()) {
        iter->second->ResolveTableColumn(table_column, out);
    }
}
