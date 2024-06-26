#pragma once

#include <flatbuffers/buffer.h>
#include <flatbuffers/flatbuffer_builder.h>

#include <functional>
#include <limits>
#include <map>
#include <optional>
#include <string_view>
#include <tuple>
#include <unordered_set>

#include "ankerl/unordered_dense.h"
#include "sqlynx/external.h"
#include "sqlynx/parser/names.h"
#include "sqlynx/parser/parser.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/text/rope.h"
#include "sqlynx/utils/bits.h"
#include "sqlynx/utils/btree/map.h"
#include "sqlynx/utils/btree/set.h"
#include "sqlynx/utils/chunk_buffer.h"
#include "sqlynx/utils/hash.h"
#include "sqlynx/utils/string_conversion.h"
#include "sqlynx/utils/string_pool.h"

namespace sqlynx {

constexpr uint32_t PROTO_NULL_U32 = std::numeric_limits<uint32_t>::max();

class Catalog;
class Script;
class AnalyzedScript;

/// A schema stores database metadata.
/// It is used as a virtual container to expose table and column information to the analyzer.
class CatalogEntry {
    friend class Catalog;
    friend class Script;
    friend class ScriptCursor;

   public:
    using NameID = uint32_t;
    using Rank = uint32_t;

    /// The name info
    struct NameInfo {
        /// The unique name id within the schema
        NameID name_id;
        /// The text
        std::string_view text;
        /// The location
        sx::Location location;
        /// The tags
        NameTags tags;
        /// The number of occurrences
        size_t occurrences = 0;
        /// Return the name text
        operator std::string_view() { return text; }
        /// Return the name text
        void operator|=(proto::NameTag tag) { tags |= tag; }
    };
    using NameSearchIndex = btree::multimap<fuzzy_ci_string_view, std::reference_wrapper<const CatalogEntry::NameInfo>>;

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
    struct TableColumn {
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The column name
        std::string_view column_name;
        /// Constructor
        TableColumn(std::optional<uint32_t> ast_node_id = {}, std::string_view column_name = {})
            : ast_node_id(ast_node_id), column_name(column_name) {}
        /// Pack as FlatBuffer
        flatbuffers::Offset<proto::TableColumn> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };
    /// A table
    struct Table {
        /// The table id
        ExternalObjectID table_id;
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
        Table(ExternalObjectID table_id = {}, std::optional<uint32_t> ast_node_id = std::nullopt,
              std::optional<uint32_t> ast_statement_id = {}, std::optional<uint32_t> ast_scope_root = {},
              QualifiedTableName table_name = {}, std::vector<TableColumn> columns = {})
            : table_id(table_id),
              ast_node_id(ast_node_id),
              ast_statement_id(ast_statement_id),
              ast_scope_root(ast_scope_root),
              table_name(table_name),
              table_columns(std::move(columns)) {}
        /// Pack as FlatBuffer
        flatbuffers::Offset<proto::Table> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };
    /// A resolved table column
    struct ResolvedTableColumn {
        /// The table
        const Table& table;
        /// The index in the table
        size_t table_column_index;
    };

   protected:
    /// The external id
    const ExternalID external_id;
    /// The default database name
    const std::string_view database_name;
    /// The default schema name
    const std::string_view schema_name;
    /// The local tables
    ChunkBuffer<Table, 16> tables;
    /// The tables, indexed by name
    std::unordered_map<QualifiedTableName::Key, std::reference_wrapper<const Table>, TupleHasher> tables_by_name;
    /// The table columns, indexed by the name
    std::unordered_multimap<std::string_view, std::pair<std::reference_wrapper<const Table>, size_t>>
        table_columns_by_name;
    /// The name search index
    std::optional<CatalogEntry::NameSearchIndex> name_search_index;

   public:
    /// Construcutor
    CatalogEntry(ExternalID external_id, std::string_view database_name, std::string_view schema_name);

