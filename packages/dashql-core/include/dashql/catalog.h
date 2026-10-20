#pragma once

#include <flatbuffers/buffer.h>
#include <flatbuffers/flatbuffer_builder.h>

#include <functional>
#include <limits>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <tuple>
#include <unordered_map>
#include <variant>
#include <vector>

#include "dashql/buffers/index_generated.h"
#include "dashql/catalog_object.h"
#include "dashql/external.h"
#include "dashql/text/names.h"
#include "dashql/utils/btree/map.h"
#include "dashql/utils/btree/set.h"
#include "dashql/utils/chunk_buffer.h"
#include "dashql/utils/hash.h"
#include "dashql/utils/string_conversion.h"

namespace dashql {

class Catalog;
class Script;
class AnalyzedScript;
class DescriptorEntry;
using CatalogDatabaseID = uint32_t;
using CatalogSchemaID = uint32_t;
using CatalogTableID = ExternalObjectID;
using CatalogVersion = uint32_t;

constexpr uint32_t PROTO_NULL_U32 = std::numeric_limits<uint32_t>::max();
constexpr CatalogDatabaseID INITIAL_DATABASE_ID = 1 << 8;
constexpr CatalogSchemaID INITIAL_SCHEMA_ID = 1 << 16;
constexpr CatalogEntryID INITIAL_ENTRY_ID = 1;
constexpr std::string_view ANY_DATABASE = "\0";
constexpr std::string_view ANY_SCHEMA = "\0";

/// A schema stores database metadata.
/// It is used as a virtual container to expose table and column information to the analyzer.
class CatalogEntry {
    friend class Catalog;
    friend class Script;
    friend struct ScriptCursor;

   public:
    using NameID = uint32_t;
    using Rank = uint32_t;

    using NameSearchIndex = btree::multimap<fuzzy_ci_string_view, std::reference_wrapper<const RegisteredName>>;

    /// A qualified table name
    struct QualifiedTableName {
        /// A key for a qualified table name
        using Key = std::tuple<std::string_view, std::string_view, std::string_view>;

        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The database name, may refer to different context
        std::reference_wrapper<RegisteredName> database_name;
        /// The schema name, may refer to different context
        std::reference_wrapper<RegisteredName> schema_name;
        /// The table name, may refer to different context
        std::reference_wrapper<RegisteredName> table_name;
        /// Constructor
        QualifiedTableName(std::optional<uint32_t> ast_node_id, RegisteredName& database_name,
                           RegisteredName& schema_name, RegisteredName& table_name)
            : ast_node_id(ast_node_id),
              database_name(database_name),
              schema_name(schema_name),
              table_name(table_name) {}
        /// Copy assignment
        QualifiedTableName& operator=(const QualifiedTableName& other) {
            ast_node_id = other.ast_node_id;
            database_name = other.database_name;
            schema_name = other.schema_name;
            table_name = other.table_name;
            return *this;
        }
        /// Pack as FlatBuffer
        flatbuffers::Offset<buffers::analyzer::QualifiedTableName> Pack(flatbuffers::FlatBufferBuilder& builder) const;
        /// Construct a key
        operator Key() { return {database_name.get(), schema_name.get(), table_name.get()}; }
        /// Get debug string
        inline std::string getDebugString() const {
            std::string out;
            if (!database_name.get().text.empty()) {
                out += database_name.get().text;
                out += ".";
                out += schema_name.get().text;
                out += ".";
            } else if (!schema_name.get().text.empty()) {
                out += schema_name.get().text;
                out += ".";
            }
            out += table_name.get().text;
            return out;
        }
    };
    /// A qualified column name
    struct QualifiedColumnName {
        using Key = std::pair<std::string_view, std::string_view>;
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The table alias
        std::optional<std::reference_wrapper<RegisteredName>> table_alias;
        /// The column name
        std::reference_wrapper<RegisteredName> column_name;
        /// Constructor
        QualifiedColumnName(uint32_t ast_node_id, std::optional<std::reference_wrapper<RegisteredName>> table_alias,
                            RegisteredName& column_name)
            : ast_node_id(ast_node_id), table_alias(table_alias), column_name(column_name) {}
        /// Pack as FlatBuffer
        flatbuffers::Offset<buffers::analyzer::QualifiedColumnName> Pack(flatbuffers::FlatBufferBuilder& builder) const;
        /// Construct a key
        operator Key() {
            return {table_alias.has_value() ? table_alias.value().get().text : "", column_name.get().text};
        }
    };
    /// A qualified function name
    struct QualifiedFunctionName {
        /// A key for a qualified table name
        using Key = std::tuple<std::string_view, std::string_view, std::string_view>;

        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The database name, may refer to different context
        std::reference_wrapper<RegisteredName> database_name;
        /// The schema name, may refer to different context
        std::reference_wrapper<RegisteredName> schema_name;
        /// The function name, may refer to different context
        std::reference_wrapper<RegisteredName> function_name;
        /// Constructor
        QualifiedFunctionName(std::optional<uint32_t> ast_node_id, RegisteredName& database_name,
                              RegisteredName& schema_name, RegisteredName& function_name)
            : ast_node_id(ast_node_id),
              database_name(database_name),
              schema_name(schema_name),
              function_name(function_name) {}
        /// Copy assignment
        QualifiedFunctionName& operator=(const QualifiedFunctionName& other) {
            ast_node_id = other.ast_node_id;
            database_name = other.database_name;
            schema_name = other.schema_name;
            function_name = other.function_name;
            return *this;
        }
        /// Pack as FlatBuffer
        flatbuffers::Offset<buffers::analyzer::QualifiedFunctionName> Pack(
            flatbuffers::FlatBufferBuilder& builder) const;
        /// Construct a key
        operator Key() { return {database_name.get(), schema_name.get(), function_name.get()}; }
        /// Get debug string
        inline std::string getDebugString() const {
            std::string out;
            if (!database_name.get().text.empty()) {
                out += database_name.get().text;
                out += ".";
                out += schema_name.get().text;
                out += ".";
            } else if (!schema_name.get().text.empty()) {
                out += schema_name.get().text;
                out += ".";
            }
            out += function_name.get().text;
            return out;
        }
    };

