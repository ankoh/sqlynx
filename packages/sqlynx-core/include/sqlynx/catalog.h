#pragma once

#include <flatbuffers/buffer.h>
#include <flatbuffers/flatbuffer_builder.h>

#include <functional>
#include <limits>
#include <optional>
#include <span>
#include <string_view>
#include <tuple>

#include "sqlynx/external.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/text/names.h"
#include "sqlynx/utils/btree/map.h"
#include "sqlynx/utils/btree/set.h"
#include "sqlynx/utils/chunk_buffer.h"
#include "sqlynx/utils/hash.h"
#include "sqlynx/utils/overlay_list.h"
#include "sqlynx/utils/string_conversion.h"

namespace sqlynx {

namespace sx = sqlynx::proto;

class Catalog;
class Script;
class AnalyzedScript;
using CatalogDatabaseID = uint32_t;
using CatalogSchemaID = uint32_t;

constexpr uint32_t PROTO_NULL_U32 = std::numeric_limits<uint32_t>::max();
constexpr CatalogDatabaseID INITIAL_DATABASE_ID = 1 << 8;
constexpr CatalogSchemaID INITIAL_SCHEMA_ID = 1 << 16;

/// A schema stores database metadata.
/// It is used as a virtual container to expose table and column information to the analyzer.
class CatalogEntry {
    friend class Catalog;
    friend class Script;
    friend class ScriptCursor;

   public:
    using NameID = uint32_t;
    using Rank = uint32_t;

    using NameSearchIndex = btree::multimap<fuzzy_ci_string_view, std::reference_wrapper<const RegisteredName>>;

    /// A key for a qualified table name
    /// A qualified table name
    struct QualifiedTableName {
        using Key = std::tuple<std::string_view, std::string_view, std::string_view>;
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The database name, may refer to different context
        std::string_view database_name;
        /// The schema name, may refer to different context
        std::string_view schema_name;
        /// The table name, may refer to different context
        std::string_view table_name;
        /// Constructor
        QualifiedTableName(Key key)
            : ast_node_id(std::nullopt),
              database_name(std::get<0>(key)),
              schema_name(std::get<1>(key)),
              table_name(std::get<2>(key)) {}
        /// Constructor
        QualifiedTableName(std::optional<uint32_t> ast_node_id = std::nullopt, std::string_view database_name = {},
                           std::string_view schema_name = {}, std::string_view table_name = {})
            : ast_node_id(ast_node_id),
              database_name(database_name),
              schema_name(schema_name),
              table_name(table_name) {}
        /// Pack as FlatBuffer
        flatbuffers::Offset<proto::QualifiedTableName> Pack(flatbuffers::FlatBufferBuilder& builder) const;
        /// Construct a key
        operator Key() { return {database_name, schema_name, table_name}; }
    };
    /// A qualified column name
    struct QualifiedColumnName {
        using Key = std::pair<std::string_view, std::string_view>;
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The table alias
        std::string_view table_alias;
        /// The column name
        std::string_view column_name;
        /// Constructor
        QualifiedColumnName(std::optional<uint32_t> ast_node_id = std::nullopt, std::string_view table_alias = {},
                            std::string_view column_name = {})
            : ast_node_id(ast_node_id), table_alias(table_alias), column_name(column_name) {}
        /// Pack as FlatBuffer
        flatbuffers::Offset<proto::QualifiedColumnName> Pack(flatbuffers::FlatBufferBuilder& builder) const;
        /// Construct a key
        operator Key() { return {table_alias, column_name}; }
    };
    /// A table column
    struct TableColumn : NamedObject {
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The column name
        std::string_view column_name;
        /// Constructor
        TableColumn(std::optional<uint32_t> ast_node_id = {}, std::string_view column_name = {})
            : NamedObject(NamedObjectType::Table), ast_node_id(ast_node_id), column_name(column_name) {}
        /// Pack as FlatBuffer
        flatbuffers::Offset<proto::TableColumn> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };
    /// A table declaration
    struct TableDeclaration : NamedObject {
        /// The id of the table in the catalog
        ExternalObjectID catalog_table_id;
        /// The catalog database id
        CatalogDatabaseID catalog_database_id;
        /// The catalog schema id
        CatalogSchemaID catalog_schema_id;
        /// The database reference id
        size_t database_reference_id;
        /// The schema reference id
        size_t schema_reference_id;
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The AST statement id in the target script
        std::optional<uint32_t> ast_statement_id;
        /// The AST scope root id in the target script
        std::optional<uint32_t> ast_scope_root;
        /// The table name
        QualifiedTableName table_name;
        /// The begin of the column
        std::vector<TableColumn> table_columns;

