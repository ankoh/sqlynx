#include "sqlynx/catalog.h"

#include <flatbuffers/buffer.h>
#include <flatbuffers/flatbuffer_builder.h>
#include <flatbuffers/verifier.h>

#include "sqlynx/external.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/utils/chunk_buffer.h"
#include "sqlynx/utils/string_conversion.h"

using namespace sqlynx;

flatbuffers::Offset<proto::TableColumn> CatalogEntry::TableColumn::Pack(flatbuffers::FlatBufferBuilder& builder) const {
    flatbuffers::Offset<flatbuffers::String> column_name_ofs;
    if (!column_name.empty()) {
        column_name_ofs = builder.CreateString(column_name);
    }
    proto::TableColumnBuilder out{builder};
    out.add_ast_node_id(ast_node_id.value_or(PROTO_NULL_U32));
    out.add_column_name(column_name_ofs);
    return out.Finish();
}

flatbuffers::Offset<proto::Table> CatalogEntry::Table::Pack(flatbuffers::FlatBufferBuilder& builder) const {
    auto table_name_ofs = table_name.Pack(builder);

    // Pack table columns
    std::vector<flatbuffers::Offset<proto::TableColumn>> table_column_offsets;
    table_column_offsets.reserve(table_columns.size());
    for (auto& table_column : table_columns) {
        auto column_name_ofs = builder.CreateString(table_column.column_name);
        proto::TableColumnBuilder column_builder{builder};
        column_builder.add_column_name(column_name_ofs);
        table_column_offsets.push_back(column_builder.Finish());
    }
    auto table_columns_ofs = builder.CreateVector(table_column_offsets);

    // Pack table
    proto::TableBuilder out{builder};
    out.add_ast_node_id(ast_node_id.value_or(PROTO_NULL_U32));
    out.add_ast_statement_id(ast_statement_id.value_or(PROTO_NULL_U32));
    out.add_ast_scope_root(ast_scope_root.value_or(PROTO_NULL_U32));
    out.add_table_name(table_name_ofs);
    out.add_table_columns(table_columns_ofs);
    return out.Finish();
}

CatalogEntry::CatalogEntry(ExternalID external_id, std::string_view database_name, std::string_view schema_name)
    : external_id(external_id), database_name(database_name), schema_name(schema_name) {}

const CatalogEntry::Table* CatalogEntry::ResolveTable(ExternalObjectID table_id) const {
    if (table_id.GetExternalId() == external_id) {
        return &tables[table_id.GetIndex()];
    }
    return nullptr;
}

const CatalogEntry::Table* CatalogEntry::ResolveTable(ExternalObjectID table_id, const Catalog& catalog) const {
    if (external_id == table_id.GetExternalId()) {
        return &tables[table_id.GetIndex()];
    } else {
        return catalog.ResolveTable(table_id);
    }
}

const CatalogEntry::Table* CatalogEntry::ResolveTable(QualifiedTableName name) const {
    auto iter = tables_by_name.find(name);
    if (iter == tables_by_name.end()) {
        return nullptr;
    }
    return &iter->second.get();
}

const CatalogEntry::Table* CatalogEntry::ResolveTable(QualifiedTableName name, const Catalog& catalog) const {
    name = QualifyTableName(name);
    if (auto resolved = ResolveTable(name)) {
        return resolved;
    } else {
        return catalog.ResolveTable(name, external_id);
    }
}

void CatalogEntry::ResolveTableColumn(std::string_view table_column,
                                      std::vector<CatalogEntry::ResolvedTableColumn>& out) const {
    auto [begin, end] = table_columns_by_name.equal_range(table_column);
    for (auto iter = begin; iter != end; ++iter) {
        auto& [table, column_id] = iter->second;
        out.push_back(ResolvedTableColumn{table, static_cast<size_t>(column_id)});
    }
}

DescriptorPool::DescriptorPool(ExternalID external_id, uint32_t rank) : CatalogEntry(external_id, "", ""), rank(rank) {
    name_search_index.emplace(CatalogEntry::NameSearchIndex{});
}

