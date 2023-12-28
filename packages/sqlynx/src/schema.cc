#include "sqlynx/schema.h"

#include <flatbuffers/buffer.h>

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

Schema::Schema(uint32_t external_id, std::string_view database_name, std::string_view schema_name)
    : external_id(external_id), database_name(database_name), schema_name(schema_name) {}

std::optional<Schema::ResolvedTable> Schema::ResolveTable(ExternalObjectID table_id) const {
    if (table_id.GetExternalId() != external_id || table_id.GetIndex() >= tables.size()) {
        return std::nullopt;
    }
    auto& table = tables[table_id.GetIndex()];
    auto columns = std::span<const TableColumn>{table_columns}.subspan(table.columns_begin, table.column_count);
    return ResolvedTable{database_name, schema_name, table, columns};
}

std::optional<Schema::ResolvedTable> Schema::ResolveTable(ExternalObjectID table_id,
                                                          const SchemaRegistry& registry) const {
    if (external_id == table_id.GetExternalId()) {
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

ExternalSchema::ExternalSchema(ExternalID external_id, std::string_view database_name, std::string_view schema_name)
    : Schema(external_id, database_name, schema_name) {}

proto::StatusCode ExternalSchema::InsertTables(const proto::SchemaDescriptor& descriptor,
                                               std::unique_ptr<std::byte[]> descriptor_buffer) {
    if (!descriptor.tables()) {
        return proto::StatusCode::SCHEMA_REGISTRY_DESCRIPTOR_TABLES_NULL;
    }
    for (auto* table : *descriptor.tables()) {
        auto table_name_ptr = table->table_name();
        if (!table_name_ptr || table_name_ptr->size() == 0) {
            return proto::StatusCode::SCHEMA_REGISTRY_DESCRIPTOR_TABLE_NAME_EMPTY;
        }
        std::string_view table_name = table_name_ptr->string_view();
        if (tables_by_name.contains(table_name)) {
            return proto::StatusCode::SCHEMA_REGISTRY_DESCRIPTOR_TABLE_NAME_COLLISION;
        }
    }

    // XXX
    return proto::StatusCode::OK;
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
    auto iter = script_entries.find(schema->GetExternalID());
    if (iter != script_entries.end() && iter->second.script.get() != schema.get()) {
        return proto::StatusCode::EXTERNAL_ID_COLLISION;
    }
    script_entries.insert({schema->GetExternalID(), {.script = schema, .rank = rank}});
    schemas.insert({schema->GetExternalID(), *schema});
    ranked_schemas.insert({rank, schema.get()});
    return proto::StatusCode::OK;
}

proto::StatusCode SchemaRegistry::UpdateScript(Script& script) {
    if (!script.analyzed_script) {
        return proto::StatusCode::SCHEMA_REGISTRY_SCRIPT_NOT_ANALYZED;
    }
    auto iter = script_entries.find(script.GetExternalID());
    if (iter == script_entries.end()) {
        return proto::StatusCode::SCHEMA_REGISTRY_SCRIPT_UNKNOWN;
    }
    iter->second.script = script.analyzed_script;
    return proto::StatusCode::OK;
}

void SchemaRegistry::DropScript(Script& script) {
    auto iter = script_entries.find(script.external_id);
    if (iter == script_entries.end()) {
        return;
    }
    auto rank = iter->second.rank;
    ranked_schemas.erase({rank, iter->second.script.get()});
    script_entries.erase(iter);
    schemas.erase(script.external_id);
}

/// Add a schema
proto::StatusCode SchemaRegistry::AddSchema(ExternalID external_id, Rank rank, std::string_view database_name,
                                            std::string_view schema_name) {
    return proto::StatusCode::OK;
}
/// Drop a schema
proto::StatusCode SchemaRegistry::DropSchema(ExternalID external_id) { return proto::StatusCode::OK; }
/// Insert schema tables as serialized FlatBuffer
proto::StatusCode SchemaRegistry::InsertSchemaTables(ExternalID external_id, std::span<std::byte> descriptor_data,
                                                     std::unique_ptr<std::byte[]> descriptor_buffer) {
    return proto::StatusCode::OK;
}

std::optional<Schema::ResolvedTable> SchemaRegistry::ResolveTable(ExternalObjectID table_id) const {
    if (auto iter = schemas.find(table_id.GetExternalId()); iter != schemas.end()) {
        return iter->second.get().ResolveTable(table_id);
    }
    return std::nullopt;
}
std::optional<Schema::ResolvedTable> SchemaRegistry::ResolveTable(Schema::QualifiedTableName table_name) const {
    for (auto iter = ranked_schemas.begin(); iter != ranked_schemas.end(); ++iter) {
        auto& candidate = *iter->second;
        if (candidate.GetDatabaseName().empty()) {
            if (candidate.GetSchemaName().empty()) {
                if (auto resolved = candidate.ResolveTable(table_name.table_name); resolved.has_value()) {
                    return resolved;
                }
            } else if (candidate.GetSchemaName() == table_name.schema_name) {
                if (auto resolved = candidate.ResolveTable(table_name.table_name); resolved.has_value()) {
                    return resolved;
                }
            }
        } else if (candidate.GetDatabaseName() == table_name.database_name &&
                   candidate.GetSchemaName() == table_name.schema_name) {
            // Stop search at exact match
            return candidate.ResolveTable(table_name.table_name);
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