        /// Constructor
        TableDeclaration() : NamedObject(NamedObjectType::Table) {}
        /// Pack as FlatBuffer
        flatbuffers::Offset<proto::Table> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };
    /// A resolved table column
    struct ResolvedTableColumn {
        /// The table
        const TableDeclaration& table;
        /// The index in the table
        size_t table_column_index;
    };
    /// A database name declaration
    struct DatabaseReference : NamedObject {
        /// The catalog database id.
        /// This ID is only preliminary if the entry has not been added to the catalog yet.
        /// Adding the entry to the catalog might fail if this id becomes invalid.
        CatalogDatabaseID catalog_database_id;
        /// The database name
        std::string_view database_name;
        /// The database alias (if any)
        std::string_view database_alias;
        /// Constructor
        DatabaseReference(CatalogDatabaseID database_id, std::string_view database_name,
                          std::string_view database_alias)
            : NamedObject(NamedObjectType::Database),
              catalog_database_id(database_id),
              database_name(database_name),
              database_alias(database_alias) {}
        /// Pack as FlatBuffer
        flatbuffers::Offset<proto::DatabaseDeclaration> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };
    /// A schema name declaration
    struct SchemaReference : NamedObject {
        /// The catalog database id
        /// This ID is only preliminary if the entry has not been added to the catalog yet.
        /// Adding the entry to the catalog might fail if this id becomes invalid.
        CatalogDatabaseID catalog_database_id;
        /// The catalog schema id.
        /// This ID is only preliminary if the entry has not been added to the catalog yet.
        /// Adding the entry to the catalog might fail if this id becomes invalid.
        CatalogSchemaID catalog_schema_id;
        /// The database name
        std::string_view database_name;
        /// The schema name
        std::string_view schema_name;
        /// Constructor
        SchemaReference(CatalogDatabaseID database_id, CatalogSchemaID schema_id, std::string_view database_name,
                        std::string_view schema_name)
            : NamedObject(NamedObjectType::Schema),
              catalog_database_id(database_id),
              catalog_schema_id(schema_id),
              database_name(database_name),
              schema_name(schema_name) {}
        /// Pack as FlatBuffer
        flatbuffers::Offset<proto::SchemaDeclaration> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };

   protected:
    /// The catalog
    Catalog& catalog;
    /// The catalog entry id
    const CatalogEntryID catalog_entry_id;
    /// The referenced databases
    ChunkBuffer<DatabaseReference, 16> database_references;
    /// The referenced schemas
    ChunkBuffer<SchemaReference, 16> schema_references;
    /// The table definitions
    ChunkBuffer<TableDeclaration, 16> table_declarations;
    /// The databases, indexed by name
    std::unordered_map<std::string_view, std::reference_wrapper<const DatabaseReference>> databases_by_name;
    /// The schema, indexed by name
    std::unordered_map<std::tuple<std::string_view, std::string_view>, std::reference_wrapper<const SchemaReference>,
                       TupleHasher>
        schemas_by_name;
    /// The tables, indexed by name
    std::unordered_map<QualifiedTableName::Key, std::reference_wrapper<const TableDeclaration>, TupleHasher>
        tables_by_name;
    /// The table columns, indexed by the name
    std::unordered_multimap<std::string_view, std::pair<std::reference_wrapper<const TableDeclaration>, size_t>>
        table_columns_by_name;
    /// The name search index
    std::optional<CatalogEntry::NameSearchIndex> name_search_index;

   public:
    /// Construcutor
    CatalogEntry(Catalog& catalog, CatalogEntryID external_id);

    /// Get the external id
    CatalogEntryID GetCatalogEntryId() const { return catalog_entry_id; }
    /// Get the database declarations
    auto& GetDatabases() const { return database_references; }
    /// Get the database declarations by name
    auto& GetDatabasesByName() const { return databases_by_name; }
    /// Get the schema declarations
    auto& GetSchemas() const { return schema_references; }
    /// Get the schema declarations by name
    auto& GetSchemasByName() const { return schemas_by_name; }
    /// Get the table declarations
    auto& GetTables() const { return table_declarations; }
    /// Get the table declarations by name
    auto& GetTablesByName() const { return tables_by_name; }

    /// Get the qualified name
    QualifiedTableName QualifyTableName(QualifiedTableName name) const;

    /// Register a database name
    CatalogDatabaseID RegisterDatabaseName(std::string_view);
    /// Register a schema name
    CatalogSchemaID RegisterSchemaName(CatalogDatabaseID db_id, std::string_view db_name, std::string_view schema_name);

    /// Describe the catalog entry
    virtual flatbuffers::Offset<proto::CatalogEntry> DescribeEntry(flatbuffers::FlatBufferBuilder& builder) const = 0;
    /// Get the name search index
    virtual const NameSearchIndex& GetNameSearchIndex() = 0;

