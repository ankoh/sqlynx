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
    /// Get the tokens
    auto& GetTokens() const { return symbols; }
    /// Register a name
    size_t RegisterName(std::string_view s, sx::Location location);
    /// Register a keyword as name
    size_t RegisterKeywordAsName(std::string_view s, sx::Location location);
    /// Read a text at a location
    std::string_view ReadTextAtLocation(sx::Location loc) {
        return std::string_view{text_buffer}.substr(loc.offset(), loc.length());
    }
    /// Resolve token at text offset.
    /// Returns the PREVIOUS token if there's no exact hit
    size_t FindToken(size_t text_offset);
    /// Pack syntax tokens
    std::unique_ptr<proto::ScannerTokensT> PackTokens();
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

    /// Get the nodes
    auto& GetNodes() const { return nodes; }
    /// Resolve statement and ast node at a text offset
    std::optional<std::pair<size_t, size_t>> FindNodeAtOffset(size_t text_offset);
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

struct ScriptCursor {
    /// The text offset
    size_t text_offset = 0;
    /// The current scanner token id (if any)
    std::optional<size_t> scanner_token_id;
    /// The current ast node id (if any)
    std::optional<size_t> ast_node_id;
    /// The current statement id (if any)
    std::optional<size_t> statement_id;
    /// The current table id (if any)
    std::optional<size_t> table_id;
    /// The current table reference_id (if any)
    std::optional<size_t> table_reference_id;
    /// The current column reference_id (if any)
    std::optional<size_t> column_reference_id;
    /// The current query edge id (if any)
    std::optional<size_t> query_edge_id;

    /// Move the cursor to a script at a position
    ScriptCursor(const AnalyzedScript& analyzed, size_t text_offset);
    /// Pack the cursor info
    flatbuffers::Offset<proto::ScriptCursorInfo> Pack(flatbuffers::FlatBufferBuilder& builder);
};

class Script {
   public:
    /// The underlying rope
    rope::Rope text;
    /// The text version
    uint64_t text_version = 0;
    /// The external script (if any)
    Script* external_script;

    /// The last scanned script
    std::shared_ptr<ScannedScript> scanned_script;
    /// The last parsed script
    std::shared_ptr<ParsedScript> parsed_script;
    /// The last analyzed script
    std::shared_ptr<AnalyzedScript> analyzed_script;
    /// The completion model
    CompletionIndex completion_index;

    /// The memory statistics
    proto::ScriptProcessingTimings timing_statistics;
    /// Get memory statisics
    std::unique_ptr<proto::ScriptMemoryStatistics> GetMemoryStatistics();

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
    /// Returns the pretty-printed string for this script.
    /// Return `nullopt` in case of an error.
    std::string Format();
    /// Update the completion index
    proto::StatusCode UpdateCompletionIndex();
    /// Read cursor
    std::unique_ptr<ScriptCursor> ReadCursor(size_t text_offset);

    /// Get statisics
    std::unique_ptr<proto::ScriptStatisticsT> GetStatistics();
};

}  // namespace flatsql
