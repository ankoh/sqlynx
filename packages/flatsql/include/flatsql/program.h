#pragma once

#include <string_view>

#include "ankerl/unordered_dense.h"
#include "flatsql/parser/parser_generated.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/text/rope.h"
#include "flatsql/utils/bits.h"
#include "flatsql/utils/hash.h"
#include "flatsql/utils/string_pool.h"

namespace flatsql {
namespace parser {
class ParseContext;
}  // namespace parser

class Analyzer;

using Key = proto::AttributeKey;
using Location = proto::Location;
using NodeID = uint32_t;
using NameID = uint32_t;
using StatementID = uint32_t;
using TableID = uint32_t;
using ColumnID = uint32_t;

/// A tagged identifier
template <typename T> struct Tagged {
    static constexpr size_t BitWidth = UnsignedBitWidth<T>();
    /// The value
    T value;
    /// Constructor
    Tagged() : value(std::numeric_limits<T>::max()) {}
    /// Constructor
    Tagged(T value, bool is_external = false) : value(value | ((is_external ? 0b1 : 0) << 31)) {}
    /// Is an external id?
    inline bool IsExternal() const { return (value >> (BitWidth - 1)) != 0; }
    /// Is a null id?
    inline bool IsNull() const { return value == std::numeric_limits<T>::max(); }
    /// Is a null id?
    inline bool GetValue() const { return value & ~(0b1 << (BitWidth - 1)); }
    /// Convert to bool
    operator bool() const { return !IsNull(); }
    /// Convert to value
    operator T() const { return value; }
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
        return name.database_name() == other.name.database_name() && name.schema_name() == other.name.schema_name() &&
               name.table_name() == other.name.table_name();
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

/// A statement
class Statement {
   public:
    /// The statement type
    proto::StatementType type;
    /// The root node
    NodeID root;

   public:
    /// Constructor
    Statement();

    /// Get as flatbuffer object
    std::unique_ptr<proto::StatementT> Pack();
};

class ScannedProgram {
   public:
    /// The full input data
    rope::Rope& input_data;

    /// The scanner errors
    std::vector<std::pair<proto::Location, std::string>> errors;
    /// The line breaks
    std::vector<proto::Location> line_breaks;
    /// The comments
    std::vector<proto::Location> comments;

    /// The name pool
    StringPool<1024> name_pool;
    /// The name dictionary ids
    ankerl::unordered_dense::map<std::string_view, NameID> name_dictionary_ids;
    /// The name dictionary locations
    std::vector<std::pair<std::string_view, sx::Location>> name_dictionary;

    /// All symbols
    ChunkBuffer<parser::Parser::symbol_type> symbols;

   public:
    /// Constructor
    ScannedProgram(rope::Rope& rope);

    /// Register a name
    size_t RegisterName(std::string_view s, sx::Location location);
    /// Register a keyword as name
    size_t RegisterKeywordAsName(std::string_view s, sx::Location location);
    /// Read a text at a location
    std::string_view ReadTextAtLocation(sx::Location loc, std::string& tmp);
    /// Pack syntax highlighting
    std::unique_ptr<proto::HighlightingT> PackHighlighting();
};

class ParsedProgram {
   public:
    /// The scanned program
    ScannedProgram& scan;
    /// The nodes
    std::vector<proto::Node> nodes;
    /// The statements
    std::vector<Statement> statements;
    /// The errors
    std::vector<std::pair<proto::Location, std::string>> errors;

   public:
    /// Constructor
    ParsedProgram(parser::ParseContext&& context);

    /// Build the program
    std::shared_ptr<proto::ParsedProgramT> Pack();
};

class AnalyzedProgram {
    friend class NameResolutionPass;

   public:
    /// The scanned program
    ScannedProgram& scanned;
    /// The scanned program
    ParsedProgram& parsed;
    /// The local tables
    ChunkBuffer<proto::Table, 16> tables;
    /// The local table columns
    ChunkBuffer<proto::TableColumn, 16> table_columns;
    /// The table references
    ChunkBuffer<proto::TableReference, 16> table_references;
    /// The column references
    ChunkBuffer<proto::ColumnReference, 16> column_references;
    /// The join edges
    ChunkBuffer<proto::JoinEdge, 16> join_edges;
    /// The join edge nodes
    ChunkBuffer<proto::JoinEdgeNode, 16> join_edge_nodes;

   public:
    /// Constructor
    AnalyzedProgram(ScannedProgram& scanned, ParsedProgram& parsed);

    /// Build the program
    std::unique_ptr<proto::AnalyzedProgramT> Pack();
};

}  // namespace flatsql