    /// Resolve a table by id
    const TableDeclaration* ResolveTable(ExternalObjectID table_id) const;
    /// Resolve a table by id
    const TableDeclaration* ResolveTable(ExternalObjectID table_id, const Catalog& catalog) const;
    /// Resolve a table by name
    const TableDeclaration* ResolveTable(QualifiedTableName table_name) const;
    /// Resolve a table by name
    const TableDeclaration* ResolveTable(QualifiedTableName table_name, const Catalog& catalog) const;
    /// Find table columns by name
    void ResolveTableColumn(std::string_view table_column, std::vector<ResolvedTableColumn>& out) const;
    /// Find table columns by name
    void ResolveTableColumn(std::string_view table_column, const Catalog& catalog,
                            std::vector<ResolvedTableColumn>& out) const;
};

class DescriptorPool : public CatalogEntry {
   public:
    /// A schema descriptors
    struct Descriptor {
        /// The descriptor
        const proto::SchemaDescriptor& descriptor;
        /// The descriptor buffer
        std::unique_ptr<const std::byte[]> descriptor_buffer;
    };

   protected:
    /// The rank
    Rank rank;
    /// The schema descriptors
    std::vector<Descriptor> descriptor_buffers;
    /// The name registry
    NameRegistry name_registry;

   public:
    /// Construcutor
    DescriptorPool(Catalog& catalog, CatalogEntryID external_id, Rank rank);
    /// Get the rank
    auto GetRank() const { return rank; }

    /// Describe the catalog entry
    flatbuffers::Offset<proto::CatalogEntry> DescribeEntry(flatbuffers::FlatBufferBuilder& builder) const override;
    /// Get the name search index
    const NameSearchIndex& GetNameSearchIndex() override;

    /// Add a schema descriptor
    proto::StatusCode AddSchemaDescriptor(const proto::SchemaDescriptor& descriptor,
                                          std::unique_ptr<const std::byte[]> descriptor_buffer);
};

class Catalog {
   public:
    using Version = uint64_t;

   protected:
    /// A catalog entry backed by an analyzed script
    struct ScriptEntry {
        /// The script
        const Script& script;
        /// The analyzed script
        std::shared_ptr<AnalyzedScript> analyzed;
        /// The current rank
        CatalogEntry::Rank rank;
    };
    /// Information about a catalog entry referenced through the schema name
    struct CatalogSchemaEntryInfo {
        /// The id of the catalog entry
        CatalogEntryID catalog_entry_id;
        /// The id of the database <catalog_entry_id, database_idx>
        CatalogDatabaseID catalog_database_id;
        /// The id of the schema <catalog_entry_id, schema_idx>
        CatalogSchemaID catalog_schema_id;
    };
    /// A database declaration
    struct DatabaseDeclaration {
        /// The catalog database id
        CatalogDatabaseID catalog_database_id;
        /// The database name
        std::string database_name;
        /// The database alias (if any)
        std::string database_alias;
        /// Constructor
        DatabaseDeclaration(CatalogDatabaseID database_id, std::string_view database_name,
                            std::string_view database_alias)
            : catalog_database_id(database_id),
              database_name(std::move(database_name)),
              database_alias(std::move(database_alias)) {}
        /// Move constructor
        DatabaseDeclaration(DatabaseDeclaration&&) = default;
        /// Move assignment
        DatabaseDeclaration& operator=(DatabaseDeclaration&&) = default;
    };
    /// A schema declaration
    struct SchemaDeclaration {
        /// The catalog database id
        CatalogDatabaseID catalog_database_id;
        /// The catalog schema id
        CatalogSchemaID catalog_schema_id;
        /// The database name (references the name of the database entry)
        std::string_view database_name;
        /// The schema name
        std::string schema_name;
        /// Constructor
        SchemaDeclaration(CatalogDatabaseID database_id, CatalogSchemaID schema_id, std::string_view database_name,
                          std::string_view schema_name)
            : catalog_database_id(database_id),
              catalog_schema_id(schema_id),
              database_name(database_name),
              schema_name(std::move(schema_name)) {}
        /// Move constructor
        SchemaDeclaration(SchemaDeclaration&&) = default;
        /// Move assignment
        SchemaDeclaration& operator=(SchemaDeclaration&&) = default;
    };

    /// The catalog version.
    /// Every modification bumps the version counter, the analyzer reads the version counter which protects all refs.
    Version version = 1;
    /// The default database name
    const std::string default_database_name;
    /// The default schema name
    const std::string default_schema_name;

