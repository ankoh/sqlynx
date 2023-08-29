#pragma once

#include <flatbuffers/buffer.h>

#include <optional>
#include <string_view>
#include <tuple>

#include "ankerl/unordered_dense.h"
#include "flatsql/analyzer/completion.h"
#include "flatsql/context.h"
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
struct CompletionIndex;

using Key = proto::AttributeKey;
using Location = proto::Location;
using NodeID = uint32_t;
using NameID = uint32_t;
using StatementID = uint32_t;

class ScannedScript {
   public:
    /// The context id
    const uint32_t context_id;
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
    ScannedScript(const rope::Rope& text, uint32_t context_id = 1);

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

    /// The context id
    const uint32_t context_id;
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

constexpr uint32_t PROTO_NULL_U32 = 0xFFFFFFFF;

class AnalyzedScript {
   public:
    /// A qualified table name
    struct QualifiedTableName {
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The database name, may refer to different context
        QualifiedID database_name;
        /// The schema name, may refer to different context
        QualifiedID schema_name;
        /// The table name, may refer to different context
        QualifiedID table_name;
        /// Constructor
        QualifiedTableName(std::optional<uint32_t> ast_node_id = std::nullopt, QualifiedID database_name = {},
                           QualifiedID schema_name = {}, QualifiedID table_name = {})
            : ast_node_id(ast_node_id),
              database_name(database_name),
              schema_name(schema_name),
              table_name(table_name) {}
        /// Create FlatBuffer
        operator proto::QualifiedTableName() {
            return proto::QualifiedTableName{ast_node_id.value_or(PROTO_NULL_U32), database_name.Pack(),
                                             schema_name.Pack(), table_name.Pack()};
        }
    };
    /// A qualified column name
    struct QualifiedColumnName {
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The table alias, may refer to different context
        QualifiedID table_alias;
        /// The column name, may refer to different context
        QualifiedID column_name;
        /// Constructor
        QualifiedColumnName(std::optional<uint32_t> ast_node_id = std::nullopt, QualifiedID table_alias = {},
                            QualifiedID column_name = {})
            : ast_node_id(ast_node_id), table_alias(table_alias), column_name(column_name) {}
        /// Create FlatBuffer
        operator proto::QualifiedColumnName() {
            return proto::QualifiedColumnName{ast_node_id.value_or(PROTO_NULL_U32), table_alias.Pack(),
                                              column_name.Pack()};
        }
    };
    /// A table column
    struct TableColumn {
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The column name, may refer to different context
        QualifiedID column_name;
        /// Constructor
        TableColumn(std::optional<uint32_t> ast_node_id = std::nullopt, QualifiedID column_name = {})
            : ast_node_id(ast_node_id), column_name(column_name) {}
        /// Create FlatBuffer
        operator proto::TableColumn() {
            return proto::TableColumn{ast_node_id.value_or(PROTO_NULL_U32), column_name.Pack()};
        }
    };
    /// A table
    struct Table {
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The AST statement id in the target script
        std::optional<uint32_t> ast_statement_id;
        /// The AST scope root id in the target script
        std::optional<uint32_t> ast_scope_root;
        /// The table name, may refer to different context
        QualifiedTableName table_name;
        /// The begin of the column
        uint32_t columns_begin;
        /// The column count
        uint32_t column_count;
        /// Constructor
        Table(std::optional<uint32_t> ast_node_id = std::nullopt, std::optional<uint32_t> ast_statement_id = {},
              std::optional<uint32_t> ast_scope_root = {}, QualifiedTableName table_name = {},
              uint32_t columns_begin = 0, uint32_t column_count = 0)
            : ast_node_id(ast_node_id),
              ast_statement_id(ast_statement_id),
              ast_scope_root(ast_scope_root),
              table_name(table_name),
              columns_begin(columns_begin),
              column_count(column_count) {}
        /// Create FlatBuffer
        operator proto::Table() {
            return proto::Table{ast_node_id.value_or(PROTO_NULL_U32),
                                ast_statement_id.value_or(PROTO_NULL_U32),
                                ast_scope_root.value_or(PROTO_NULL_U32),
                                table_name,
                                columns_begin,
                                column_count};
        }
    };
    /// A table reference
    struct TableReference {
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The AST statement id in the target script
        std::optional<uint32_t> ast_statement_id;
        /// The AST scope root in the target script
        std::optional<uint32_t> ast_scope_root;
        /// The table name, may refer to different context
        QualifiedTableName table_name;
        /// The alias name, may refer to different context
        QualifiedID alias_name;
        /// The table id, may refer to different context
        QualifiedID table_id;
        /// Constructor
        TableReference(std::optional<uint32_t> ast_node_id = std::nullopt,
                       std::optional<uint32_t> ast_statement_id = {}, std::optional<uint32_t> ast_scope_root = {},
                       QualifiedTableName table_name = {}, QualifiedID alias_name = {}, QualifiedID table_id = {})
            : ast_node_id(ast_node_id),
              ast_statement_id(ast_statement_id),
              ast_scope_root(ast_scope_root),
              table_name(table_name),
              alias_name(alias_name),
              table_id(table_id) {}
        /// Create FlatBuffer
        operator proto::TableReference() {
            return proto::TableReference{ast_node_id.value_or(PROTO_NULL_U32),
                                         ast_statement_id.value_or(PROTO_NULL_U32),
                                         ast_scope_root.value_or(PROTO_NULL_U32),
                                         table_name,
                                         alias_name.Pack(),
                                         table_id.Pack()};
        }
    };
    /// A column reference
    struct ColumnReference {
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The AST statement id in the target script
        std::optional<uint32_t> ast_statement_id;
        /// The AST scope root in the target script
        std::optional<uint32_t> ast_scope_root;
        /// The column name, may refer to different context
        QualifiedColumnName column_name;
        /// The table id, may refer to different context
        QualifiedID table_id;
        /// The column index
        std::optional<uint32_t> column_id;
        /// Constructor
        ColumnReference(std::optional<uint32_t> ast_node_id = std::nullopt,
                        std::optional<uint32_t> ast_statement_id = {}, std::optional<uint32_t> ast_scope_root = {},
                        QualifiedColumnName column_name = {}, QualifiedID table_id = {},
                        std::optional<uint32_t> column_id = std::nullopt)
            : ast_node_id(ast_node_id),
              ast_statement_id(ast_statement_id),
              ast_scope_root(ast_scope_root),
              column_name(column_name),
              table_id(table_id),
              column_id(column_id) {}
        /// Create FlatBuffer
        operator proto::ColumnReference() {
            return proto::ColumnReference{ast_node_id.value_or(PROTO_NULL_U32),
                                          ast_statement_id.value_or(PROTO_NULL_U32),
                                          ast_scope_root.value_or(PROTO_NULL_U32),
                                          column_name,
                                          table_id.Pack(),
                                          column_id.value_or(PROTO_NULL_U32)};
        }
    };
    /// A query graph edge
    struct QueryGraphEdge {
        /// The AST node id in the target script
        std::optional<uint32_t> ast_node_id;
        /// The begin of the nodes
        uint32_t nodes_begin;
        /// The number of nodes on the left
        uint16_t node_count_left;
        /// The number of nodes on the right
        uint16_t node_count_right;
        /// The expression operator
        proto::ExpressionOperator expression_operator;
        /// Constructor
        QueryGraphEdge(std::optional<uint32_t> ast_node_id = std::nullopt, uint32_t nodes_begin = 0,
                       uint16_t node_count_left = 0, uint16_t node_count_right = 0,
                       proto::ExpressionOperator op = proto::ExpressionOperator::DEFAULT)
            : ast_node_id(ast_node_id),
              nodes_begin(nodes_begin),
              node_count_left(node_count_left),
              node_count_right(node_count_right),
              expression_operator(op) {}
        /// Create FlatBuffer
        operator proto::QueryGraphEdge() {
            return proto::QueryGraphEdge{ast_node_id.value_or(PROTO_NULL_U32), nodes_begin, node_count_left,
                                         node_count_right, expression_operator};
        }
    };
    /// A query graph edge node
    struct QueryGraphEdgeNode {
        /// The column reference id
        uint32_t column_reference_id;
        /// Constructor
        QueryGraphEdgeNode(uint32_t column_ref_id = 0) : column_reference_id(column_ref_id) {}
        /// Create FlatBuffer
        operator proto::QueryGraphEdgeNode() { return proto::QueryGraphEdgeNode{column_reference_id}; }
    };