static flatbuffers::Offset<proto::SchemaDescriptor> describeEntrySchema(flatbuffers::FlatBufferBuilder& builder,
                                                                        const proto::SchemaDescriptor& descriptor,
                                                                        uint32_t& table_id) {
    auto database_name = builder.CreateString(descriptor.database_name());
    auto schema_name = builder.CreateString(descriptor.schema_name());

    std::vector<flatbuffers::Offset<proto::SchemaTable>> table_offsets;
    table_offsets.reserve(descriptor.tables()->size());
    for (auto* table : *descriptor.tables()) {
        auto table_name = builder.CreateString(table->table_name());

        std::vector<flatbuffers::Offset<proto::SchemaTableColumn>> column_offsets;
        column_offsets.reserve(table->columns()->size());
        for (auto* column : *table->columns()) {
            auto column_name = builder.CreateString(column->column_name());
            proto::SchemaTableColumnBuilder column_builder{builder};
            column_builder.add_column_name(column_name);
            column_offsets.push_back(column_builder.Finish());
        }
        auto columns_offset = builder.CreateVector(column_offsets);

        proto::SchemaTableBuilder table_builder{builder};
        table_builder.add_table_id(table_id++);
        table_builder.add_table_name(table_name);
        table_builder.add_columns(columns_offset);
        table_offsets.push_back(table_builder.Finish());
    }
    auto tables_offset = builder.CreateVector(table_offsets);

    proto::SchemaDescriptorBuilder schema_builder{builder};
    schema_builder.add_database_name(database_name);
    schema_builder.add_schema_name(schema_name);
    schema_builder.add_tables(tables_offset);
    return schema_builder.Finish();
}

flatbuffers::Offset<proto::CatalogEntry> DescriptorPool::DescribeEntry(flatbuffers::FlatBufferBuilder& builder) const {
    std::vector<flatbuffers::Offset<proto::SchemaDescriptor>> schema_offsets;
    schema_offsets.reserve(descriptor_buffers.size());
    uint32_t table_id = 0;
    for (auto& buffer : descriptor_buffers) {
        schema_offsets.push_back(describeEntrySchema(builder, buffer.descriptor, table_id));
    }
    auto schemas_offset = builder.CreateVector(schema_offsets);

    proto::CatalogEntryBuilder catalog{builder};
    catalog.add_external_id(external_id);
    catalog.add_entry_type(proto::CatalogEntryType::DESCRIPTOR_POOL);
    catalog.add_rank(0);
    catalog.add_schemas(schemas_offset);
    return catalog.Finish();
}

const CatalogEntry::NameSearchIndex& DescriptorPool::GetNameSearchIndex() { return name_search_index.value(); }

proto::StatusCode DescriptorPool::AddSchemaDescriptor(const proto::SchemaDescriptor& descriptor,
                                                      std::unique_ptr<const std::byte[]> descriptor_buffer) {
    if (!descriptor.tables()) {
        return proto::StatusCode::CATALOG_DESCRIPTOR_TABLES_NULL;
    }
    descriptor_buffers.push_back({.descriptor = descriptor, .descriptor_buffer = std::move(descriptor_buffer)});
    std::string_view database_name =
        descriptor.database_name() == nullptr ? "" : descriptor.database_name()->string_view();
    std::string_view schema_name = descriptor.schema_name() == nullptr ? "" : descriptor.schema_name()->string_view();

    // Read tables
    uint32_t table_id = 0;
    for (auto* table : *descriptor.tables()) {
        ExternalObjectID table_object_id{external_id, table_id++};
        // Get the table name
        auto table_name_ptr = table->table_name();
        if (!table_name_ptr || table_name_ptr->size() == 0) {
            return proto::StatusCode::CATALOG_DESCRIPTOR_TABLE_NAME_EMPTY;
        }
        // Build the qualified table name
        QualifiedTableName::Key qualified_table_name{database_name, schema_name, table_name_ptr->string_view()};
        if (tables_by_name.contains(qualified_table_name)) {
            return proto::StatusCode::CATALOG_DESCRIPTOR_TABLE_NAME_COLLISION;
        }
        // Collect the table columns (if any)
        std::vector<TableColumn> columns;
        if (auto columns_ptr = table->columns()) {
            auto column_count = table->columns()->size();
            columns.reserve(column_count);
            for (auto* column : *columns_ptr) {
                if (auto column_name = column->column_name()) {
                    columns.emplace_back(std::nullopt, column_name->string_view());
                }
            }
        }
        // Create the table
        tables.Append(Table{table_object_id, std::nullopt, std::nullopt, std::nullopt,
                            QualifiedTableName{qualified_table_name}, std::move(columns)});
    }

    // Build table index
    tables_by_name.reserve(tables.GetSize());
    for (auto& table_chunk : tables.GetChunks()) {
        for (auto& table : table_chunk) {
            tables_by_name.insert({table.table_name, table});
            for (size_t i = 0; i < table.table_columns.size(); ++i) {
                table_columns_by_name.insert({table.table_columns[i].column_name, {table, i}});
            }
        }
    }

    // Collect all name infos
    auto register_name = [&](std::string_view name, NameTags tags) {
        if (name.empty()) {
            return;
        }
        auto iter = name_infos.find(name);
        if (iter != name_infos.end()) {
            auto& name_info = iter->second.get();
            name_info.tags |= tags;
            ++name_info.occurrences;
        } else {
            fuzzy_ci_string_view ci_name{name.data(), name.size()};
            auto& name_info = names.Append(NameInfo{
                .name_id = static_cast<uint32_t>(names.GetSize()),
                .text = name,
                .location = sx::Location(),
                .tags = tags,
                .occurrences = 1,
            });
            name_infos.insert({name, name_info});
            for (size_t i = 1; i < ci_name.size(); ++i) {
                auto suffix = ci_name.substr(ci_name.size() - 1 - i);
                name_search_index->insert({suffix, name_info});
            }
        }
    };
    register_name(database_name, proto::NameTag::DATABASE_NAME);
    register_name(schema_name, proto::NameTag::SCHEMA_NAME);
    for (auto& table_chunk : tables.GetChunks()) {
        for (auto& table : table_chunk) {
            register_name(table.table_name.database_name, proto::NameTag::DATABASE_NAME);
            register_name(table.table_name.schema_name, proto::NameTag::SCHEMA_NAME);
            register_name(table.table_name.table_name, proto::NameTag::TABLE_NAME);
            for (auto& column : table.table_columns) {
                register_name(column.column_name, proto::NameTag::COLUMN_NAME);
            }
        }
    }
    return proto::StatusCode::OK;
}