    /// The catalog entries
    std::unordered_map<CatalogEntryID, CatalogEntry*> entries;
    /// The script entries
    std::unordered_map<Script*, ScriptEntry> script_entries;
    /// The descriptor pool entries
    std::unordered_map<CatalogEntryID, std::unique_ptr<DescriptorPool>> descriptor_pool_entries;
    /// The entries ordered by <rank>
    btree::set<std::tuple<CatalogEntry::Rank, CatalogEntryID>> entries_ranked;
    /// The entries ordered by <database, schema, rank>
    btree::map<std::tuple<std::string_view, std::string_view, CatalogEntry::Rank, CatalogEntryID>,
               CatalogSchemaEntryInfo>
        entries_by_schema;

    /// The next database id
    CatalogDatabaseID next_database_id = INITIAL_DATABASE_ID;
    /// The next schema id
    CatalogSchemaID next_schema_id = INITIAL_SCHEMA_ID;
    /// The databases.
    /// The btrees contain all the databases that are currently referenced by catalog entries.
    btree::map<std::string_view, std::unique_ptr<DatabaseDeclaration>> databases;
    /// The schemas.
    /// These btrees contain all the schemas that are currently referenced by catalog entries.
    btree::map<std::pair<std::string_view, std::string_view>, std::unique_ptr<SchemaDeclaration>> schemas;

    /// Update a script entry
    proto::StatusCode UpdateScript(ScriptEntry& entry);

   public:
    /// Explicit constructor needed due to deleted copy constructor
    Catalog(std::string_view default_database_name = "", std::string_view default_schema_name = "");
    /// Catalogs must not be copied
    Catalog(const Catalog& other) = delete;
    /// Catalogs must not be copy-assigned
    Catalog& operator=(const Catalog& other) = delete;

    /// Get the current version of the registry
    uint64_t GetVersion() const { return version; }
    /// Get the default database name
    std::string_view GetDefaultDatabaseName() const { return default_database_name; }
    /// Get the default schema name
    std::string_view GetDefaultSchemaName() const { return default_schema_name; }

    /// Contains an entry id?
    bool Contains(CatalogEntryID id) const { return entries.contains(id); }
    /// Iterate all entries in arbitrary order
    template <typename Fn> void Iterate(Fn f) const {
        for (auto& [entry_id, entry] : entries) {
            f(entry_id, *entry);
        }
    }
    /// Iterate entries in ranked order
    template <typename Fn> void IterateRanked(Fn f) const {
        for (auto& [rank, id] : entries_ranked) {
            auto* schema = entries.at(id);
            f(id, *schema, rank);
        }
    }
    /// Register a database name
    CatalogDatabaseID AllocateDatabaseId(std::string_view database) {
        auto iter = databases.find(database);
        if (iter != databases.end()) {
            return iter->second->catalog_database_id;
        } else {
            return next_database_id++;
        }
    }
    /// Register a schema name
    CatalogSchemaID AllocateSchemaId(std::string_view database, std::string_view schema) {
        auto iter = schemas.find({database, schema});
        if (iter != schemas.end()) {
            return iter->second->catalog_schema_id;
        } else {
            return next_schema_id++;
        }
    }

    /// Clear a catalog
    void Clear();
    /// Describe catalog entries
    flatbuffers::Offset<proto::CatalogEntries> DescribeEntries(flatbuffers::FlatBufferBuilder& builder) const;
    /// Describe catalog entries
    flatbuffers::Offset<proto::CatalogEntries> DescribeEntriesOf(flatbuffers::FlatBufferBuilder& builder,
                                                                 size_t external_id) const;
    /// Flatten the catalog
    flatbuffers::Offset<proto::FlatCatalog> Flatten(flatbuffers::FlatBufferBuilder& builder) const;

    /// Add a script
    proto::StatusCode LoadScript(Script& script, CatalogEntry::Rank rank);
    /// Drop a script
    void DropScript(Script& script);
    /// Add a descriptor pool
    proto::StatusCode AddDescriptorPool(CatalogEntryID external_id, CatalogEntry::Rank rank);
    /// Drop a descriptor pool
    proto::StatusCode DropDescriptorPool(CatalogEntryID external_id);
    /// Add a schema descriptor as serialized FlatBuffer
    proto::StatusCode AddSchemaDescriptor(CatalogEntryID external_id, std::span<const std::byte> descriptor_data,
                                          std::unique_ptr<const std::byte[]> descriptor_buffer);

    /// Resolve a table by id
    const CatalogEntry::TableDeclaration* ResolveTable(ExternalObjectID table_id) const;
    /// Resolve a table by id
    const CatalogEntry::TableDeclaration* ResolveTable(CatalogEntry::QualifiedTableName table_name,
                                                       CatalogEntryID ignore_entry) const;
    /// Find table columns by name
    void ResolveTableColumn(std::string_view table_column, std::vector<CatalogEntry::ResolvedTableColumn>& out) const;
};

}  // namespace sqlynx
