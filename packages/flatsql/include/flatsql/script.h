#pragma once

#include <flatbuffers/buffer.h>

#include <string_view>
#include <tuple>

#include "ankerl/unordered_dense.h"
#include "flatsql/parser/parser_generated.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/text/rope.h"
#include "flatsql/utils/bits.h"
#include "flatsql/utils/hash.h"
#include "flatsql/utils/string_pool.h"
#include "flatsql/utils/suffix_trie.h"

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

class TextBuffer {
    /// The underlying rope
    rope::Rope rope;
    /// The version counter for text modifications
    size_t version;

   public:
    /// Constructor
    TextBuffer(size_t page_size) : rope(page_size), version(0) {}
    /// Constructor
    TextBuffer(size_t page_size, std::string_view text) : rope(page_size, text), version(0) {}

    /// Get the rope
    inline auto& GetRope() { return rope; }
    /// Read from the rope
    inline std::string_view Read(size_t char_idx, size_t count, std::string& tmp) const {
        return rope.Read(char_idx, count, tmp);
    }
    /// Insert a text at an offset
    inline void InsertTextAt(size_t offset, std::string_view text) {
        ++version;
        return rope.Insert(offset, text);
    }
    /// Erase a text range
    inline void EraseTextRange(size_t offset, size_t count) {
        ++version;
        return rope.Remove(offset, count);
    }
    /// Print a script as string
    inline std::string ToString() { return rope.ToString(); }
};

class ScannedScript {
   public:
    /// The full input data
    std::shared_ptr<TextBuffer> input_data;
    /// The version of the text that was read.
    /// We're not allowed to read from the input if the version differs.
    size_t input_version;

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
    ScannedScript(std::shared_ptr<TextBuffer> text);

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
    /// Pack scanned program
    flatbuffers::Offset<proto::ScannedScript> Pack(flatbuffers::FlatBufferBuilder& builder);
};

class ParsedScript {
   public:
    /// A statement
    struct Statement {
        /// The statement type
        proto::StatementType type = proto::StatementType::NONE;
        /// The root node
        NodeID root = std::numeric_limits<uint32_t>::max();
        /// Get as flatbuffer object
        std::unique_ptr<proto::StatementT> Pack();
    };

    /// The scanned script
    std::shared_ptr<ScannedScript> scanned_script;
    /// The nodes
    std::vector<proto::Node> nodes;
    /// The statements
    std::vector<Statement> statements;
    /// The errors
    std::vector<std::pair<proto::Location, std::string>> errors;

   public:
    /// Constructor
    ParsedScript(std::shared_ptr<ScannedScript> scan, parser::ParseContext&& context);

    /// Build the script
    flatbuffers::Offset<proto::ParsedScript> Pack(flatbuffers::FlatBufferBuilder& builder);
};

class AnalyzedScript {
   public:
    /// The parsed script
    std::shared_ptr<ParsedScript> parsed_script;
    /// The external script
    std::shared_ptr<AnalyzedScript> external_script;
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
    AnalyzedScript(std::shared_ptr<ParsedScript> parsed, std::shared_ptr<AnalyzedScript> external);

    /// Build the program
    flatbuffers::Offset<proto::AnalyzedScript> Pack(flatbuffers::FlatBufferBuilder& builder);
};

struct CompletionIndex {
    /// The analyzed script
    std::shared_ptr<AnalyzedScript> analyzed_script;
    /// The suffix trie
    std::unique_ptr<SuffixTrie> suffix_trie;
};

class Script {
   public:
    /// The script text
    std::shared_ptr<TextBuffer> text;
    /// The external script (if any)
    Script* external_script;
    /// The last scanned script
    std::shared_ptr<ScannedScript> scanned_script;
    /// The last parsed script
    std::shared_ptr<ParsedScript> parsed_script;
    /// The last analyzed scripts
    std::list<std::shared_ptr<AnalyzedScript>> analyzed_scripts;
    /// The completion model
    CompletionIndex completion_index;

   public:
    /// Constructor
    Script();

    /// Insert a unicode codepoint at an offset
    void InsertCharAt(size_t offset, uint32_t unicode);
    /// Insert a text at an offset
    void InsertTextAt(size_t offset, std::string_view text);
    /// Erase a text range
    void EraseTextRange(size_t offset, size_t count);
    /// Print a script as string
    std::string ToString();

    /// Parse the latest scanned script
    std::pair<ScannedScript*, proto::StatusCode> Scan();
    /// Parse the latest scanned script
    std::pair<ParsedScript*, proto::StatusCode> Parse();
    /// Analyze the latest parsed script
    std::pair<AnalyzedScript*, proto::StatusCode> Analyze(Script* external = nullptr);
    /// Update the completion index
    proto::StatusCode UpdateCompletionIndex();
    /// Complete at a text offset
    void CompleteAt(size_t offset);
};

}  // namespace flatsql
