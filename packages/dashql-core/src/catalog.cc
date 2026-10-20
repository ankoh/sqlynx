#include "dashql/catalog.h"

#include <flatbuffers/buffer.h>
#include <flatbuffers/flatbuffer_builder.h>
#include <flatbuffers/verifier.h>

#include <map>
#include <stdexcept>
#include <unordered_set>
#include <variant>

#include "dashql/buffers/index_generated.h"
#include "dashql/catalog_object.h"
#include "dashql/catalog_descriptor.h"
#include "dashql/exception.h"
#include "dashql/external.h"
#include "dashql/script.h"
#include "dashql/utils/chunk_buffer.h"
#include "dashql/utils/string_conversion.h"

using namespace dashql;

flatbuffers::Offset<buffers::analyzer::TableColumn> CatalogEntry::TableColumn::Pack(
    flatbuffers::FlatBufferBuilder& builder) const {
    flatbuffers::Offset<flatbuffers::String> column_name_ofs;
    if (!column_name.get().text.empty()) {
        column_name_ofs = builder.CreateString(column_name.get().text);
    }
    buffers::analyzer::TableColumnBuilder out{builder};
    out.add_ast_node_id(ast_node_id.value_or(PROTO_NULL_U32));
    out.add_column_name(column_name_ofs);
    return out.Finish();
}

flatbuffers::Offset<buffers::analyzer::Table> CatalogEntry::TableDeclaration::Pack(
    flatbuffers::FlatBufferBuilder& builder) const {
    auto table_name_ofs = table_name.Pack(builder);

    // Pack table columns
    std::vector<flatbuffers::Offset<buffers::analyzer::TableColumn>> table_column_offsets;
    table_column_offsets.reserve(table_columns.size());
    for (auto& table_column : table_columns) {
        auto column_name_ofs = builder.CreateString(table_column.column_name.get().text);
        buffers::analyzer::TableColumnBuilder column_builder{builder};
        column_builder.add_column_name(column_name_ofs);
        table_column_offsets.push_back(column_builder.Finish());
    }
    auto table_columns_ofs = builder.CreateVector(table_column_offsets);

    // Pack table
    buffers::analyzer::TableBuilder out{builder};
    out.add_catalog_table_id(GetTableID().Pack());
    out.add_catalog_database_id(catalog_schema_id.UnpackSchemaID().first);
    out.add_catalog_schema_id(catalog_schema_id.UnpackSchemaID().second);
    out.add_ast_node_id(ast_node_id.value_or(PROTO_NULL_U32));
    out.add_ast_statement_id(ast_statement_id.value_or(PROTO_NULL_U32));
    out.add_ast_scope_root(ast_scope_root.value_or(PROTO_NULL_U32));
    out.add_table_name(table_name_ofs);
    out.add_table_columns(table_columns_ofs);
    return out.Finish();
}

CatalogEntry::CatalogEntry(Catalog& catalog, CatalogEntryID external_id)
    : catalog(catalog),
      catalog_version(catalog.version),
      catalog_entry_id(external_id),
      database_references(),
      schema_references(),
      table_declarations(),
      databases_by_name(),
      schemas_by_qualified_name(),
      tables_by_qualified_name(),
      tables_by_unqualified_name(),
      table_columns_by_name(),
      name_search_index() {}

void CatalogEntry::ResolveDatabaseSchemasWithCatalog(
    std::string_view database_name,
    std::vector<std::pair<std::reference_wrapper<const SchemaReference>, bool>>& out) const {
    // First search in our own script.
    // Note that this script might not have been added to the catalog yet.
    // That's why we have to check the own script first.
    {
        auto lb = schemas_by_qualified_name.lower_bound({database_name, ""});
        for (auto iter = lb; iter != schemas_by_qualified_name.end() && iter->first.first == database_name; ++iter) {
            out.push_back({iter->second, false});
        }
    }

    // Then just check all registered schemas in the catalog directly
    {
        auto lb = catalog.schemas.lower_bound({database_name, ""});
        for (auto iter = lb; iter != catalog.schemas.end() && iter->first.first == database_name; ++iter) {
            out.push_back({*iter->second, true});
        }
    }
}