    /// A function parameter
    struct FunctionParam {
        /// The AST node id
        std::optional<uint32_t> ast_node_id;
        /// The parameter name
        std::reference_wrapper<RegisteredName> param_name;
        /// The parameter type text
        std::string_view param_type;
        /// Constructor
        FunctionParam(std::optional<uint32_t> ast_node_id, RegisteredName& param_name, std::string_view param_type)
            : ast_node_id(ast_node_id), param_name(param_name), param_type(param_type) {}
    };
    /// A function declaration
    struct FunctionDeclaration : public CatalogObject {
        /// The catalog schema id
        QualifiedCatalogObjectID catalog_schema_id;
        /// Is aggregate
        bool is_aggregate = false;
        /// The AST node id
        uint32_t ast_node_id = std::numeric_limits<uint32_t>::max();
        /// The AST statement id
        std::optional<uint32_t> ast_statement_id;
        /// The function name
        QualifiedFunctionName function_name;
        /// The parameters
        std::vector<FunctionParam> params;
        /// The return type text
        std::string_view return_type;

        /// Constructor
        FunctionDeclaration(QualifiedCatalogObjectID schema, CatalogFunctionID function_id, QualifiedFunctionName name)
            : CatalogObject(QualifiedCatalogObjectID::Function(function_id)),
              catalog_schema_id(schema),
              function_name(std::move(name)) {}
        /// Get the function id
        CatalogFunctionID GetFunctionID() const { return object_id.UnpackFunctionID(); }
        /// Pack as FlatBuffer
        flatbuffers::Offset<buffers::analyzer::FunctionDeclaration> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };

    /// Forward declare the table
    struct TableDeclaration;
    /// A table column
    struct TableColumn : public CatalogObject {
        /// The parent table
        std::optional<std::reference_wrapper<TableDeclaration>> table;
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The column name
        std::reference_wrapper<RegisteredName> column_name;
        /// Constructor
        TableColumn(std::optional<uint32_t> ast_node_id, RegisteredName& column_name)
            : CatalogObject(QualifiedCatalogObjectID::Deferred()), ast_node_id(ast_node_id), column_name(column_name) {}
        /// Constructor
        TableColumn(CatalogTableID table_id, uint32_t column_id, std::optional<uint32_t> ast_node_id,
                    RegisteredName& column_name)
            : CatalogObject(QualifiedCatalogObjectID::TableColumn(table_id, column_id)),
              ast_node_id(ast_node_id),
              column_name(column_name) {}
        /// Get the column index
        CatalogTableID GetTableID() const { return object_id.UnpackTableColumnID().first; }
        /// Get the column index
        uint32_t GetColumnIndex() const { return object_id.UnpackTableColumnID().second; }
        /// Pack as FlatBuffer
        flatbuffers::Offset<buffers::analyzer::TableColumn> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };
    /// A table declaration
    struct TableDeclaration : public CatalogObject {
        /// The catalog version
        CatalogVersion catalog_version = 0;
        /// The catalog schema id
        QualifiedCatalogObjectID catalog_schema_id;
        /// The database reference id
        size_t database_reference_id = 0;
        /// The schema reference id
        size_t schema_reference_id = 0;
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The AST statement id in the target script
        std::optional<uint32_t> ast_statement_id;
        /// The AST scope root id in the target script
        std::optional<uint32_t> ast_scope_root;
        /// The table name
        QualifiedTableName table_name;
        /// The table columns
        std::vector<TableColumn> table_columns;
        /// A mini hash map of all columns.
        /// Maintaining this spares us from loading all table columns into a naming scope
        ankerl::unordered_dense::map<std::string_view, std::reference_wrapper<TableColumn>> table_columns_by_name;

        /// Constructor
        TableDeclaration(QualifiedCatalogObjectID schema, CatalogTableID table, QualifiedTableName table_name)
            : CatalogObject(QualifiedCatalogObjectID::Table(table)),
              catalog_schema_id(schema),
              table_name(std::move(table_name)) {}
        /// Get the table id
        CatalogTableID GetTableID() const { return object_id.UnpackTableID(); }
        /// Pack as FlatBuffer
        flatbuffers::Offset<buffers::analyzer::Table> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };
    /// A database name declaration
    struct DatabaseReference : public CatalogObject {
        /// The database name
        std::string_view database_name;
        /// The database alias (if any)
        std::string_view database_alias;
        /// Constructor
        ///
        /// The database ID is reserved canonically by the catalog.
        DatabaseReference(QualifiedCatalogObjectID database_id, std::string_view database_name,
                          std::string_view database_alias)
            : CatalogObject(database_id), database_name(database_name), database_alias(database_alias) {}
        /// Get the database id
        CatalogDatabaseID GetDatabaseID() const { return object_id.UnpackDatabaseID(); }
        /// Pack as FlatBuffer
        flatbuffers::Offset<buffers::analyzer::DatabaseDeclaration> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };
    /// A schema name declaration
    struct SchemaReference : public CatalogObject {
        /// The database name
        std::string_view database_name;
        /// The schema name
        std::string_view schema_name;
        /// Constructor
        ///
        /// Database and schema IDs are reserved canonically by the catalog.
        SchemaReference(QualifiedCatalogObjectID schema_id, std::string_view database_name,
                        std::string_view schema_name)
            : CatalogObject(schema_id), database_name(database_name), schema_name(schema_name) {}
        /// Get the database id
        CatalogDatabaseID GetDatabaseID() const { return object_id.UnpackSchemaID().first; }
        /// Get the schema id
        CatalogSchemaID GetSchemaID() const { return object_id.UnpackSchemaID().second; }
        /// Pack as FlatBuffer
        flatbuffers::Offset<buffers::analyzer::SchemaDeclaration> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };

   protected:
    /// The catalog
    Catalog& catalog;
    /// The version at which this catalog entry was last updated
    CatalogVersion catalog_version;
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
    /// The schemas indexed by qualified name.
    /// Key: (database, schema)
    ///
    /// We use this btree to find all schemas that belong to a database.
    btree::map<std::pair<std::string_view, std::string_view>, std::reference_wrapper<const SchemaReference>>
        schemas_by_qualified_name;
    /// The tables indexed by qualified name.
    /// Key: (database, schema, table)
    ///
    /// During catalog loading, we need to quickly find out if we know a qualified table name already.
    /// This hashmap allows us to probe existing tables and check if there's a name collision.
    std::unordered_map<QualifiedTableName::Key, std::reference_wrapper<const TableDeclaration>, TupleHasher>
        tables_by_qualified_name;
    /// The tables by name.
    /// Key: (table)
    ///
    /// We use this multimap to quickly find all table declarations if the table name is not qualified.
    /// Note that this name may easily be amgiguous then cross schemas.
    /// We pick an arbitrary match and emit an ambiguity warning
    /// Duplicate names keep their declaration order so that the pick does not depend on the hash implementation.
    btree::multimap<std::string_view, std::reference_wrapper<const TableDeclaration>> tables_by_unqualified_name;
    /// The tables indexed by schema name.
    /// Key: (schema, database)
    ///
    /// This index is used during dot completion.
    /// The user either gives us `<db>.<schema>.` or just `<schema>.` and we want to quickly find all matching tables.
    /// This can be done through a prefix search in this btree.
    btree::multimap<std::pair<std::string_view, std::string_view>, std::reference_wrapper<const TableDeclaration>>
        tables_by_unqualified_schema;
    /// The table columns indexed by the name.
    /// Key: (column)
    ///
    /// During SQL completion, we also want to find out what tables a column *might* come from.
    /// This is a more costly completion since a columns names might occur in many tables which are not yet in scope.
    /// Duplicate names keep their declaration order.
    btree::multimap<std::string_view, std::reference_wrapper<const TableColumn>> table_columns_by_name;
    /// The function declarations
    ChunkBuffer<FunctionDeclaration, 16> function_declarations;
    /// Functions indexed by qualified name
    std::unordered_map<QualifiedFunctionName::Key, std::reference_wrapper<const FunctionDeclaration>, TupleHasher>
        functions_by_qualified_name;
    /// Functions by unqualified name
    /// Duplicate names keep their declaration order.
    btree::multimap<std::string_view, std::reference_wrapper<const FunctionDeclaration>> functions_by_unqualified_name;
    /// The name search index.
    /// This name search index stores suffixes of all registered names.
    std::optional<CatalogEntry::NameSearchIndex> name_search_index;
    /// Lifetime-only ownership of referenced entries and namespace declarations.
    /// Resolution and completion still use the current catalog/version.
    std::shared_ptr<const std::vector<std::shared_ptr<const void>>> retained_catalog_dependencies;

   public:
    /// Construcutor
    CatalogEntry(Catalog& catalog, CatalogEntryID external_id);

    /// Get the external id
    CatalogEntryID GetCatalogEntryId() const { return catalog_entry_id; }
    /// Get the catalog version
    CatalogVersion GetCatalogVersion() const { return catalog_version; }
    /// Get the database declarations
    auto& GetDatabases() const { return database_references; }
    /// Get the database declarations by name
    auto& GetDatabasesByName() const { return databases_by_name; }
    /// Get the schema declarations
    auto& GetSchemas() const { return schema_references; }
    /// Get the schema declarations by name
    auto& GetSchemasByName() const { return schemas_by_qualified_name; }
    /// Get the table declarations
    auto& GetTables() const { return table_declarations; }
    /// Get the table declarations by name
    auto& GetTablesByName() const { return tables_by_qualified_name; }
    /// Get the table columns by name
    auto& GetTableColumnsByName() const { return table_columns_by_name; }
    /// Get the function declarations
    auto& GetFunctions() const { return function_declarations; }
    /// Get the functions by qualified name
    auto& GetFunctionsByName() const { return functions_by_qualified_name; }

    /// Describe the catalog entry
    virtual flatbuffers::Offset<buffers::catalog::CatalogEntry> DescribeEntry(
        flatbuffers::FlatBufferBuilder& builder) const = 0;
    /// Get the name search index
    virtual const NameSearchIndex& GetNameSearchIndex() = 0;

    virtual ~CatalogEntry() = default;