void CatalogEntry::ResolveTableColumn(std::string_view table_column, const Catalog& catalog,
                                      std::vector<CatalogEntry::ResolvedTableColumn>& tmp) const {
    catalog.ResolveTableColumn(table_column, tmp);
    ResolveTableColumn(table_column, tmp);
}

void Catalog::Clear() {
    entry_names_ranked.clear();
    entries_ranked.clear();
    entries.clear();
    script_entries.clear();
    descriptor_pool_entries.clear();
    ++version;
}

flatbuffers::Offset<proto::CatalogEntries> Catalog::DescribeEntries(flatbuffers::FlatBufferBuilder& builder) const {
    std::vector<flatbuffers::Offset<proto::CatalogEntry>> entryOffsets;
    entryOffsets.reserve(entries_ranked.size());
    for (auto& [rank, external_id] : entries_ranked) {
        auto* entry = entries.at(external_id);
        entryOffsets.push_back(entry->DescribeEntry(builder));
    }
    auto entriesOffset = builder.CreateVector(entryOffsets);
    proto::CatalogEntriesBuilder entriesBuilder{builder};
    entriesBuilder.add_entries(entriesOffset);
    return entriesBuilder.Finish();
}

flatbuffers::Offset<proto::CatalogEntries> Catalog::DescribeEntriesOf(flatbuffers::FlatBufferBuilder& builder,
                                                                      size_t external_id) const {
    auto iter = entries.find(external_id);
    if (iter == entries.end()) {
        return {};
    } else {
        std::vector<flatbuffers::Offset<proto::CatalogEntry>> entryOffsets;
        entryOffsets.reserve(entries_ranked.size());
        entryOffsets.push_back(iter->second->DescribeEntry(builder));
        auto entriesOffset = builder.CreateVector(entryOffsets);
        proto::CatalogEntriesBuilder entriesBuilder{builder};
        entriesBuilder.add_entries(entriesOffset);
        return entriesBuilder.Finish();
    }
}

proto::StatusCode Catalog::LoadScript(Script& script, CatalogEntry::Rank rank) {
    if (!script.analyzed_script) {
        return proto::StatusCode::CATALOG_SCRIPT_NOT_ANALYZED;
    }

    // Script was  dded to catalog before?
    auto script_iter = script_entries.find(&script);
    if (script_iter != script_entries.end()) {
        return UpdateScript(script_iter->second);
    }
    // Is there another entry (!= the script) with the same external id?
    auto entry_iter = entries.find(script.GetExternalID());
    if (entry_iter != entries.end()) {
        return proto::StatusCode::EXTERNAL_ID_COLLISION;
    }
    // Collect all schema names
    CatalogEntry& entry = *script.analyzed_script;
    std::unordered_set<std::pair<std::string_view, std::string_view>, TupleHasher> schema_names;
    for (auto& table : entry.tables) {
        auto name = entry.QualifyTableName(table.table_name);
        schema_names.insert({name.database_name, name.schema_name});
    }
    for (auto& [db_name, schema_name] : schema_names) {
        entry_names_ranked.insert({db_name, schema_name, rank, entry.GetExternalID()});
    }
    // Register as script entry
    script_entries.insert({&script,
                           {.script = script,
                            .analyzed = script.analyzed_script,
                            .rank = rank,
                            .schema_names = std::move(schema_names)}});
    // Register as catalog entry
    entries.insert({entry.GetExternalID(), &entry});
    // Register rank
    entries_ranked.insert({rank, entry.GetExternalID()});
    ++version;
    return proto::StatusCode::OK;
}