    /// Get the external id
    ExternalID GetExternalID() const { return external_id; }
    /// Get the database name
    auto& GetDatabaseName() const { return database_name; }
    /// Get the schema name
    auto& GetSchemaName() const { return schema_name; }
    /// Get the tables
    auto& GetTables() const { return tables; }
    /// Get the qualified name
    QualifiedTableName QualifyTableName(QualifiedTableName name) const {
        name.database_name = name.database_name.empty() ? database_name : name.database_name;
        name.schema_name = name.schema_name.empty() ? database_name : name.schema_name;
        return name;
    }
    /// Describe the catalog entry
    virtual flatbuffers::Offset<proto::CatalogEntry> DescribeEntry(flatbuffers::FlatBufferBuilder& builder) const = 0;
    /// Get the name search index
    virtual const NameSearchIndex& GetNameSearchIndex() = 0;

    /// Resolve a table by id
    const Table* ResolveTable(ExternalObjectID table_id) const;
    /// Resolve a table by id
    const Table* ResolveTable(ExternalObjectID table_id, const Catalog& catalog) const;
    /// Resolve a table by name
    const Table* ResolveTable(QualifiedTableName table_name) const;
    /// Resolve a table by name
    const Table* ResolveTable(QualifiedTableName table_name, const Catalog& catalog) const;
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
    /// The names
    ChunkBuffer<CatalogEntry::NameInfo, 32> names;
    /// The name infos
    std::unordered_map<std::string_view, std::reference_wrapper<CatalogEntry::NameInfo>> name_infos;

   public:
    /// Construcutor
    DescriptorPool(ExternalID external_id, Rank rank);
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
        /// The registered schema names
        std::unordered_set<std::pair<std::string_view, std::string_view>, TupleHasher> schema_names;
    };
    /// The catalog version.
    /// Every modification bumps the version counter, the analyzer reads the version counter which protects all refs.
    Version version = 1;
    /// The schemas
    std::unordered_map<ExternalID, CatalogEntry*> entries;
    /// The script entries
    std::unordered_map<Script*, ScriptEntry> script_entries;
    /// The descriptor pool entries
    std::unordered_map<ExternalID, std::unique_ptr<DescriptorPool>> descriptor_pool_entries;
    /// The schemas ordered by <rank>
    btree::set<std::tuple<CatalogEntry::Rank, ExternalID>> entries_ranked;
    /// The schemas ordered by <database, schema, rank>
    btree::set<std::tuple<std::string_view, std::string_view, CatalogEntry::Rank, ExternalID>> entry_names_ranked;

    /// Update a script entry
    proto::StatusCode UpdateScript(ScriptEntry& entry);

   public:
    /// Explicit constructor needed due to deleted copy constructor
    Catalog() = default;
    /// Catalogs must not be copied
    Catalog(const Catalog& other) = delete;
    /// Catalogs must not be copy-assigned
    Catalog& operator=(const Catalog& other) = delete;

    /// Get the current version of the registry
    uint64_t GetVersion() const { return version; }

    /// Contains and external id?
    bool Contains(ExternalID id) const { return entries.contains(id); }
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

    /// Clear a catalog
    void Clear();
    /// Describe catalog entries
    flatbuffers::Offset<proto::CatalogEntries> DescribeEntries(flatbuffers::FlatBufferBuilder& builder) const;
    /// Describe catalog entries
    flatbuffers::Offset<proto::CatalogEntries> DescribeEntriesOf(flatbuffers::FlatBufferBuilder& builder,
                                                                 size_t external_id) const;
    /// Add a script
    proto::StatusCode LoadScript(Script& script, CatalogEntry::Rank rank);
    /// Drop a script
    void DropScript(Script& script);
    /// Add a descriptor pool
    proto::StatusCode AddDescriptorPool(ExternalID external_id, CatalogEntry::Rank rank);
    /// Drop a descriptor pool
    proto::StatusCode DropDescriptorPool(ExternalID external_id);
    /// Add a schema descriptor as serialized FlatBuffer
    proto::StatusCode AddSchemaDescriptor(ExternalID external_id, std::span<const std::byte> descriptor_data,
                                          std::unique_ptr<const std::byte[]> descriptor_buffer);

    /// Resolve a table by id
    const CatalogEntry::Table* ResolveTable(ExternalObjectID table_id) const;
    /// Resolve a table by id
    const CatalogEntry::Table* ResolveTable(CatalogEntry::QualifiedTableName table_name, ExternalID ignore_entry) const;
    /// Find table columns by name
    void ResolveTableColumn(std::string_view table_column, std::vector<CatalogEntry::ResolvedTableColumn>& out) const;
};

}  // namespace sqlynx
