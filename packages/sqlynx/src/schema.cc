#include "sqlynx/schema.h"

#include <flatbuffers/buffer.h>

#include "sqlynx/external.h"
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

Schema::Schema(ExternalID external_id, std::string_view database_name, std::string_view schema_name)
    : external_id(external_id), database_name(database_name), schema_name(schema_name) {}

std::optional<Schema::ResolvedTable> Schema::ResolveTable(ExternalObjectID table_id) const {
    if (table_id.GetExternalId() != external_id || table_id.GetIndex() >= tables.size()) {
        return std::nullopt;
    }
    auto& table = tables[table_id.GetIndex()];
    auto columns = std::span<const TableColumn>{table_columns}.subspan(table.columns_begin, table.column_count);
    return ResolvedTable{table, columns};
}

std::optional<Schema::ResolvedTable> Schema::ResolveTable(ExternalObjectID table_id,
                                                          const SchemaRegistry& registry) const {
    if (external_id == table_id.GetExternalId()) {
        auto& table = tables[table_id.GetIndex()];
        auto columns = std::span<const TableColumn>{table_columns}.subspan(table.columns_begin, table.column_count);
        return ResolvedTable{table, columns};
    } else {
        return registry.ResolveTable(table_id);
    }
}

std::optional<Schema::ResolvedTable> Schema::ResolveTable(QualifiedTableName name) const {
    auto iter = tables_by_name.find(name);
    if (iter == tables_by_name.end()) {
        return std::nullopt;
    }
    auto& table = iter->second.get();
    auto columns = std::span<const TableColumn>{table_columns}.subspan(table.columns_begin, table.column_count);
    return ResolvedTable{table, columns};
}

std::optional<Schema::ResolvedTable> Schema::ResolveTable(QualifiedTableName name,
                                                          const SchemaRegistry& registry) const {
    name = QualifyTableName(name);
    if (auto resolved = ResolveTable(name)) {
        return resolved;
    } else {
        return registry.ResolveTable(name);
    }
}

void Schema::ResolveTableColumn(std::string_view table_column, std::vector<Schema::ResolvedTableColumn>& out) const {
    auto [begin, end] = table_columns_by_name.equal_range(table_column);
    for (auto iter = begin; iter != end; ++iter) {
        auto& [table, column] = iter->second;
        auto columns =
            std::span<const TableColumn>{table_columns}.subspan(table.get().columns_begin, table.get().column_count);
        auto column_id = &column.get() - columns.data();
        out.push_back(ResolvedTableColumn{table, columns, static_cast<size_t>(column_id)});
    }
}

ExternalSchema::ExternalSchema(ExternalID external_id) : Schema(external_id, "", "") {}