    /// Resolve a database reference
    void ResolveDatabaseSchemasWithCatalog(
        std::string_view database_name,
        std::vector<std::pair<std::reference_wrapper<const SchemaReference>, bool>>& out) const;
    /// Find table columns by name
    void ResolveSchemaTablesWithCatalog(
        std::string_view schema_name,
        std::vector<std::pair<std::reference_wrapper<const CatalogEntry::TableDeclaration>, bool>>& out) const;
    /// Find table columns by name
    void ResolveSchemaTablesWithCatalog(
        std::string_view database_name, std::string_view schema_name,
        std::vector<std::pair<std::reference_wrapper<const CatalogEntry::TableDeclaration>, bool>>& out) const;
    /// Resolve a table by id
    const TableDeclaration* ResolveTableById(CatalogTableID table_id) const;
    /// Resolve a table by qualified name <database, schema, table>
    void ResolveTable(QualifiedTableName table_name, std::vector<std::reference_wrapper<const TableDeclaration>>& out,
                      size_t limit) const;
    /// Resolve a table by ambiguous name with schema <schema, table>
    void ResolveTableInSchema(std::string_view schema_name, std::string_view table_name,
                              std::vector<std::reference_wrapper<const TableDeclaration>>& out, size_t limit) const;
    /// Resolve a table by ambiguous name with only the table name <table>
    void ResolveTableEverywhere(std::string_view table_name,
                                std::vector<std::reference_wrapper<const TableDeclaration>>& out, size_t limit) const;
    /// Find table columns by name
    void ResolveTableColumns(std::string_view table_column, std::vector<TableColumn>& out) const;
    /// Find table columns by name
    void ResolveTableColumnsWithCatalog(std::string_view table_column, std::vector<TableColumn>& out) const;
};

class Catalog {
    friend class CatalogEntry;

   protected:
    /// A script and its rank for atomic catalog publication.
    struct RankedScript {
        Script* script;
        CatalogEntry::Rank rank;
    };
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
        /// The id of the schema
        QualifiedCatalogObjectID catalog_schema_id;
    };

   public:
    /// A database declaration
    struct DatabaseDeclaration : public CatalogEntry::DatabaseReference {
        /// The database name
        std::string database_name_buffer;
        /// The database alias (if any)
        std::string database_alias_buffer;
        /// Constructor
        DatabaseDeclaration(QualifiedCatalogObjectID database_id, std::string_view database_name,
                            std::string_view database_alias)
            : CatalogEntry::DatabaseReference(database_id, "", ""),
              database_name_buffer(std::move(database_name)),
              database_alias_buffer(std::move(database_alias)) {
            this->database_name = database_name_buffer;
            this->database_alias = database_alias_buffer;
        }
        /// Move constructor
        DatabaseDeclaration(DatabaseDeclaration&&) = default;
        /// Move assignment
        DatabaseDeclaration& operator=(DatabaseDeclaration&&) = default;
    };
    /// A schema declaration
    struct SchemaDeclaration : public CatalogEntry::SchemaReference {
        /// The schema name
        std::string schema_name_buffer;
        /// Constructor
        SchemaDeclaration(QualifiedCatalogObjectID schema_id, std::string_view database_name,
                          std::string_view schema_name)
            : CatalogEntry::SchemaReference(schema_id, database_name, ""), schema_name_buffer(std::move(schema_name)) {
            this->schema_name = schema_name_buffer;
        }
        /// Move constructor
        SchemaDeclaration(SchemaDeclaration&&) = default;
        /// Move assignment
        SchemaDeclaration& operator=(SchemaDeclaration&&) = default;
    };

   protected:
    /// The catalog version.
    /// Every modification bumps the version counter, the analyzer reads the version counter which protects all refs.
    CatalogVersion version = 1;

    /// The catalog entries
    std::unordered_map<CatalogEntryID, CatalogEntry*> entries;
    /// The script entries
    std::unordered_map<Script*, ScriptEntry> script_entries;
    std::unordered_map<CatalogEntryID, std::shared_ptr<DescriptorEntry>> descriptor_entries;
    /// The entries ordered by <rank>
    btree::set<std::tuple<CatalogEntry::Rank, CatalogEntryID>> entries_ranked;
    /// The entries ordered by <database, schema, rank, entry>
    btree::map<std::tuple<std::string_view, std::string_view, CatalogEntry::Rank, CatalogEntryID>,
               CatalogSchemaEntryInfo>
        entries_by_qualified_schema;
    /// The entries ordered by <schema, rank, entry>.
    /// We need this index during dot completion if the user provided us only with `<schema>.<table>`.
    btree::map<std::tuple<std::string_view, CatalogEntry::Rank, CatalogEntryID>, CatalogSchemaEntryInfo>
        entries_by_schema;

