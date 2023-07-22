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

class ScannedScript {
   public:
    /// The text version
    uint64_t text_version = 0;
    /// The copied text buffer
    std::string text_buffer;

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
    ScannedScript(const rope::Rope& text);

    /// Get the input
    auto& GetInput() const { return text_buffer; }
    /// Register a name
    size_t RegisterName(std::string_view s, sx::Location location);
    /// Register a keyword as name
    size_t RegisterKeywordAsName(std::string_view s, sx::Location location);
    /// Read a text at a location
    std::string_view ReadTextAtLocation(sx::Location loc) {
        return std::string_view{text_buffer}.substr(loc.offset(), loc.length());
    }
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

    /// The text version
    uint64_t text_version = 0;
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
    /// The text version
    uint64_t text_version = 0;
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

/// We remember three different analyzed script versions.
/// A script is first stored in `latest`.
/// The `quality` (as in number of errors) of every new script is compared to `cooling`.
/// A script in `cooling` is moved to `stable` if it has fewer errors or if the `stable` script gets too old.
struct StaggeredAnalyzedScripts {
    // The latest script
    std::shared_ptr<AnalyzedScript> latest;
    // The cooling script
    std::shared_ptr<AnalyzedScript> cooling;
    // The stable script
    std::shared_ptr<AnalyzedScript> stable;
};

class Script {
   public:
    /// The underlying rope
    rope::Rope text;
    /// The text version
    uint64_t text_version;
    /// The external script (if any)
    Script* external_script;

    /// The last scanned script
    std::shared_ptr<ScannedScript> scanned_script;
    /// The last parsed script
    std::shared_ptr<ParsedScript> parsed_script;
    /// The staggered analyzed script versions
    StaggeredAnalyzedScripts analyzed_scripts;
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
    std::pair<AnalyzedScript*, proto::StatusCode> Analyze(Script* external = nullptr, bool use_stable_external = false,
                                                          uint32_t lifetime = 0);
    /// Returns the pretty-printed string for this script.
    /// Return `nullopt` in case of an error.
    std::string Format();
    /// Update the completion index
    proto::StatusCode UpdateCompletionIndex(bool use_stable = true);
    /// Complete at a text offset
    void CompleteAt(size_t offset);
};

}  // namespace flatsql