    /// The context id
    const uint32_t context_id;
    /// The parsed script
    std::shared_ptr<ParsedScript> parsed_script;
    /// The external script
    std::shared_ptr<AnalyzedScript> external_script;
    /// The local tables
    std::vector<Table> tables;
    /// The local table columns
    std::vector<TableColumn> table_columns;
    /// The table references
    std::vector<TableReference> table_references;
    /// The column references
    std::vector<ColumnReference> column_references;
    /// The join edges
    std::vector<QueryGraphEdge> graph_edges;
    /// The join edge nodes
    std::vector<QueryGraphEdgeNode> graph_edge_nodes;

   public:
    /// Constructor
    AnalyzedScript(std::shared_ptr<ParsedScript> parsed, std::shared_ptr<AnalyzedScript> external);

    /// Build the program
    flatbuffers::Offset<proto::AnalyzedScript> Pack(flatbuffers::FlatBufferBuilder& builder);
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
    /// The context id
    const uint32_t context_id;
    /// The underlying rope
    rope::Rope text;
    /// The external script (if any)
    Script* external_script;

    /// The last scanned script
    std::shared_ptr<ScannedScript> scanned_script;
    /// The last parsed script
    std::shared_ptr<ParsedScript> parsed_script;
    /// The last analyzed script
    std::shared_ptr<AnalyzedScript> analyzed_script;

    /// The completion index
    std::optional<CompletionIndex> completion_index;
    /// The last cursor
    std::optional<ScriptCursor> cursor;

    /// The memory statistics
    proto::ScriptProcessingTimings timing_statistics;
    /// Get memory statisics
    std::unique_ptr<proto::ScriptMemoryStatistics> GetMemoryStatistics();

   public:
    /// Constructor
    Script(uint32_t context_id = 1);

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
    /// Move the cursor
    const ScriptCursor& MoveCursor(size_t text_offset);
    /// Get statisics
    std::unique_ptr<proto::ScriptStatisticsT> GetStatistics();

    /// Returns the pretty-printed string for this script
    std::string Format();
};

}  // namespace flatsql