void CatalogEntry::ResolveSchemaTablesWithCatalog(
    std::string_view schema_name,
    std::vector<std::pair<std::reference_wrapper<const CatalogEntry::TableDeclaration>, bool>>& out) const {
    // First search in our own script.
    // Note that this script might not have been added to the catalog yet.
    // That's why we have to check the own script first.
    {
        auto lb = tables_by_unqualified_schema.lower_bound({schema_name, ""});
        for (auto iter = lb; iter != tables_by_unqualified_schema.end() && iter->first.first == schema_name; ++iter) {
            out.push_back({iter->second, false});
        }
    }

    // Then discover all catalog entries that populate that schema
    {
        auto lb = catalog.entries_by_schema.lower_bound({schema_name, 0, 0});
        auto ub = catalog.entries_by_schema.upper_bound(
            {schema_name, std::numeric_limits<CatalogEntry::Rank>::max(), std::numeric_limits<CatalogEntryID>::max()});
        for (auto iter = lb; iter != ub; ++iter) {
            // Skip own entry, we checked earlier
            if (iter->second.catalog_entry_id == catalog_entry_id) {
                continue;
            }
            // Do the same lookup in the other entries
            auto& other_entry = *catalog.entries.at(iter->second.catalog_entry_id);
            auto table_lb = other_entry.tables_by_unqualified_schema.lower_bound({schema_name, ""});
            for (auto table_iter = table_lb;
                 table_iter != other_entry.tables_by_unqualified_schema.end() && table_iter->first.first == schema_name;
                 ++table_iter) {
                out.push_back({table_iter->second, true});
            }
        }
    }
}

void CatalogEntry::ResolveSchemaTablesWithCatalog(
    std::string_view database_name, std::string_view schema_name,
    std::vector<std::pair<std::reference_wrapper<const CatalogEntry::TableDeclaration>, bool>>& out) const {
    // First search in our own script.
    // Note that this script might not have been added to the catalog yet.
    // That's why we have to check the own script first.
    {
        auto lb = tables_by_unqualified_schema.lower_bound({schema_name, database_name});
        auto ub = tables_by_unqualified_schema.upper_bound({schema_name, database_name});
        for (auto iter = lb; iter != ub; ++iter) {
            out.push_back({iter->second, false});
        }
    }

    // Then discover all catalog entries that populate that schema
    {
        auto lb = catalog.entries_by_qualified_schema.lower_bound({database_name, schema_name, 0, 0});
        auto ub = catalog.entries_by_qualified_schema.upper_bound({database_name, schema_name,
                                                                   std::numeric_limits<CatalogEntry::Rank>::max(),
                                                                   std::numeric_limits<CatalogEntryID>::max()});
        for (auto iter = lb; iter != ub; ++iter) {
            // Skip own entry, we checked earlier
            if (iter->second.catalog_entry_id == catalog_entry_id) {
                continue;
            }
            // Do the same lookup in the other entries
            auto& other_entry = *catalog.entries.at(iter->second.catalog_entry_id);
            auto table_lb = other_entry.tables_by_unqualified_schema.lower_bound({schema_name, database_name});
            auto table_ub = other_entry.tables_by_unqualified_schema.upper_bound({schema_name, database_name});
            for (auto table_iter = table_lb; table_iter != table_ub; ++table_iter) {
                out.push_back({table_iter->second, true});
            }
        }
    }
}

const CatalogEntry::TableDeclaration* CatalogEntry::ResolveTableById(CatalogTableID table_id) const {
    if (table_id.GetOrigin() == catalog_entry_id && table_id.GetObject() < table_declarations.GetSize()) {
        return &table_declarations[table_id.GetObject()];
    }
    return nullptr;
}

void CatalogEntry::ResolveTable(QualifiedTableName table_name,
                                std::vector<std::reference_wrapper<const TableDeclaration>>& out, size_t limit) const {
    // Probe the qualified names map directly
    auto iter = tables_by_qualified_name.find(table_name);
    if (iter != tables_by_qualified_name.end()) {
        out.push_back(iter->second);
        return;
    }

    // Are database and/or schema empty?
    if (table_name.database_name.get() == "") {
        if (table_name.schema_name.get() == "") {
            return ResolveTableEverywhere(table_name.table_name.get(), out, limit);
        } else {
            return ResolveTableInSchema(table_name.schema_name.get(), table_name.table_name.get(), out, limit);
        }
    }
}

void CatalogEntry::ResolveTableInSchema(std::string_view schema_name, std::string_view table_name,
                                        std::vector<std::reference_wrapper<const TableDeclaration>>& out,
                                        size_t limit) const {
    auto lb = tables_by_unqualified_schema.lower_bound({schema_name, ""});
    for (auto iter = lb; iter != tables_by_unqualified_schema.end() && iter->first.first == schema_name; ++iter) {
        if (iter->second.get().table_name.table_name.get().text != table_name) continue;
        out.push_back(iter->second.get());
        if (out.size() >= limit) {
            return;
        }
    }
}

void CatalogEntry::ResolveTableEverywhere(std::string_view table_name,
                                          std::vector<std::reference_wrapper<const TableDeclaration>>& out,
                                          size_t limit) const {
    auto [begin, end] = tables_by_unqualified_name.equal_range(table_name);
    for (auto iter = begin; iter != end; ++iter) {
        out.push_back(iter->second.get());
        if (out.size() >= limit) {
            return;
        }
    }
}