proto::StatusCode Catalog::UpdateScript(ScriptEntry& entry) {
    auto& script = entry.script;
    assert(script.analyzed_script);
    // Script stayed the same? Nothing to do then
    if (entry.analyzed == script.analyzed_script) {
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
    auto rank = entry.rank;
    auto& names = entry.schema_names;
    for (auto prev_name_iter = names.begin(); prev_name_iter != names.end();) {
        auto& [db_name, schema_name] = *prev_name_iter;
        auto new_name_iter = new_names.find({db_name, schema_name});
        if (new_name_iter != new_names.end()) {
            new_name_iter->second = true;
        } else {
            entry_names_ranked.erase({db_name, schema_name, rank, external_id});
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
            entry_names_ranked.insert({db_name, schema_name, rank, external_id});
        }
    }
    entry.analyzed = script.analyzed_script;
    auto entry_iter = entries.find(script.GetExternalID());
    assert(entry_iter != entries.end());
    entry_iter->second = entry.analyzed.get();
    ++version;
    return proto::StatusCode::OK;
}

void Catalog::DropScript(Script& script) {
    auto iter = script_entries.find(&script);
    if (iter != script_entries.end()) {
        auto external_id = script.GetExternalID();
        auto& names = iter->second.schema_names;
        for (auto& [db_name, schema_name] : iter->second.schema_names) {
            entry_names_ranked.erase({db_name, schema_name, iter->second.rank, external_id});
        }
        entries_ranked.erase({iter->second.rank, external_id});
        entries.erase(external_id);
        script_entries.erase(iter);
        ++version;
    }
}

proto::StatusCode Catalog::AddDescriptorPool(ExternalID external_id, CatalogEntry::Rank rank) {
    if (entries.contains(external_id)) {
        return proto::StatusCode::EXTERNAL_ID_COLLISION;
    }
    auto pool = std::make_unique<DescriptorPool>(external_id, rank);
    entries.insert({external_id, pool.get()});
    entries_ranked.insert({rank, external_id});
    descriptor_pool_entries.insert({external_id, std::move(pool)});
    ++version;
    return proto::StatusCode::OK;
}

proto::StatusCode Catalog::DropDescriptorPool(ExternalID external_id) {
    auto iter = descriptor_pool_entries.find(external_id);
    if (iter != descriptor_pool_entries.end()) {
        descriptor_pool_entries.erase(iter);
        ++version;
    }
    return proto::StatusCode::OK;
}

proto::StatusCode Catalog::AddSchemaDescriptor(ExternalID external_id, std::span<const std::byte> descriptor_data,
                                               std::unique_ptr<const std::byte[]> descriptor_buffer) {
    auto iter = descriptor_pool_entries.find(external_id);
    if (iter == descriptor_pool_entries.end()) {
        return proto::StatusCode::CATALOG_DESCRIPTOR_POOL_UNKNOWN;
    }
    // Add schema descriptor
    auto& pool = *iter->second;
    auto& descriptor = *flatbuffers::GetRoot<proto::SchemaDescriptor>(descriptor_data.data());
    pool.AddSchemaDescriptor(descriptor, std::move(descriptor_buffer));
    // Register schema name
    {
        std::string_view database_name =
            descriptor.database_name() == nullptr ? "" : descriptor.database_name()->string_view();
        std::string_view schema_name =
            descriptor.schema_name() == nullptr ? "" : descriptor.schema_name()->string_view();
        entry_names_ranked.insert({database_name, schema_name, pool.GetRank(), external_id});
    }
    ++version;
    return proto::StatusCode::OK;
}

const CatalogEntry::Table* Catalog::ResolveTable(ExternalObjectID table_id) const {
    if (auto iter = entries.find(table_id.GetExternalId()); iter != entries.end()) {
        return iter->second->ResolveTable(table_id);
    }
    return nullptr;
}
const CatalogEntry::Table* Catalog::ResolveTable(CatalogEntry::QualifiedTableName table_name,
                                                 ExternalID ignore_entry) const {
    for (auto iter = entry_names_ranked.lower_bound({table_name.database_name, table_name.schema_name, 0, 0});
         iter != entry_names_ranked.end(); ++iter) {
        auto& [db_name, schema_name, rank, candidate] = *iter;
        if (db_name != table_name.database_name || schema_name != table_name.schema_name) {
            break;
        }
        if (candidate == ignore_entry) {
            continue;
        }
        assert(entries.contains(candidate));
        auto& schema = entries.at(candidate);
        if (auto resolved = schema->ResolveTable(table_name)) {
            return resolved;
        }
    };
    return nullptr;
}

void Catalog::ResolveTableColumn(std::string_view table_column,
                                 std::vector<CatalogEntry::ResolvedTableColumn>& out) const {
    for (auto& [key, schema] : entries) {
        schema->ResolveTableColumn(table_column, out);
    }
}
