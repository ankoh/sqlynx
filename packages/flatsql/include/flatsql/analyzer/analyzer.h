#pragma once

#include "flatsql/analyzer/pass_manager.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/utils/attribute_index.h"

namespace flatsql {

struct NameResolutionPass;

enum RawTag { Raw };

struct Analyzer {
    friend class AnalyzedScript;

   public:
    /// An identifier
    struct ID {
       protected:
        /// The context id
        uint32_t context_id;
        /// The value
        uint32_t value;

       public:
        /// Constructor
        explicit ID() : context_id(std::numeric_limits<uint32_t>::max()), value(std::numeric_limits<uint32_t>::max()) {}
        /// Constructor
        explicit ID(uint64_t raw, RawTag) : context_id(raw >> 32), value(raw & std::numeric_limits<uint32_t>::max()) {
            assert(allowZeroContext() || context_id != 0);
        }
        /// Constructor
        explicit ID(uint32_t context_id, uint32_t value) : context_id(context_id), value(value) {
            assert(context_id != 0);
        }
        /// Get the context identifier
        inline uint32_t GetContext() const { return context_id; }
        /// Get the index
        inline uint32_t GetIndex() const { return value; }
        /// Is a null id?
        inline bool IsNull() const { return GetIndex() == std::numeric_limits<uint32_t>::max(); }
        /// Convert to 64 bit integer
        operator uint64_t() const { return (static_cast<uint64_t>(context_id) << 32) | value; }
        /// Convert to bool
        operator bool() const { return !IsNull(); }
    };
    /// A table key
    struct TableKey {
        /// The name
        proto::QualifiedTableName name;
        /// Constructor
        TableKey(proto::QualifiedTableName name) : name(name) {}
        /// The derefence operator
        const proto::QualifiedTableName& operator*() { return name; }
        /// Equality operator
        bool operator==(const TableKey& other) const {
            return name.database_name() == other.name.database_name() &&
                   name.schema_name() == other.name.schema_name() && name.table_name() == other.name.table_name();
        }
        /// A hasher
        struct Hasher {
            size_t operator()(const TableKey& key) const {
                size_t hash = 0;
                hash_combine(hash, key.name.database_name());
                hash_combine(hash, key.name.schema_name());
                hash_combine(hash, key.name.table_name());
                return hash;
            }
        };
    };
    /// A column key
    struct ColumnKey {
        /// The name
        proto::QualifiedColumnName name;
        /// Constructor
        ColumnKey(proto::QualifiedColumnName name) : name(name) {}
        /// The derefence operator
        const proto::QualifiedColumnName& operator*() { return name; }
        /// Equality operator
        bool operator==(const ColumnKey& other) const {
            return name.table_alias() == other.name.table_alias() && name.column_name() == other.name.column_name();
        }
        /// A hasher
        struct Hasher {
            size_t operator()(const ColumnKey& key) const {
                size_t hash = 0;
                hash_combine(hash, key.name.table_alias());
                hash_combine(hash, key.name.column_name());
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

}  // namespace flatsql
