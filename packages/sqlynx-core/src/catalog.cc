#include "sqlynx/catalog.h"

#include <flatbuffers/buffer.h>
#include <flatbuffers/flatbuffer_builder.h>
#include <flatbuffers/verifier.h>

#include <map>

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

flatbuffers::Offset<proto::Table> CatalogEntry::TableDeclaration::Pack(flatbuffers::FlatBufferBuilder& builder) const {
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
    out.add_catalog_table_id(catalog_table_id.Pack());
    out.add_catalog_schema_id(catalog_schema_id);
    out.add_catalog_database_id(catalog_database_id);
    out.add_ast_node_id(ast_node_id.value_or(PROTO_NULL_U32));
    out.add_ast_statement_id(ast_statement_id.value_or(PROTO_NULL_U32));
    out.add_ast_scope_root(ast_scope_root.value_or(PROTO_NULL_U32));
    out.add_table_name(table_name_ofs);
    out.add_table_columns(table_columns_ofs);
    return out.Finish();
}

CatalogEntry::CatalogEntry(Catalog& catalog, ExternalID external_id)
    : catalog(catalog),
      catalog_entry_id(external_id),
      database_references(),
      schema_references(),
      table_declarations(),
      databases_by_name(),
      schemas_by_name(),
      tables_by_name(),
      table_columns_by_name(),
      name_search_index() {}

CatalogEntry::QualifiedTableName CatalogEntry::QualifyTableName(CatalogEntry::QualifiedTableName name) const {
    name.database_name = name.database_name.empty() ? catalog.GetDefaultDatabaseName() : name.database_name;
    name.schema_name = name.schema_name.empty() ? catalog.GetDefaultSchemaName() : name.schema_name;
    return name;
}

CatalogObjectID CatalogEntry::RegisterDatabaseName(std::string_view name) {
    auto db_id = catalog.AllocateDatabaseId(name);
    if (!databases_by_name.contains({name})) {
        auto& db = database_references.Append(CatalogEntry::DatabaseReference{db_id, name, ""});
        databases_by_name.insert({db.database_name, db});
    }
    return db_id;
}

CatalogObjectID CatalogEntry::RegisterSchemaName(CatalogObjectID db_id, std::string_view db_name,
                                                 std::string_view schema_name) {
    auto schema_id = catalog.AllocateSchemaId(db_name, schema_name);
    if (!schemas_by_name.contains({db_name, schema_name})) {
        auto& schema = schema_references.Append(CatalogEntry::SchemaReference{db_id, schema_id, db_name, schema_name});
        schemas_by_name.insert({{db_name, schema_name}, schema});
    }
    return schema_id;
}

const CatalogEntry::TableDeclaration* CatalogEntry::ResolveTable(ExternalObjectID table_id) const {
    if (table_id.GetExternalId() == catalog_entry_id) {
        return &table_declarations[table_id.GetIndex()];
    }
    return nullptr;
}

const CatalogEntry::TableDeclaration* CatalogEntry::ResolveTable(ExternalObjectID table_id,
                                                                 const Catalog& catalog) const {
    if (catalog_entry_id == table_id.GetExternalId()) {
        return &table_declarations[table_id.GetIndex()];
    } else {
        return catalog.ResolveTable(table_id);
    }
}

const CatalogEntry::TableDeclaration* CatalogEntry::ResolveTable(QualifiedTableName name) const {
    auto iter = tables_by_name.find(name);
    if (iter == tables_by_name.end()) {
        return nullptr;
    }
    return &iter->second.get();
}