    /// The databases.
    /// The btrees contain all the databases that are currently referenced by catalog entries.
    btree::map<std::string_view, std::shared_ptr<DatabaseDeclaration>> databases;
    /// The schemas.
    /// These btrees contain all the schemas that are currently referenced by catalog entries.
    /// Ordered by <database, schema>
    btree::map<std::pair<std::string_view, std::string_view>, std::shared_ptr<SchemaDeclaration>> schemas;
    /// Canonical database IDs by owned database name.
    std::unordered_map<std::string, CatalogDatabaseID, StringHasher, std::equal_to<>> database_ids_by_name;
    /// Canonical schema IDs by owned (database, schema) name.
    std::unordered_map<std::pair<std::string, std::string>, QualifiedCatalogObjectID, StringPairHasher, StringPairEqual>
        schema_ids_by_name;
    /// Monotonic ID counters. Reserved IDs are never reused during the catalog lifetime.
    CatalogDatabaseID next_database_id = INITIAL_DATABASE_ID;
    CatalogSchemaID next_schema_id = INITIAL_SCHEMA_ID;
    CatalogEntryID next_entry_id = INITIAL_ENTRY_ID;
    /// Build all mixed-membership indexes before committing any active state.
    void PublishEntries(decltype(script_entries) scripts, decltype(descriptor_entries) descriptors);

   public:
    using ScriptBatchEntry = RankedScript;
    /// Explicit constructor needed due to deleted copy constructor
    Catalog();
    ~Catalog() = default;
    /// Catalogs must not be copied
    Catalog(const Catalog& other) = delete;
    /// Catalogs must not be copy-assigned
    Catalog& operator=(const Catalog& other) = delete;

    /// Get the current version of the registry
    uint64_t GetVersion() const { return version; }
    /// Get the databases
    auto& GetDatabases() const { return databases; }
    /// Get the schemas ordered by <database, schema>
    auto& GetSchemas() const { return schemas; }

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
            auto* entry = entries.at(id);
            f(id, *entry, rank);
        }
    }
    /// Reserve the canonical ID for a database name.
    QualifiedCatalogObjectID ReserveDatabaseId(std::string_view database);
    /// Reserve the canonical ID for a qualified schema name.
    QualifiedCatalogObjectID ReserveSchemaId(std::string_view database, std::string_view schema,
                                             QualifiedCatalogObjectID db_id);
    /// Allocate an entry id
    CatalogEntryID AllocateEntryId();
    /// Analyze a script while preserving catalog entry lifetimes. Calls sharing a catalog must be serialized.
    void AnalyzeScript(Script& script, bool parse_if_outdated);

    /// Clear a catalog
    void Clear();
    /// Describe catalog entries
    flatbuffers::Offset<buffers::catalog::CatalogEntries> DescribeEntries(
        flatbuffers::FlatBufferBuilder& builder) const;
    /// Describe catalog entries
    flatbuffers::Offset<buffers::catalog::CatalogEntries> DescribeEntriesOf(flatbuffers::FlatBufferBuilder& builder,
                                                                            size_t external_id) const;
    /// Flatten the catalog
    flatbuffers::Offset<buffers::catalog::FlatCatalog> Flatten(flatbuffers::FlatBufferBuilder& builder) const;

    /// Add a script (throws Exception on error)
    void LoadScript(Script& script, CatalogEntry::Rank rank);
    /// Atomically add or replace ranked scripts (throws Exception on error).
    void LoadScripts(std::span<const ScriptBatchEntry> scripts);
    /// Replace one pool atomically. The ID must be allocated by this receiver. Input bytes are borrowed.
    void ReplaceDescriptor(CatalogEntryID id, CatalogEntry::Rank rank, std::span<const uint8_t> descriptor);
    //// Drop a descriptor
    void DropDescriptor(CatalogEntryID id);
    /// Drop a script
    void DropScript(Script& script);

    /// Resolve a table by id
    const CatalogEntry::TableDeclaration* ResolveTable(CatalogTableID table_id) const;
    /// Resolve a table by id
    void ResolveTable(CatalogEntry::QualifiedTableName table_name, CatalogEntryID ignore_entry,
                      std::vector<std::reference_wrapper<const CatalogEntry::TableDeclaration>>& out,
                      size_t limit) const;
    /// Get statisics
    std::unique_ptr<buffers::catalog::CatalogStatisticsT> GetStatistics();
};

}  // namespace dashql
