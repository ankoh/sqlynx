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

class ScannedScript {
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
    ScannedScript(rope::Rope& rope);

    /// Get the input
    auto& GetInput() const { return input_data; }
    /// Register a name
    size_t RegisterName(std::string_view s, sx::Location location);
    /// Register a keyword as name
    size_t RegisterKeywordAsName(std::string_view s, sx::Location location);
    /// Read a text at a location
    std::string_view ReadTextAtLocation(sx::Location loc, std::string& tmp);
    /// Pack syntax highlighting
    std::unique_ptr<proto::HighlightingT> PackHighlighting();
};

class ParsedScript {
   public:
    /// The scanned script
    ScannedScript& scan;
    /// The nodes
    std::vector<proto::Node> nodes;
    /// The statements
    std::vector<Statement> statements;
    /// The errors
    std::vector<std::pair<proto::Location, std::string>> errors;

   public:
    /// Constructor
    ParsedScript(parser::ParseContext&& context);

    /// Build the script
    std::shared_ptr<proto::ParsedScriptT> Pack();
};

class AnalyzedScript {
   public:
    /// The scanned script
    ScannedScript& scanned;
    /// The scanned script
    ParsedScript& parsed;
    /// The local tables
    std::vector<proto::Table> tables;
    /// The local table columns
    std::vector<proto::TableColumn> table_columns;
    /// The table references
    std::vector<proto::TableReference> table_references;
    /// The column references
    std::vector<proto::ColumnReference> column_references;
    /// The join edges
    std::vector<proto::QueryGraphEdge> graph_edges;
    /// The join edge nodes
    std::vector<proto::QueryGraphEdgeNode> graph_edge_nodes;

   public:
    /// Constructor
    AnalyzedScript(ScannedScript& scanned, ParsedScript& parsed);

    /// Build the program
    std::unique_ptr<proto::AnalyzedScriptT> Pack();
};

}  // namespace flatsql