void CatalogEntry::ResolveTableColumns(std::string_view table_column, std::vector<TableColumn>& out) const {
    auto [begin, end] = table_columns_by_name.equal_range(table_column);
    for (auto iter = begin; iter != end; ++iter) {
        out.push_back(iter->second.get());
    }
}

void CatalogEntry::ResolveTableColumnsWithCatalog(std::string_view table_column, std::vector<TableColumn>& tmp) const {
    // Visit the entries in ranked order so that the order does not depend on the hash implementation
    for (auto& [rank, entry_id] : catalog.entries_ranked) {
        auto* entry = catalog.entries.at(entry_id);
        if (entry != this) {
            entry->ResolveTableColumns(table_column, tmp);
        }
    }
    ResolveTableColumns(table_column, tmp);
}

Catalog::Catalog() {}

CatalogEntryID Catalog::AllocateEntryId() {
    if (next_entry_id == PROTO_NULL_U32) throw std::overflow_error("catalog entry ID namespace exhausted");
    return next_entry_id++;
}

void Catalog::AnalyzeScript(Script& script, bool parse_if_outdated) {
    script.AnalyzeInternal(parse_if_outdated);
    auto& analyzed = *script.analyzed_script;
    std::unordered_set<CatalogEntryID> referenced_entries;
    std::unordered_set<QualifiedCatalogObjectID> referenced_schemas;
    auto retain_table = [&](CatalogTableID table_id, QualifiedCatalogObjectID schema_id) {
        if (table_id.GetOrigin() != analyzed.GetCatalogEntryId()) {
            referenced_entries.insert(table_id.GetOrigin());
            referenced_schemas.insert(schema_id);
        }
    };
    for (auto& chunk : analyzed.table_references.GetChunks()) {
        for (auto& ref : chunk) {
            if (auto* relation = std::get_if<TableReference::RelationExpression>(&ref.inner)) {
                if (auto& resolved = relation->resolved_table) {
                    retain_table(resolved->catalog_table_id.UnpackTableID(), resolved->catalog_schema_id);
                }
                for (auto& alternative : relation->resolved_alternatives) {
                    retain_table(alternative.catalog_table_id.UnpackTableID(), alternative.catalog_schema_id);
                }
            }
        }
    }
    for (auto& chunk : analyzed.expressions.GetChunks()) {
        for (auto& expression : chunk) {
            if (auto* column = std::get_if<Expression::ColumnRef>(&expression.inner)) {
                if (auto ids = column->GetResolvedColumnIDs()) {
                    retain_table(ids->catalog_table_column_id.UnpackTableColumnID().first, ids->catalog_schema_id);
                }
            }
        }
    }
    for (auto& chunk : analyzed.name_scopes.GetChunks()) {
        for (auto& scope : chunk) {
            for (auto& [name, ref] : scope.referenced_tables_by_name) {
                if (auto* table = std::get_if<std::reference_wrapper<const CatalogEntry::TableDeclaration>>(&ref.source)) {
                    retain_table(table->get().GetTableID(), table->get().catalog_schema_id);
                }
            }
            for (auto& column : scope.output_columns) {
                if (auto ids = column.GetResolvedIDs()) {
                    retain_table(ids->catalog_table_column_id.UnpackTableColumnID().first, ids->catalog_schema_id);
                }
            }
        }
    }
    for (auto& chunk : analyzed.insert_statements.GetChunks()) {
        for (auto& insert : chunk) {
            for (auto& column : insert.target_columns) {
                if (column.resolved) {
                    auto& table = column.resolved->get().table->get();
                    retain_table(table.GetTableID(), table.catalog_schema_id);
                }
            }
        }
    }
    // Function calls currently own script-local names, not catalog declaration
    // references. Only dependencies on already-published generations are leased.
    auto dependencies = std::make_shared<std::vector<std::shared_ptr<const void>>>();
    auto& retained = *dependencies;
    retained.reserve(referenced_entries.size() + referenced_schemas.size() * 2);
    for (auto& [key, entry] : script_entries) {
        if (referenced_entries.contains(entry.analyzed->GetCatalogEntryId())) retained.push_back(entry.analyzed);
    }
    for (auto id : referenced_entries) {
        if (auto iter = descriptor_entries.find(id); iter != descriptor_entries.end()) retained.push_back(iter->second);
    }
    std::unordered_set<CatalogDatabaseID> referenced_databases;
    for (auto& [key, entry] : schemas) {
        if (referenced_schemas.contains(entry->object_id)) {
            retained.push_back(entry);
            referenced_databases.insert(entry->GetDatabaseID());
        }
    }
    for (auto& [key, entry] : databases) {
        if (referenced_databases.contains(entry->GetDatabaseID())) retained.push_back(entry);
    }
    analyzed.retained_catalog_dependencies = std::move(dependencies);
}

