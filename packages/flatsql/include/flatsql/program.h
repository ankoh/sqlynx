#pragma once

#include <string_view>

#include "ankerl/unordered_dense.h"
#include "flatsql/parser/parser_generated.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/text/rope.h"
#include "flatsql/utils/string_pool.h"

namespace flatsql {
namespace parser {
class ParseContext;
}  // namespace parser

class Analyzer;

using Key = proto::AttributeKey;
using Location = proto::Location;
using NodeID = uint32_t;
using NameID = size_t;

inline std::ostream& operator<<(std::ostream& out, const proto::Location& loc) {
    out << "[" << loc.offset() << "," << (loc.offset() + loc.length()) << "[";
    return out;
}

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
    std::vector<sx::Location> name_dictionary_locations;

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
    std::shared_ptr<proto::ProgramT> Pack();
};

class AnalyzedProgram {
    friend class NameResolutionPass;

   public:
    /// The scanned program
    ScannedProgram& scanned;
    /// The scanned program
    ParsedProgram& parsed;
    /// The table declarations
    std::vector<std::unique_ptr<proto::TableDeclarationT>> table_declarations;
    /// The table references
    std::vector<proto::TableReference> table_references;
    /// The column_references
    std::vector<proto::ColumnReference> column_references;
    /// The column_references
    std::vector<std::unique_ptr<proto::HyperEdgeT>> join_edges;

   public:
    /// Constructor
    AnalyzedProgram(ScannedProgram& scanned, ParsedProgram& parsed);

    /// Build the program
    std::shared_ptr<proto::NameResolutionInfoT> Pack();
};

}  // namespace flatsql
