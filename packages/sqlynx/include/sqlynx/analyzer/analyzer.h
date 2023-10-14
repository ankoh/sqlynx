#pragma once

#include "sqlynx/analyzer/pass_manager.h"
#include "sqlynx/context.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/utils/attribute_index.h"

namespace sqlynx {

struct NameResolutionPass;

struct Analyzer {
    friend class AnalyzedScript;

   public:
    /// A table key
    struct TableKey {
        /// The name
        AnalyzedScript::QualifiedTableName name;
        /// Constructor
        TableKey(AnalyzedScript::QualifiedTableName name) : name(name) {}
        /// The derefence operator
        const AnalyzedScript::QualifiedTableName& operator*() { return name; }
        /// Equality operator
        bool operator==(const TableKey& other) const {
            return name.database_name == other.name.database_name && name.schema_name == other.name.schema_name &&
                   name.table_name == other.name.table_name;
        }
        /// A hasher
        struct Hasher {
            size_t operator()(const TableKey& key) const {
                size_t hash = 0;
                QualifiedID::Hasher hasher;
                hash_combine(hash, hasher(key.name.database_name));
                hash_combine(hash, hasher(key.name.schema_name));
                hash_combine(hash, hasher(key.name.table_name));
                return hash;
            }
        };
    };
    /// A column key
    struct ColumnKey {
        /// The name
        AnalyzedScript::QualifiedColumnName name;
        /// Constructor
        ColumnKey(AnalyzedScript::QualifiedColumnName name) : name(name) {}
        /// The derefence operator
        const AnalyzedScript::QualifiedColumnName& operator*() { return name; }
        /// Equality operator
        bool operator==(const ColumnKey& other) const {
            return name.table_alias == other.name.table_alias && name.column_name == other.name.column_name;
        }
        /// A hasher
        struct Hasher {
            size_t operator()(const ColumnKey& key) const {
                size_t hash = 0;
                QualifiedID::Hasher hasher;
                hash_combine(hash, hasher(key.name.table_alias));
                hash_combine(hash, hasher(key.name.column_name));
                return hash;
            }
        };
    };

   protected:
    /// The parsed program
    std::shared_ptr<ParsedScript> parsed_program;
    /// The external script
    std::shared_ptr<AnalyzedScript> external_script;
    /// The attribute index
    AttributeIndex attribute_index;
    /// The pass manager
    PassManager pass_manager;
    /// The name resolution pass
    std::unique_ptr<NameResolutionPass> name_resolution;

   public:
    /// Constructor
    Analyzer(std::shared_ptr<ParsedScript> parsed, std::shared_ptr<AnalyzedScript> external);

    /// Analyze a program
    static std::pair<std::shared_ptr<AnalyzedScript>, proto::StatusCode> Analyze(
        std::shared_ptr<ParsedScript> parsed, std::shared_ptr<AnalyzedScript> external);
};

}  // namespace sqlynx