QualifiedCatalogObjectID Catalog::ReserveDatabaseId(std::string_view database) {
    if (auto iter = database_ids_by_name.find(database); iter != database_ids_by_name.end()) {
        return QualifiedCatalogObjectID::Database(iter->second);
    }

    auto id = next_database_id++;
    database_ids_by_name.emplace(std::string{database}, id);
    return QualifiedCatalogObjectID::Database(id);
}

QualifiedCatalogObjectID Catalog::ReserveSchemaId(std::string_view database, std::string_view schema,
                                                   QualifiedCatalogObjectID db_id) {
    std::pair<std::string_view, std::string_view> key{database, schema};
    if (auto iter = schema_ids_by_name.find(key); iter != schema_ids_by_name.end()) {
        assert(iter->second.UnpackSchemaID().first == db_id.UnpackDatabaseID());
        return iter->second;
    }

    auto schema_id = next_schema_id++;
    auto id = QualifiedCatalogObjectID::Schema(db_id.UnpackDatabaseID(), schema_id);
    schema_ids_by_name.emplace(std::pair<std::string, std::string>{database, schema}, id);
    return id;
}

void Catalog::Clear() {
    entries_by_qualified_schema.clear();
    entries_by_schema.clear();
    entries_ranked.clear();
    entries.clear();
    script_entries.clear();
    descriptor_entries.clear();
    schemas.clear();
    databases.clear();
    ++version;
}

flatbuffers::Offset<buffers::catalog::CatalogEntries> Catalog::DescribeEntries(
    flatbuffers::FlatBufferBuilder& builder) const {
    std::vector<flatbuffers::Offset<buffers::catalog::CatalogEntry>> entryOffsets;
    entryOffsets.reserve(entries_ranked.size());
    for (auto& [rank, external_id] : entries_ranked) {
        auto* entry = entries.at(external_id);
        entryOffsets.push_back(entry->DescribeEntry(builder));
    }
    auto entriesOffset = builder.CreateVector(entryOffsets);
    buffers::catalog::CatalogEntriesBuilder entriesBuilder{builder};
    entriesBuilder.add_entries(entriesOffset);
    return entriesBuilder.Finish();
}

flatbuffers::Offset<buffers::catalog::CatalogEntries> Catalog::DescribeEntriesOf(
    flatbuffers::FlatBufferBuilder& builder, size_t external_id) const {
    auto iter = entries.find(external_id);
    if (iter == entries.end()) {
        return {};
    } else {
        std::vector<flatbuffers::Offset<buffers::catalog::CatalogEntry>> entryOffsets;
        entryOffsets.reserve(entries_ranked.size());
        entryOffsets.push_back(iter->second->DescribeEntry(builder));
        auto entriesOffset = builder.CreateVector(entryOffsets);
        buffers::catalog::CatalogEntriesBuilder entriesBuilder{builder};
        entriesBuilder.add_entries(entriesOffset);
        return entriesBuilder.Finish();
    }
}