const CatalogEntry::TableDeclaration* CatalogEntry::ResolveTable(QualifiedTableName name,
                                                                 const Catalog& catalog) const {
    name = QualifyTableName(name);
    if (auto resolved = ResolveTable(name)) {
        return resolved;
    } else {
        return catalog.ResolveTable(name, catalog_entry_id);
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

DescriptorPool::DescriptorPool(Catalog& catalog, ExternalID external_id, uint32_t rank)
    : CatalogEntry(catalog, external_id), rank(rank) {
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
    catalog.add_catalog_entry_id(catalog_entry_id);
    catalog.add_catalog_entry_type(proto::CatalogEntryType::DESCRIPTOR_POOL);
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

    std::string_view db_name = descriptor.database_name() == nullptr ? "" : descriptor.database_name()->string_view();
    std::string_view schema_name = descriptor.schema_name() == nullptr ? "" : descriptor.schema_name()->string_view();

    // Allocate ids
    auto db_id = RegisterDatabaseName(db_name);
    auto schema_id = RegisterSchemaName(db_id, db_name, schema_name);

    // Read tables
    uint32_t next_table_id = table_declarations.GetSize();
    for (auto* table : *descriptor.tables()) {
        ExternalObjectID table_id{catalog_entry_id, next_table_id};
        // Get the table name
        auto table_name_ptr = table->table_name();
        if (!table_name_ptr || table_name_ptr->size() == 0) {
            return proto::StatusCode::CATALOG_DESCRIPTOR_TABLE_NAME_EMPTY;
        }
        // Build the qualified table name
        QualifiedTableName::Key qualified_table_name{db_name, schema_name, table_name_ptr->string_view()};
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
        std::sort(columns.begin(), columns.end(),
                  [&](TableColumn& l, TableColumn& r) { return l.column_name < r.column_name; });
        // Create the table
        auto& t = table_declarations.Append(AnalyzedScript::TableDeclaration());
        t.catalog_database_id = db_id;
        t.catalog_schema_id = schema_id;
        t.catalog_table_id = table_id;
        t.table_name = QualifiedTableName{qualified_table_name};
        t.table_columns = std::move(columns);
        ++next_table_id;
    }

    // Build table index
    tables_by_name.reserve(table_declarations.GetSize());
    for (auto& table_chunk : table_declarations.GetChunks()) {
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
            auto& name_info = names.Append(IndexedName{.name_id = static_cast<uint32_t>(names.GetSize()),
                                                       .text = name,
                                                       .location = sx::Location(),
                                                       .tags = tags,
                                                       .occurrences = 1,
                                                       .catalog_objects = {}});
            name_infos.insert({name, name_info});
            for (size_t i = 1; i < ci_name.size(); ++i) {
                auto suffix = ci_name.substr(ci_name.size() - 1 - i);
                name_search_index->insert({suffix, name_info});
            }
        }
    };
    register_name(db_name, proto::NameTag::DATABASE_NAME);
    register_name(schema_name, proto::NameTag::SCHEMA_NAME);
    for (auto& table_chunk : table_declarations.GetChunks()) {
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

Catalog::Catalog(std::string_view default_db, std::string_view default_schema)
    : default_database_name(default_db.empty() ? "sqlynx" : default_db),
      default_schema_name(default_schema.empty() ? "default" : default_schema) {}

void Catalog::Clear() {
    entries_by_schema.clear();
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

/// Flatten the catalog
flatbuffers::Offset<proto::FlatCatalog> Catalog::Flatten(flatbuffers::FlatBufferBuilder& builder) const {
    // We build a name dictionary so that JS can save unnecessary utf8->utf16 conversions.
    // The JS renderers are virtualized which means that they only need to convert catalog entry names that are visible.
    std::unordered_map<std::string_view, size_t> name_dictionary_index;
    std::vector<std::string_view> name_dictionary;

    // Helper to add a name to the dictionary
    auto add_name = [&](std::string_view name) {
        auto iter = name_dictionary_index.find(name);
        if (iter != name_dictionary_index.end()) {
            return iter->second;
        } else {
            auto name_id = name_dictionary_index.size();
            name_dictionary_index.insert({name, name_id});
            name_dictionary.push_back(name);
            return name_id;
        }
    };

    struct ColumnNode {
        // The column id
        uint32_t column_id;
        // A name id
        size_t name_id;
    };

    struct TableNode {
        // The catalog object id
        ExternalObjectID table_id;
        // A name id
        size_t name_id;
        // Child nodes
        ChunkBuffer<ColumnNode, 16>::ConstTupleIterator children_begin;
        // Child count
        size_t child_count;
    };

    struct SchemaNode {
        // The catalog object id
        uint32_t schema_id;
        // A name id
        size_t name_id;
        // Child nodes
        std::map<std::string_view, std::reference_wrapper<TableNode>> children;
    };

    struct DatabaseNode {
        // The catalog object id
        uint32_t database_id;
        // A name id
        size_t name_id;
        // Child nodes
        std::map<std::string_view, std::reference_wrapper<SchemaNode>> children;
    };

    // Allocate nodes in chunk buffers
    ChunkBuffer<DatabaseNode, 16> database_nodes;
    ChunkBuffer<SchemaNode, 16> schema_nodes;
    ChunkBuffer<TableNode, 16> table_nodes;
    ChunkBuffer<ColumnNode, 16> column_nodes;
    // Track all root database nodes
    std::map<std::string_view, std::reference_wrapper<DatabaseNode>> root;
    // Track maps for database and schema nodes
    std::unordered_map<CatalogObjectID, DatabaseNode*> database_node_map;
    std::unordered_map<CatalogObjectID, SchemaNode*> schema_node_map;

    for (auto& [catalog_entry_id, catalog_entry] : entries) {
        /// Register all databases
        for (auto& [db_key, db_ref_raw] : catalog_entry->databases_by_name) {
            auto& db_ref = db_ref_raw.get();
            if (auto iter = database_node_map.find(db_ref.catalog_database_id); iter == database_node_map.end()) {
                auto db_name = db_ref.database_name;
                auto db_name_id = add_name(db_ref.database_name);

                if (!database_node_map.contains(db_ref.catalog_database_id)) {
                    auto& db_node = database_nodes.Append(DatabaseNode{db_ref.catalog_database_id, db_name_id});
                    database_node_map.insert({db_ref.catalog_database_id, &db_node});

                    auto db_name_unique = root.insert({db_name, db_node}).second;
                    assert(db_name_unique);
                }
            }
        }

        /// Register all schemas
        for (auto& [schema_key, schema_ref_raw] : catalog_entry->schemas_by_name) {
            auto& schema_ref = schema_ref_raw.get();
            if (auto iter = schema_node_map.find(schema_ref.catalog_schema_id); iter == schema_node_map.end()) {
                auto schema_name = schema_ref.schema_name;
                auto schema_name_id = add_name(schema_ref.schema_name);

                if (!schema_node_map.contains(schema_ref.catalog_schema_id)) {
                    auto& schema_node = schema_nodes.Append(SchemaNode{schema_ref.catalog_schema_id, schema_name_id});
                    schema_node_map.insert({schema_ref.catalog_schema_id, &schema_node});

                    auto& db_node = database_node_map.at(schema_ref.catalog_database_id);
                    auto schema_name_unique = db_node->children.insert({schema_ref.schema_name, schema_node}).second;
                    assert(schema_name_unique);
                }
            }
        }
    }

    // Track the effective table count.
    // Tables are not deduplicated among catalog entries and may override each other.
    size_t effective_table_count = 0;

    // Translate all table declarations.
    // Iterate over entries in ranked order since there might be duplicate table declarations.
    for (auto& [rank, catalog_entry_id] : entries_ranked) {
        auto& catalog_entry = entries.at(catalog_entry_id);
        for (auto& chunk : catalog_entry->table_declarations.GetChunks()) {
            for (auto& entry : chunk) {
                // Resolve the schema node
                auto& schema_node = schema_node_map.at(entry.catalog_schema_id);
                auto table_name = entry.table_name.table_name;

                // Check if the schema node already contains a table.
                // This may happen if a table is overwritten between catalog entries.
                // Check which wins based on the catalog entry rank
                if (schema_node->children.contains(table_name)) {
                    continue;
                }

                // Add all columns nodes
                auto columns_begin = column_nodes.GetIteratorAtLast();
                if (entry.table_columns.size() > 0) {
                    auto& first_column = entry.table_columns[0];
                    auto first_column_name_id = add_name(first_column.column_name);
                    auto& first_column_node = column_nodes.Append(ColumnNode{0, first_column_name_id});
                    columns_begin = column_nodes.GetIteratorAtLast();

                    for (uint32_t column_id = 1; column_id < entry.table_columns.size(); ++column_id) {
                        auto& column = entry.table_columns[column_id];
                        auto column_name_id = add_name(column.column_name);
                        column_nodes.Append(ColumnNode{column_id, column_name_id});
                    }
                }
                auto column_count = entry.table_columns.size();

                // Get the table declaration
                auto table_name_id = add_name(table_name);
                auto& table_node =
                    table_nodes.Append(TableNode{entry.catalog_table_id, table_name_id, columns_begin, column_count});
                schema_node->children.insert({table_name, table_node});
                ++effective_table_count;
            }
        }
    }

    // Write the dictionary vector
    auto dictionary = builder.CreateVectorOfStrings(name_dictionary);

    // Allocate the entry node vectors
    std::vector<sqlynx::proto::FlatCatalogEntry> database_entries;
    std::vector<sqlynx::proto::FlatCatalogEntry> schema_entries;
    std::vector<sqlynx::proto::FlatCatalogEntry> table_entries;
    std::vector<sqlynx::proto::FlatCatalogEntry> column_entries;
    database_entries.resize(database_nodes.GetSize());
    schema_entries.resize(schema_nodes.GetSize());
    table_entries.resize(effective_table_count);
    column_entries.resize(column_nodes.GetSize());

    // Allocate the index vectors
    std::vector<proto::IndexedFlatDatabaseEntry> indexed_database_entries;
    std::vector<proto::IndexedFlatSchemaEntry> indexed_schema_entries;
    std::vector<proto::IndexedFlatTableEntry> indexed_table_entries;
    indexed_database_entries.resize(database_nodes.GetSize());
    indexed_schema_entries.resize(schema_nodes.GetSize());
    indexed_table_entries.resize(effective_table_count);

    size_t next_database_idx = 0;
    size_t next_schema_idx = 0;
    size_t next_table_idx = 0;
    size_t next_column_idx = 0;

    // Write all catalog entries to the buffers
    for (auto root_iter = root.begin(); root_iter != root.end(); ++root_iter, ++next_database_idx) {
        auto& [database_name, database_node] = *root_iter;
        // Write database node
        auto& db_node_ref = database_node.get();
        database_entries[next_database_idx] = proto::FlatCatalogEntry(
            next_database_idx, 0, db_node_ref.database_id, db_node_ref.name_id, 0, db_node_ref.children.size());
        indexed_database_entries[next_database_idx] =
            proto::IndexedFlatDatabaseEntry(db_node_ref.database_id, next_database_idx);

        // Write schema nodes
        for (auto db_child_iter = db_node_ref.children.begin(); db_child_iter != db_node_ref.children.end();
             ++db_child_iter, ++next_schema_idx) {
            auto& [schema_name, schema_node] = *db_child_iter;
            // Write schema node
            auto& schema_node_ref = schema_node.get();
            schema_entries[next_schema_idx] = sqlynx::proto::FlatCatalogEntry(
                next_schema_idx, next_database_idx, schema_node_ref.schema_id, schema_node_ref.name_id, next_table_idx,
                schema_node_ref.children.size());
            indexed_schema_entries[next_schema_idx] =
                proto::IndexedFlatSchemaEntry(schema_node_ref.schema_id, next_schema_idx);

            // Write table nodes
            for (auto schema_child_iter = schema_node_ref.children.begin();
                 schema_child_iter != schema_node_ref.children.end(); ++schema_child_iter, ++next_table_idx) {
                auto& [table_name, table_node] = *schema_child_iter;
                // Write table node
                auto& table_node_ref = table_node.get();
                table_entries[next_table_idx] = sqlynx::proto::FlatCatalogEntry(
                    next_table_idx, next_schema_idx, table_node_ref.table_id.Pack(), table_node_ref.name_id,
                    next_column_idx, table_node_ref.child_count);
                indexed_table_entries[next_table_idx] =
                    proto::IndexedFlatTableEntry(table_node_ref.table_id.Pack(), next_table_idx);

                // Write column nodes
                auto child_iter = table_node_ref.children_begin;
                for (auto column_id = 0; column_id < table_node_ref.child_count;
                     ++column_id, ++child_iter, ++next_column_idx) {
                    auto& column_node = *child_iter;
                    // Write column node
                    column_entries[next_column_idx] = sqlynx::proto::FlatCatalogEntry(
                        next_column_idx, next_table_idx, column_id, column_node.name_id, 0, 0);
                }
            }
        }
    }

    assert(next_database_idx == database_nodes.GetSize());
    assert(next_schema_idx == schema_nodes.GetSize());
    assert(next_table_idx == effective_table_count);
    assert(next_column_idx == column_nodes.GetSize());

    // Sort indexes
    std::sort(indexed_database_entries.begin(), indexed_database_entries.end(),
              [](auto& l, auto& r) { return l.database_id() < r.database_id(); });
    std::sort(indexed_schema_entries.begin(), indexed_schema_entries.end(),
              [](auto& l, auto& r) { return l.schema_id() < r.schema_id(); });
    std::sort(indexed_table_entries.begin(), indexed_table_entries.end(),
              [](auto& l, auto& r) { return l.table_id() < r.table_id(); });

    // Write the entry arrays
    auto databases_ofs = builder.CreateVectorOfStructs(database_entries);
    auto schemas_ofs = builder.CreateVectorOfStructs(schema_entries);
    auto tables_ofs = builder.CreateVectorOfStructs(table_entries);
    auto columns_ofs = builder.CreateVectorOfStructs(column_entries);

    // Write the index arrays
    auto databases_by_id_ofs = builder.CreateVectorOfStructs(indexed_database_entries);
    auto schemas_by_id_ofs = builder.CreateVectorOfStructs(indexed_schema_entries);
    auto tables_by_id_ofs = builder.CreateVectorOfStructs(indexed_table_entries);

    // Build the flat catalog
    proto::FlatCatalogBuilder catalogBuilder{builder};
    catalogBuilder.add_catalog_version(version);
    catalogBuilder.add_name_dictionary(dictionary);
    catalogBuilder.add_databases(databases_ofs);
    catalogBuilder.add_schemas(schemas_ofs);
    catalogBuilder.add_tables(tables_ofs);
    catalogBuilder.add_columns(columns_ofs);
    catalogBuilder.add_databases_by_id(databases_by_id_ofs);
    catalogBuilder.add_schemas_by_id(schemas_by_id_ofs);
    catalogBuilder.add_tables_by_id(tables_by_id_ofs);
    return catalogBuilder.Finish();
}

proto::StatusCode Catalog::LoadScript(Script& script, CatalogEntry::Rank rank) {
    if (!script.analyzed_script) {
        return proto::StatusCode::CATALOG_SCRIPT_NOT_ANALYZED;
    }
    if (&script.catalog != this) {
        return proto::StatusCode::CATALOG_MISMATCH;
    }

    // Script has been added to catalog before?
    auto script_iter = script_entries.find(&script);
    if (script_iter != script_entries.end()) {
        return UpdateScript(script_iter->second);
    }
    // Is there another entry (!= the script) with the same external id?
    auto entry_iter = entries.find(script.GetCatalogEntryId());
    if (entry_iter != entries.end()) {
        return proto::StatusCode::EXTERNAL_ID_COLLISION;
    }
    // Check if any of the containng schemas/databases are registered with a different id.
    //
    // That may happen in the following case:
    //  - First the user create schema script and analyzes it.
    //  - In the schema script, there are CREATE TABLE statements referencing a schema foo.bar
    //  - During name-resolution, this schema foo.bar is registered IN THE SCRIPT with the schema id 42.
    //  - This schema id is allocated by bumping the next_schema_id in the catalog.
    //  - After analyzing the script, the user adds a schema descriptor to the catalog.
    //  - This descriptor also contains a schema with name foo.bar.
    //  - The catalog allocates the next schema id and registers foo.bar with id 43.
    //  - The user then calls catalog.LoadScript() with the analyzed script.
    //  - The loading MUST FAIL since otherwise we'd have the ids 42 and 43 referencing the same schema.
    //
    // Rule of thumb:
    // When analysing a schema script, immediately add it to the catalog
    {
        // Declare all databases
        for (auto& [key, ref] : script.analyzed_script->GetDatabasesByName()) {
            auto iter = databases.find(key);
            if (iter != databases.end()) {
                if (iter->second->catalog_database_id != ref.get().catalog_database_id) {
                    // Catalog id is out of sync
                    return proto::StatusCode::CATALOG_ID_OUT_OF_SYNC;
                }
            } else {
                auto db = std::make_unique<DatabaseDeclaration>(ref.get().catalog_database_id, ref.get().database_name,
                                                                ref.get().database_alias);
                std::string_view db_key{db->database_name};
                databases.insert({db_key, std::move(db)});
            }
        }
        // Declare all schemas
        for (auto& [key, ref] : script.analyzed_script->GetSchemasByName()) {
            auto iter = schemas.find(key);
            if (iter != schemas.end()) {
                if (iter->second->catalog_database_id != ref.get().catalog_database_id ||
                    iter->second->catalog_schema_id != ref.get().catalog_schema_id) {
                    // Catalog id is out of sync
                    return proto::StatusCode::CATALOG_ID_OUT_OF_SYNC;
                }
            } else {
                // Copy strings and register the schema
                auto schema =
                    std::make_unique<SchemaDeclaration>(ref.get().catalog_database_id, ref.get().catalog_schema_id,
                                                        ref.get().database_name, ref.get().schema_name);
                std::pair<std::string_view, std::string_view> schema_key{schema->database_name, schema->schema_name};
                schemas.insert({schema_key, std::move(schema)});
            }
        }
    }

    // Collect all schema names
    CatalogEntry& entry = *script.analyzed_script;
    for (auto& [schema_key, schema_ref] : entry.schemas_by_name) {
        auto& [db_name, schema_name] = schema_key;
        std::tuple<std::string_view, std::string_view, CatalogEntry::Rank, ExternalID> entry_key{
            db_name, schema_name, rank, entry.GetCatalogEntryId()};
        CatalogSchemaEntryInfo entry_info{
            .catalog_entry_id = entry.GetCatalogEntryId(),
            .catalog_database_id = schema_ref.get().catalog_database_id,
            .catalog_schema_id = schema_ref.get().catalog_schema_id,
        };
        entries_by_schema.insert({entry_key, entry_info});
    }
    // Register as script entry
    script_entries.insert({&script, {.script = script, .analyzed = script.analyzed_script, .rank = rank}});
    // Register as catalog entry
    entries.insert({entry.GetCatalogEntryId(), &entry});
    // Register rank
    entries_ranked.insert({rank, entry.GetCatalogEntryId()});
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
    auto external_id = script.GetCatalogEntryId();
    auto rank = entry.rank;

    // New database entry
    struct NewDatabaseEntry {
        /// A Schema ref
        const CatalogEntry::DatabaseReference& database_ref;
        /// Already existed?
        bool already_exists;
    };
    // Collect all new database names
    std::unordered_map<std::string_view, NewDatabaseEntry> new_dbs;
    new_dbs.reserve(script.analyzed_script->databases_by_name.size());
    for (auto& [key, ref] : script.analyzed_script->databases_by_name) {
        NewDatabaseEntry new_entry{.database_ref = ref, .already_exists = false};
        new_dbs.insert({key, new_entry});
    }
    // Scan previous database names, mark new names that already exist.
    // We erase those later that no longer exist.
    auto& prev_databases = entry.analyzed->databases_by_name;
    for (auto iter = prev_databases.begin(); iter != prev_databases.end(); ++iter) {
        auto db_name = iter->first;
        // Check if the previous schema name is in the new schema entries.
        auto new_name_iter = new_dbs.find(db_name);
        if (new_name_iter != new_dbs.end()) {
            new_name_iter->second.already_exists = true;
        }
    }
    // Insert unmarked new database entries
    for (auto& [k, new_entry] : new_dbs) {
        if (!new_entry.already_exists) {
            auto db = std::make_unique<DatabaseDeclaration>(new_entry.database_ref.catalog_database_id, k, "");
            databases.insert({db->database_name, std::move(db)});
        }
    }

    // New schema entry
    struct NewSchemaEntry {
        /// A Schema ref
        const CatalogEntry::SchemaReference& schema_ref;
        /// Already existed?
        bool already_exists;
    };
    // Collect all new schema names
    std::unordered_map<std::pair<std::string_view, std::string_view>, NewSchemaEntry, TupleHasher> new_schemas;
    new_schemas.reserve(script.analyzed_script->schemas_by_name.size());
    for (auto& [key, ref] : script.analyzed_script->schemas_by_name) {
        NewSchemaEntry new_entry{.schema_ref = ref, .already_exists = false};
        new_schemas.insert({key, new_entry});
    }
    // Scan previous schema names, mark new names that already exist, erase those that no longer exist
    auto& prev_schemas = entry.analyzed->schemas_by_name;
    for (auto iter = prev_schemas.begin(); iter != prev_schemas.end(); ++iter) {
        auto& [db_name, schema_name] = iter->first;
        // Check if the previous schema name is in the new schema entries.
        auto new_name_iter = new_schemas.find({db_name, schema_name});
        if (new_name_iter != new_schemas.end()) {
            new_name_iter->second.already_exists = true;
        } else {
            // Previous schema no longer exists in new schema.
            // Drop the entry reference from the catalog for this schema.
            entries_by_schema.erase({db_name, schema_name, rank, external_id});
            // Check if there's any remaining catalog entry with that schema name
            auto iter = entries_by_schema.lower_bound({db_name, schema_name, 0, 0});
            if (iter == entries_by_schema.end() || std::get<0>(iter->first) != db_name ||
                std::get<1>(iter->first) != schema_name) {
                // If not, remove the schema declaration from the catalog completely
                schemas.erase({db_name, schema_name});
            }
        }
    }
    // Insert unmarked new schema entries
    for (auto& [k, new_entry] : new_schemas) {
        if (!new_entry.already_exists) {
            // Add schema entries
            auto& [db_name, schema_name] = k;
            CatalogSchemaEntryInfo entry{
                .catalog_entry_id = external_id,
                .catalog_database_id = new_entry.schema_ref.catalog_database_id,
                .catalog_schema_id = new_entry.schema_ref.catalog_schema_id,
            };
            std::tuple<std::string_view, std::string_view, CatalogEntry::Rank, ExternalID> entry_key{
                db_name, schema_name, rank, external_id};
            entries_by_schema.insert({entry_key, entry});

            // Add schema declaration
            if (!schemas.contains({db_name, schema_name})) {
                assert(databases.contains(db_name));
                auto schema = std::make_unique<SchemaDeclaration>(new_entry.schema_ref.catalog_database_id,
                                                                  new_entry.schema_ref.catalog_schema_id,
                                                                  databases.find(db_name)->first, schema_name);
                std::pair<std::string_view, std::string_view> key = {schema->database_name, schema->schema_name};
                schemas.insert({key, std::move(schema)});
            }
        }
    }

    // Erase previous database that's no longer part of the new database.
    for (auto iter = prev_databases.begin(); iter != prev_databases.end(); ++iter) {
        auto db_name = iter->first;
        // Check if the previous schema name is in the new schema entries.
        auto new_name_iter = new_dbs.find(db_name);
        if (new_name_iter == new_dbs.end()) {
            // Check if there are other entries with that database name
            auto other_iter = entries_by_schema.lower_bound({db_name, "", 0, 0});
            if (other_iter == entries_by_schema.end() || std::get<0>(other_iter->first) != db_name) {
                databases.erase(db_name);
            }
        }
    }

    entry.analyzed = script.analyzed_script;
    auto entry_iter = entries.find(script.GetCatalogEntryId());
    assert(entry_iter != entries.end());
    entry_iter->second = entry.analyzed.get();
    ++version;
    return proto::StatusCode::OK;
}

void Catalog::DropScript(Script& script) {
    auto iter = script_entries.find(&script);
    if (iter != script_entries.end()) {
        auto external_id = script.GetCatalogEntryId();
        if (iter->second.analyzed) {
            auto& analyzed = iter->second.analyzed;
            for (auto& [schema_key, entry_info] : analyzed->schemas_by_name) {
                auto& [db_name, schema_name] = schema_key;
                entries_by_schema.erase({db_name, schema_name, iter->second.rank, external_id});
            }
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
    auto pool = std::make_unique<DescriptorPool>(*this, external_id, rank);
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
    // Register database and schema names
    {
        std::string_view db_name =
            descriptor.database_name() == nullptr ? "" : descriptor.database_name()->string_view();
        std::string_view schema_name =
            descriptor.schema_name() == nullptr ? "" : descriptor.schema_name()->string_view();

        // Allocate ids
        auto db_id = pool.RegisterDatabaseName(db_name);
        auto schema_id = pool.RegisterSchemaName(db_id, db_name, schema_name);
        // Add the entry
        std::tuple<std::string_view, std::string_view, CatalogEntry::Rank, ExternalID> entry_key{
            db_name, schema_name, pool.GetRank(), external_id};
        CatalogSchemaEntryInfo entry{
            .catalog_entry_id = external_id,
            .catalog_database_id = db_id,
            .catalog_schema_id = schema_id,
        };
        entries_by_schema.insert({entry_key, entry});
    }
    ++version;
    return proto::StatusCode::OK;
}

const CatalogEntry::TableDeclaration* Catalog::ResolveTable(ExternalObjectID table_id) const {
    if (auto iter = entries.find(table_id.GetExternalId()); iter != entries.end()) {
        return iter->second->ResolveTable(table_id);
    }
    return nullptr;
}
const CatalogEntry::TableDeclaration* Catalog::ResolveTable(CatalogEntry::QualifiedTableName table_name,
                                                            ExternalID ignore_entry) const {
    for (auto iter = entries_by_schema.lower_bound({table_name.database_name, table_name.schema_name, 0, 0});
         iter != entries_by_schema.end(); ++iter) {
        auto& [db_name, schema_name, rank, candidate] = iter->first;
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