proto::StatusCode ExternalSchema::InsertTables(const proto::SchemaDescriptor& descriptor,
                                               std::unique_ptr<std::byte[]> descriptor_buffer) {
    if (!descriptor.tables()) {
        return proto::StatusCode::SCHEMA_REGISTRY_DESCRIPTOR_TABLES_NULL;
    }
    std::string_view database_name =
        descriptor.database_name() == nullptr ? "" : descriptor.database_name()->string_view();
    std::string_view schema_name = descriptor.schema_name() == nullptr ? "" : descriptor.schema_name()->string_view();
    for (auto* table : *descriptor.tables()) {
        auto table_name_ptr = table->table_name();
        if (!table_name_ptr || table_name_ptr->size() == 0) {
            return proto::StatusCode::SCHEMA_REGISTRY_DESCRIPTOR_TABLE_NAME_EMPTY;
        }
        QualifiedTableName::Key table_name_key{database_name, schema_name, table_name_ptr->string_view()};
        if (tables_by_name.contains(table_name_key)) {
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
    Schema& schema = *script.analyzed_script;
    auto iter = script_entries.find(schema.GetExternalID());
    if (iter != script_entries.end() && iter->second.script.get() != &schema) {
        return proto::StatusCode::EXTERNAL_ID_COLLISION;
    }
    std::unordered_set<std::pair<std::string_view, std::string_view>, TupleHasher> schema_names;
    for (auto& table : schema.tables) {
        auto name = schema.QualifyTableName(table.table_name);
        schema_names.insert({name.database_name, name.schema_name});
    }
    for (auto& [db_name, schema_name] : schema_names) {
        schema_names_ranked.insert({db_name, schema_name, rank, schema.GetExternalID()});
    }
    script_entries.insert({schema.GetExternalID(),
                           {.script = script.analyzed_script, .rank = rank, .schema_names = std::move(schema_names)}});
    schemas_ranked.insert({rank, schema.GetExternalID()});
    schemas.insert({schema.GetExternalID(), &schema});
    return proto::StatusCode::OK;
}

proto::StatusCode SchemaRegistry::UpdateScript(Script& script) {
    if (!script.analyzed_script) {
        return proto::StatusCode::SCHEMA_REGISTRY_SCRIPT_NOT_ANALYZED;
    }
    auto script_iter = script_entries.find(script.GetExternalID());
    if (script_iter == script_entries.end()) {
        return proto::StatusCode::SCHEMA_REGISTRY_SCRIPT_UNKNOWN;
    }
    // Script stayed the same? Nothing to do then
    if (script_iter->second.script == script.analyzed_script) {
        return proto::StatusCode::OK;
    }
    // Collect all new names
    std::unordered_map<std::pair<std::string_view, std::string_view>, bool, TupleHasher> new_names;
    for (auto& table : script.analyzed_script->tables) {
        auto name = script.analyzed_script->QualifyTableName(table.table_name);
        new_names.insert({{name.database_name, name.schema_name}, false});
    }
    // Scan previous names, mark those that already exist, erase those that no longer exist
    auto external_id = script.GetExternalID();
    auto rank = script_iter->second.rank;
    auto& names = script_iter->second.schema_names;
    for (auto prev_name_iter = names.begin(); prev_name_iter != names.end();) {
        auto& [db_name, schema_name] = *prev_name_iter;
        auto new_name_iter = new_names.find({db_name, schema_name});
        if (new_name_iter != new_names.end()) {
            new_name_iter->second = true;
        } else {
            schema_names_ranked.erase({db_name, schema_name, rank, external_id});
            names.erase(prev_name_iter++);
            continue;
        }
        ++prev_name_iter;
    }
    // Scan new names and insert unmarked
    for (auto& [k, already_exists] : new_names) {
        if (!already_exists) {
            auto& [db_name, schema_name] = k;
            names.insert({db_name, schema_name});
            schema_names_ranked.insert({db_name, schema_name, rank, external_id});
        }
    }
    script_iter->second.script = script.analyzed_script;
    return proto::StatusCode::OK;
}

void SchemaRegistry::DropScript(Script& script) {
    auto iter = script_entries.find(script.GetExternalID());
    if (iter != script_entries.end()) {
        auto external_id = script.GetExternalID();
        auto& names = iter->second.schema_names;
        for (auto& [db_name, schema_name] : iter->second.schema_names) {
            schema_names_ranked.erase({db_name, schema_name, iter->second.rank, external_id});
        }
        schemas_ranked.erase({iter->second.rank, external_id});
        schemas.erase(external_id);
        script_entries.erase(iter);
    }
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
    if (auto iter = script_entries.find(table_id.GetExternalId()); iter != script_entries.end()) {
        return iter->second.script->ResolveTable(table_id);
    }
    return std::nullopt;
}
std::optional<Schema::ResolvedTable> SchemaRegistry::ResolveTable(Schema::QualifiedTableName table_name) const {
    for (auto iter = schema_names_ranked.lower_bound({table_name.database_name, table_name.schema_name, 0, 0});
         iter != schema_names_ranked.end(); ++iter) {
        auto& [db_name, schema_name, rank, candidate] = *iter;
        if (db_name != table_name.database_name || schema_name != table_name.schema_name) {
            break;
        }
        assert(schemas.contains(candidate));
        auto& schema = schemas.at(candidate);
        if (auto resolved = schema->ResolveTable(table_name)) {
            return resolved;
        }
    };
    return std::nullopt;
}

void SchemaRegistry::ResolveTableColumn(std::string_view table_column,
                                        std::vector<Schema::ResolvedTableColumn>& out) const {
    for (auto& [key, schema] : schemas) {
        schema->ResolveTableColumn(table_column, out);
    }
}