/// Flatten the catalog
flatbuffers::Offset<buffers::catalog::FlatCatalog> Catalog::Flatten(flatbuffers::FlatBufferBuilder& builder) const {
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
        QualifiedCatalogObjectID table_id;
        // A name id
        size_t name_id;
        // Child nodes
        ChunkBuffer<ColumnNode, 16>::ConstTupleIterator children_begin;
        // Child count
        size_t child_count;
    };

    struct SchemaNode {
        // The catalog object id
        QualifiedCatalogObjectID schema_id;
        // A name id
        size_t name_id;
        // Child nodes
        std::map<std::string_view, std::reference_wrapper<TableNode>> children;
    };

    struct DatabaseNode {
        // The catalog object id
        QualifiedCatalogObjectID database_id;
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
    std::unordered_map<QualifiedCatalogObjectID, DatabaseNode*> database_node_map;
    std::unordered_map<QualifiedCatalogObjectID, SchemaNode*> schema_node_map;

    // Visit entries and databases in a defined order, the name dictionary must not depend on the hash implementation
    for (auto& [rank, catalog_entry_id] : entries_ranked) {
        auto* catalog_entry = entries.at(catalog_entry_id);
        /// Register all databases
        catalog_entry->database_references.ForEach([&](size_t, const CatalogEntry::DatabaseReference& db_ref) {
            if (auto iter = database_node_map.find(db_ref.object_id); iter == database_node_map.end()) {
                auto db_name = db_ref.database_name;
                auto db_name_id = add_name(db_ref.database_name);

                auto& db_node = database_nodes.PushBack(DatabaseNode{db_ref.object_id, db_name_id});
                database_node_map.insert({db_ref.object_id, &db_node});

                [[maybe_unused]] bool db_name_unique = root.insert({db_name, db_node}).second;
                assert(db_name_unique);
            }
        });

        /// Register all schemas
        for (auto& [schema_key, schema_ref_raw] : catalog_entry->schemas_by_qualified_name) {
            auto& schema_ref = schema_ref_raw.get();
            if (auto iter = schema_node_map.find(schema_ref.object_id); iter == schema_node_map.end()) {
                auto schema_name_id = add_name(schema_ref.schema_name);

                auto& schema_node = schema_nodes.PushBack(SchemaNode{schema_ref.object_id, schema_name_id});
                schema_node_map.insert({schema_ref.object_id, &schema_node});

                auto& db_node = database_node_map.at(QualifiedCatalogObjectID::Database(schema_ref.GetDatabaseID()));
                [[maybe_unused]] bool schema_name_unique =
                    db_node->children.insert({schema_ref.schema_name, schema_node}).second;
                assert(schema_name_unique);
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

                // Check if the schema node already contains a table.
                // This may happen if a table is overwritten between catalog entries.
                // Check which wins based on the catalog entry rank
                auto& table_name = entry.table_name.table_name;
                if (schema_node->children.contains(table_name.get().text)) {
                    continue;
                }

                // Add all columns nodes
                auto columns_begin = column_nodes.GetIteratorAtLast();
                if (entry.table_columns.size() > 0) {
                    auto& first_column = entry.table_columns[0];
                    auto first_column_name_id = add_name(first_column.column_name.get().text);
                    column_nodes.PushBack(ColumnNode{0, first_column_name_id});
                    columns_begin = column_nodes.GetIteratorAtLast();

                    for (uint32_t column_id = 1; column_id < entry.table_columns.size(); ++column_id) {
                        auto& column = entry.table_columns[column_id];
                        auto column_name_id = add_name(column.column_name.get().text);
                        column_nodes.PushBack(ColumnNode{column_id, column_name_id});
                    }
                }
                auto column_count = entry.table_columns.size();

                // Get the table declaration
                auto table_name_id = add_name(table_name.get().text);
                auto& table_node =
                    table_nodes.PushBack(TableNode{entry.object_id, table_name_id, columns_begin, column_count});
                schema_node->children.insert({table_name.get().text, table_node});
                ++effective_table_count;
            }
        }
    }

    // Write the dictionary vector
    auto dictionary = builder.CreateVectorOfStrings(name_dictionary);

    // Allocate the entry node vectors
    std::vector<dashql::buffers::catalog::FlatCatalogEntry> database_entries;
    std::vector<dashql::buffers::catalog::FlatCatalogEntry> schema_entries;
    std::vector<dashql::buffers::catalog::FlatCatalogEntry> table_entries;
    std::vector<dashql::buffers::catalog::FlatCatalogEntry> column_entries;
    database_entries.resize(database_nodes.GetSize());
    schema_entries.resize(schema_nodes.GetSize());
    table_entries.resize(effective_table_count);
    column_entries.resize(column_nodes.GetSize());

    // Allocate the index vectors
    std::vector<buffers::catalog::IndexedFlatDatabaseEntry> indexed_database_entries;
    std::vector<buffers::catalog::IndexedFlatSchemaEntry> indexed_schema_entries;
    std::vector<buffers::catalog::IndexedFlatTableEntry> indexed_table_entries;
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
        database_entries[next_database_idx] =
            buffers::catalog::FlatCatalogEntry(next_database_idx, 0, db_node_ref.database_id.UnpackDatabaseID(),
                                               db_node_ref.name_id, next_schema_idx, db_node_ref.children.size());
        indexed_database_entries[next_database_idx] =
            buffers::catalog::IndexedFlatDatabaseEntry(db_node_ref.database_id.UnpackDatabaseID(), next_database_idx);

        // Write schema nodes
        for (auto db_child_iter = db_node_ref.children.begin(); db_child_iter != db_node_ref.children.end();
             ++db_child_iter, ++next_schema_idx) {
            auto& [schema_name, schema_node] = *db_child_iter;
            // Write schema node
            auto& schema_node_ref = schema_node.get();
            schema_entries[next_schema_idx] = dashql::buffers::catalog::FlatCatalogEntry(
                next_schema_idx, next_database_idx, schema_node_ref.schema_id.UnpackSchemaID().second,
                schema_node_ref.name_id, next_table_idx, schema_node_ref.children.size());
            indexed_schema_entries[next_schema_idx] = buffers::catalog::IndexedFlatSchemaEntry(
                schema_node_ref.schema_id.UnpackSchemaID().second, next_schema_idx);

            // Write table nodes
            for (auto schema_child_iter = schema_node_ref.children.begin();
                 schema_child_iter != schema_node_ref.children.end(); ++schema_child_iter, ++next_table_idx) {
                auto& [table_name, table_node] = *schema_child_iter;
                // Write table node
                auto& table_node_ref = table_node.get();
                table_entries[next_table_idx] = dashql::buffers::catalog::FlatCatalogEntry(
                    next_table_idx, next_schema_idx, table_node_ref.table_id.UnpackTableID().Pack(),
                    table_node_ref.name_id, next_column_idx, table_node_ref.child_count);
                indexed_table_entries[next_table_idx] = buffers::catalog::IndexedFlatTableEntry(
                    table_node_ref.table_id.UnpackTableID().Pack(), next_table_idx);

                // Write column nodes
                auto child_iter = table_node_ref.children_begin;
                for (size_t column_id = 0; column_id < table_node_ref.child_count;
                     ++column_id, ++child_iter, ++next_column_idx) {
                    auto& column_node = *child_iter;
                    // Write column node
                    column_entries[next_column_idx] = dashql::buffers::catalog::FlatCatalogEntry(
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
    buffers::catalog::FlatCatalogBuilder catalogBuilder{builder};
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

void Catalog::LoadScript(Script& script, CatalogEntry::Rank rank) {
    ScriptBatchEntry entry{&script, rank};
    LoadScripts(std::span{&entry, 1});
}

void Catalog::LoadScripts(std::span<const ScriptBatchEntry> scripts) {
    if (scripts.empty()) {
        return;
    }

    std::unordered_set<Script*> batch_scripts;
    std::unordered_map<CatalogEntryID, Script*> batch_ids;

    for (auto [script, rank] : scripts) {
        (void)rank;
        if (script == nullptr || &script->catalog != this) {
            throw Exception(buffers::status::StatusCode::CATALOG_MISMATCH);
        }
        if (!script->analyzed_script) {
            throw Exception(buffers::status::StatusCode::CATALOG_SCRIPT_NOT_ANALYZED);
        }
        if (!batch_scripts.insert(script).second ||
            !batch_ids.emplace(script->GetCatalogEntryId(), script).second) {
            throw Exception(buffers::status::StatusCode::EXTERNAL_ID_COLLISION);
        }
        if (auto iter = entries.find(script->GetCatalogEntryId());
            iter != entries.end() && iter->second != script->analyzed_script.get() && !script_entries.contains(script)) {
            throw Exception(buffers::status::StatusCode::EXTERNAL_ID_COLLISION);
        }
        for (auto& [name, ref] : script->analyzed_script->GetDatabasesByName()) {
            auto canonical = database_ids_by_name.find(name);
            if (canonical == database_ids_by_name.end() ||
                ref.get().object_id != QualifiedCatalogObjectID::Database(canonical->second)) {
                throw Exception(buffers::status::StatusCode::CATALOG_ID_OUT_OF_SYNC);
            }
        }
        for (auto& [name, ref] : script->analyzed_script->GetSchemasByName()) {
            auto canonical = schema_ids_by_name.find(name);
            if (canonical == schema_ids_by_name.end() || ref.get().object_id != canonical->second) {
                throw Exception(buffers::status::StatusCode::CATALOG_ID_OUT_OF_SYNC);
            }
        }
    }

    decltype(script_entries) staged_script_entries;
    staged_script_entries.reserve(script_entries.size() + scripts.size());
    for (auto& [script, entry] : script_entries) {
        staged_script_entries.emplace(script, entry);
    }
    for (auto [script, rank] : scripts) {
        staged_script_entries.erase(script);
        staged_script_entries.emplace(script, ScriptEntry{*script, script->analyzed_script, rank});
    }

    PublishEntries(std::move(staged_script_entries), descriptor_entries);
}

void Catalog::PublishEntries(decltype(script_entries) staged_script_entries,
                             decltype(descriptor_entries) staged_descriptor_entries) {

    decltype(entries) staged_entries;
    decltype(entries_ranked) staged_entries_ranked;
    decltype(entries_by_qualified_schema) staged_entries_by_qualified_schema;
    decltype(entries_by_schema) staged_entries_by_schema;
    decltype(databases) staged_databases;
    decltype(schemas) staged_schemas;
    staged_entries.reserve(staged_script_entries.size() + staged_descriptor_entries.size());

    auto stage_entry = [&](CatalogEntry& analyzed, CatalogEntry::Rank rank) {
        auto entry_id = analyzed.GetCatalogEntryId();
        if (!staged_entries.emplace(entry_id, &analyzed).second) {
            throw Exception(buffers::status::StatusCode::EXTERNAL_ID_COLLISION);
        }
        staged_entries_ranked.emplace(rank, entry_id);

        for (auto& [name, ref] : analyzed.GetDatabasesByName()) {
            auto iter = staged_databases.find(name);
            if (iter != staged_databases.end()) {
                if (iter->second->object_id != ref.get().object_id) {
                    throw Exception(buffers::status::StatusCode::CATALOG_ID_OUT_OF_SYNC);
                }
                continue;
            }
            auto declaration = std::make_shared<DatabaseDeclaration>(
                ref.get().object_id, ref.get().database_name, ref.get().database_alias);
            std::string_view key = declaration->database_name;
            staged_databases.emplace(key, std::move(declaration));
        }
        for (auto& [name, ref] : analyzed.GetSchemasByName()) {
            auto iter = staged_schemas.find(name);
            if (iter != staged_schemas.end()) {
                if (iter->second->object_id != ref.get().object_id) {
                    throw Exception(buffers::status::StatusCode::CATALOG_ID_OUT_OF_SYNC);
                }
                continue;
            }
            auto database = staged_databases.find(name.first);
            if (database == staged_databases.end()) {
                throw Exception(buffers::status::StatusCode::CATALOG_ID_OUT_OF_SYNC);
            }
            auto declaration = std::make_shared<SchemaDeclaration>(
                ref.get().object_id, database->first, ref.get().schema_name);
            std::pair<std::string_view, std::string_view> key{declaration->database_name,
                                                              declaration->schema_name};
            staged_schemas.emplace(key, std::move(declaration));
        }
        for (auto& [name, ref] : analyzed.GetSchemasByName()) {
            CatalogSchemaEntryInfo info{entry_id, ref.get().object_id};
            staged_entries_by_qualified_schema.emplace(
                std::tuple{name.first, name.second, rank, entry_id}, info);
            staged_entries_by_schema.emplace(std::tuple{name.second, rank, entry_id}, info);
        }
    };
    for (auto& [script, entry] : staged_script_entries) {
        stage_entry(*entry.analyzed, entry.rank);
    }
    for (auto& [id, entry] : staged_descriptor_entries) {
        stage_entry(*entry, entry->GetRank());
    }

    script_entries.swap(staged_script_entries);
    descriptor_entries.swap(staged_descriptor_entries);
    entries.swap(staged_entries);
    entries_ranked.swap(staged_entries_ranked);
    entries_by_qualified_schema.swap(staged_entries_by_qualified_schema);
    entries_by_schema.swap(staged_entries_by_schema);
    databases.swap(staged_databases);
    schemas.swap(staged_schemas);
    ++version;
}

void Catalog::ReplaceDescriptor(CatalogEntryID id, CatalogEntry::Rank rank, std::span<const uint8_t> descriptor) {
    if (id < INITIAL_ENTRY_ID || id >= next_entry_id ||
        (entries.contains(id) && !descriptor_entries.contains(id))) {
        throw std::invalid_argument("invalid or colliding receiver catalog entry ID");
    }
    auto pool = std::make_shared<DescriptorPool>(descriptor);
    auto staged = descriptor_entries;
    auto entry = std::make_shared<DescriptorEntry>(*this, id, rank, std::move(pool));
    entry->catalog_version = version + 1;
    staged[id] = std::move(entry);
    PublishEntries(script_entries, std::move(staged));
}

void Catalog::DropDescriptor(CatalogEntryID id) {
    if (!descriptor_entries.contains(id)) return;
    auto staged = descriptor_entries;
    staged.erase(id);
    PublishEntries(script_entries, std::move(staged));
}

void Catalog::DropScript(Script& script) {
    auto iter = script_entries.find(&script);
    if (iter != script_entries.end()) {
        auto external_id = script.GetCatalogEntryId();
        if (iter->second.analyzed) {
            auto& analyzed = iter->second.analyzed;
            for (auto& [schema_key, entry_info] : analyzed->schemas_by_qualified_name) {
                auto& [db_name, schema_name] = schema_key;
                entries_by_qualified_schema.erase({db_name, schema_name, iter->second.rank, external_id});
                entries_by_schema.erase({schema_name, iter->second.rank, external_id});
            }
        }
        entries_ranked.erase({iter->second.rank, external_id});
        entries.erase(external_id);
        // Destruction also drops scripts. Prune in place without allocating a new publication.
        // Keep the analyzed owner alive until all string-view index keys have been removed.
        auto& analyzed = iter->second.analyzed;
        for (auto& [key, ref] : analyzed->GetSchemasByName()) {
            auto remaining = entries_by_qualified_schema.lower_bound({key.first, key.second, 0, 0});
            if (remaining == entries_by_qualified_schema.end() ||
                std::get<0>(remaining->first) != key.first || std::get<1>(remaining->first) != key.second) {
                schemas.erase(key);
            }
        }
        for (auto& [name, ref] : analyzed->GetDatabasesByName()) {
            bool referenced = false;
            for (auto& [id, entry] : entries) {
                if (entry->GetDatabasesByName().contains(name)) {
                    referenced = true;
                    break;
                }
            }
            if (!referenced) databases.erase(name);
        }
        script_entries.erase(iter);
        ++version;
    }
}

const CatalogEntry::TableDeclaration* Catalog::ResolveTable(CatalogTableID table_id) const {
    if (auto iter = entries.find(table_id.GetOrigin()); iter != entries.end()) {
        return iter->second->ResolveTableById(table_id);
    } else {
        return nullptr;
    }
}
void Catalog::ResolveTable(CatalogEntry::QualifiedTableName name, CatalogEntryID ignore_entry,
                           std::vector<std::reference_wrapper<const CatalogEntry::TableDeclaration>>& out,
                           size_t limit) const {
    // Always check if there are schema entries that contains the fully qualified name.
    // "Fully qualified" just means that we're doing direct lookups here and not a path suffix search.
    // If someone registered a name as `"".""."foo"` and then searches for "foo", there will be a direct hit here.
    for (auto iter = entries_by_qualified_schema.lower_bound({name.database_name.get(), name.schema_name.get(), 0, 0}),
              end = entries_by_qualified_schema.upper_bound({name.database_name.get(), name.schema_name.get(),
                                                             std::numeric_limits<CatalogEntry::Rank>::max(),
                                                             std::numeric_limits<CatalogEntryID>::max()});
         iter != end; ++iter) {
        auto& [db_name, schema_name, rank, candidate] = iter->first;
        if (candidate == ignore_entry) {
            continue;
        }
        assert(entries.contains(candidate));
        auto& entry = entries.at(candidate);
        auto tbl = entry->tables_by_qualified_name.find(name);
        if (tbl != entry->tables_by_qualified_name.end()) {
            out.push_back(tbl->second.get());
            if (out.size() >= limit) {
                break;
            }
        }
    };

    // If we have a direct hit we always return early.
    // There's an interesting special case if the catalog contains `"".""."foo"`.
    // Do we want to report ambiguity if there's:
    //  - "".""."foo"
    //  - ""."bar"."foo"
    //
    // We could, but we can also say that registering global names in the catalog overrules everything.
    // For now, we'll go with overrulling.
    if (out.size() > 0) {
        return;
    }

    // Database is empty?
    // Then we search cross-database
    if (name.database_name.get() == "") {
        // Schema name is not empty?
        // Filter catalog entries by schema name then
        if (name.schema_name.get() != "") {
            // Table + schema name?
            // Find all catalog entries that contain a schema name independent of the database name.
            // The output will be sorted by rank.
            for (auto iter = entries_by_schema.lower_bound({name.schema_name.get().text, 0, 0}),
                      end = entries_by_schema.upper_bound({name.schema_name.get().text,
                                                           std::numeric_limits<CatalogEntry::Rank>::max(),
                                                           std::numeric_limits<CatalogEntryID>::max()});
                 iter != end; ++iter) {
                auto& [schema_name, rank, candidate] = iter->first;
                if (candidate == ignore_entry) {
                    continue;
                }
                assert(entries.contains(candidate));
                auto& schema = entries.at(candidate);

                // Resolve all tables cross-database
                schema->ResolveTableInSchema(schema_name, name.table_name.get(), out, limit);
                if (out.size() >= limit) {
                    break;
                }
            };
            return;
        } else {
            // Schema name is empty, we only have the table name.
            // This is the most fuzzy resolution.
            // We go through all the entries ordered by rank and collect all matches until we hit the limit.
            for (auto& [rank, external_id] : entries_ranked) {
                if (external_id == ignore_entry) continue;
                auto& entry = *entries.at(external_id);
                entry.ResolveTableEverywhere(name.table_name.get(), out, limit);
                if (out.size() >= limit) {
                    break;
                }
            }
        }
    }
}

/// Get statisics
std::unique_ptr<buffers::catalog::CatalogStatisticsT> Catalog::GetStatistics() {
    auto stats = std::make_unique<buffers::catalog::CatalogStatisticsT>();

    auto content = std::make_unique<buffers::catalog::CatalogContentStatistics>();
    content->mutate_database_count(databases.size());
    content->mutate_schema_count(schemas.size());
    size_t table_count = 0;
    size_t column_count = 0;
    for (auto& [id, entry] : entries) {
        table_count += entry->GetTables().GetSize();
        for (auto& chunk : entry->GetTables().GetChunks()) {
            for (auto& table : chunk) column_count += table.table_columns.size();
        }
    }
    content->mutate_table_count(table_count);
    content->mutate_table_column_count(column_count);
    stats->content = std::move(content);

    return stats;
}
