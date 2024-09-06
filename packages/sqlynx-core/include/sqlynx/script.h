#pragma once

#include <flatbuffers/buffer.h>
#include <flatbuffers/flatbuffer_builder.h>

#include <functional>
#include <optional>
#include <string_view>
#include <variant>

#include "sqlynx/catalog.h"
#include "sqlynx/external.h"
#include "sqlynx/parser/parser.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/text/rope.h"
#include "sqlynx/utils/intrusive_list.h"
#include "sqlynx/utils/string_pool.h"

namespace sqlynx {
namespace parser {
class ParseContext;
}  // namespace parser

class Analyzer;
class NameSuffixIndex;
class Completion;

using Key = proto::AttributeKey;
using Location = proto::Location;
using NameID = uint32_t;
using NodeID = uint32_t;
using StatementID = uint32_t;

class ScannedScript {
    friend class Script;

   public:
    /// The origin id
    const CatalogEntryID external_id;
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
    /// The name registry
    NameRegistry name_registry;
    /// All symbols
    ChunkBuffer<parser::Parser::symbol_type> symbols;

   public:
    /// Constructor
    ScannedScript(const rope::Rope& text, CatalogEntryID external_id = 1);
    /// Constructor
    ScannedScript(std::string text, CatalogEntryID external_id = 1);

    /// Get the input
    auto& GetInput() const { return text_buffer; }
    /// Get the tokens
    auto& GetSymbols() const { return symbols; }
    /// Get the name dictionary
    auto& GetNames() { return name_registry; }

    /// Register a keyword as name
    NameID RegisterKeywordAsName(std::string_view s, sx::Location location, sx::NameTag tag = sx::NameTag::NONE) {
        return name_registry.Register(s, location, tag).name_id;
    }
    /// Read a text at a location
    std::string_view ReadTextAtLocation(sx::Location loc) {
        return std::string_view{text_buffer}.substr(loc.offset(), loc.length());
    }

    /// A location info
    struct LocationInfo {
        using RelativePosition = sqlynx::proto::RelativeSymbolPosition;
        /// The text offset
        size_t text_offset;
        /// The last scanner symbol that does not have a begin greater than the text offset
        size_t symbol_id;
        /// The symbol
        parser::Parser::symbol_type& symbol;
        /// The previous symbol (if any)
        std::optional<std::reference_wrapper<parser::Parser::symbol_type>> previous_symbol;
        /// If we would insert at this position, what mode would it be?
        RelativePosition relative_pos;
        /// At EOF?
        bool at_eof;

        /// Constructor
        LocationInfo(size_t text_offset, size_t token_id, parser::Parser::symbol_type& symbol,
                     std::optional<std::reference_wrapper<parser::Parser::symbol_type>> previous_symbol,
                     RelativePosition mode, bool at_eof)
            : text_offset(text_offset),
              symbol_id(token_id),
              symbol(symbol),
              previous_symbol(previous_symbol),
              relative_pos(mode),
              at_eof(at_eof) {}

        /// Is the current symbol a dot?
        bool currentSymbolIsDot() const { return symbol.kind_ == parser::Parser::symbol_kind_type::S_DOT; }
        /// Is the current symbol a dot + space?
        bool currentSymbolIsTrailingDot() const {
            return symbol.kind_ == parser::Parser::symbol_kind_type::S_DOT_TRAILING;
        }
        /// Is the previous symbol a dot?
        bool previousSymbolIsDot() const {
            if (!previous_symbol.has_value()) {
                return false;
            } else {
                return previous_symbol.value().get().kind_ == parser::Parser::symbol_kind_type::S_DOT;
            }
        }
    };
    /// Find token at text offset
    LocationInfo FindSymbol(size_t text_offset);
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
        /// The begin of the nodes
        size_t nodes_begin = 0;
        /// The node count
        size_t node_count = 0;
        /// Get as flatbuffer object
        std::unique_ptr<proto::StatementT> Pack();
    };

    /// The origin id
    const CatalogEntryID external_id;
    /// The scanned script
    std::shared_ptr<ScannedScript> scanned_script;
    /// The nodes
    std::vector<proto::Node> nodes;
    /// The statements
    std::vector<Statement> statements;
    /// The parser errors
    std::vector<std::pair<proto::Location, std::string>> errors;

   public:
    /// Constructor
    ParsedScript(std::shared_ptr<ScannedScript> scan, parser::ParseContext&& context);

    /// Get the nodes
    auto& GetNodes() const { return nodes; }
    /// Resolve statement and ast node at a text offset
    std::optional<std::pair<size_t, size_t>> FindNodeAtOffset(size_t text_offset) const;
    /// Build the script
    flatbuffers::Offset<proto::ParsedScript> Pack(flatbuffers::FlatBufferBuilder& builder);
};

class AnalyzedScript : public CatalogEntry {
    friend class Script;
    friend class NameResolutionPass;

   public:
    /// A table reference
    struct TableReference : public IntrusiveListNode {
        /// An unresolved column reference
        struct UnresolvedRelationExpression {
            /// The AST node id of the name path
            uint32_t table_name_ast_node_id;
            /// The table name, may refer to different catalog entry
            QualifiedTableName table_name;
        };
        /// A resolved column reference
        struct ResolvedRelationExpression {
            /// The AST node id of the name path
            uint32_t table_name_ast_node_id;
            /// The table name, may refer to different catalog entry
            QualifiedTableName table_name;
            /// The resolved database id in the catalog
            CatalogDatabaseID catalog_database_id = 0;
            /// The resolved schema id in the catalog
            CatalogSchemaID catalog_schema_id = 0;
            /// The resolved table id in the catalog
            ExternalObjectID catalog_table_id;
        };

        /// The table reference id
        ExternalObjectID table_reference_id;
        /// The AST node id in the target script
        uint32_t ast_node_id;
        /// The AST statement id in the target script
        std::optional<uint32_t> ast_statement_id;
        /// The AST scope root in the target script
        std::optional<uint32_t> ast_scope_root;
        /// The alias name, may refer to different catalog entry
        std::optional<std::reference_wrapper<RegisteredName>> alias_name;
        /// The inner relation type
        std::variant<std::monostate, UnresolvedRelationExpression, ResolvedRelationExpression> inner;

        /// Constructor
        TableReference(std::optional<std::reference_wrapper<RegisteredName>> alias_name) : alias_name(alias_name) {}
        /// Pack as FlatBuffer
        flatbuffers::Offset<proto::TableReference> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };
    /// An expression
    struct Expression : public IntrusiveListNode {
        /// An unresolved column reference
        struct UnresolvedColumnRef {
            /// The AST node id of the name path
            uint32_t column_name_ast_node_id;
            /// The column name, may refer to different catalog entry
            QualifiedColumnName column_name;
        };
        /// A resolved column reference
        struct ResolvedColumnRef {
            /// The AST node id of the name path
            uint32_t column_name_ast_node_id;
            /// The column name, may refer to different catalog entry
            QualifiedColumnName column_name;
            /// The resolved catalog database id
            CatalogDatabaseID catalog_database_id = 0;
            /// The resolved catalog schema id
            CatalogSchemaID catalog_schema_id = 0;
            /// The resolved table id in the catalog
            ExternalObjectID catalog_table_id;
            /// The resolved table column id
            uint32_t table_column_id;
        };

        /// The expression id as (entry_id, reference_index)
        ExternalObjectID expression_id;
        /// The AST node id in the target script
        uint32_t ast_node_id;
        /// The AST statement id in the target script
        std::optional<uint32_t> ast_statement_id;
        /// The AST scope root in the target script
        std::optional<uint32_t> ast_scope_root;
        /// The inner expression type
        std::variant<std::monostate, UnresolvedColumnRef, ResolvedColumnRef> inner;

        /// Constructor
        Expression() : inner(std::monostate{}) {}
        // Check if the expression is a column ref
        inline bool IsColumnRef() {
            return std::holds_alternative<UnresolvedColumnRef>(inner) ||
                   std::holds_alternative<ResolvedColumnRef>(inner);
        }
        /// Pack as FlatBuffer
        flatbuffers::Offset<proto::Expression> Pack(flatbuffers::FlatBufferBuilder& builder) const;
    };
    /// A result target
    struct ResultTarget {
        /// A star result target
        struct Star {};
        /// An unnamed result target
        struct Unnamed {
            /// The expression
            uint32_t expression_id;
        };
        /// A named result target
        struct Named {
            /// The expression
            uint32_t expression_id;
        };
        /// An inner
        std::variant<Star, Unnamed, Named> inner;
    };
    /// A naming scope
    struct NameScope : public IntrusiveListNode {
        /// The id of the scope (== scope index in the script)
        size_t name_scope_id;
        /// The scope root
        size_t ast_scope_root;
        /// The parent scope
        NameScope* parent_scope;
        /// The child scopes
        IntrusiveList<IntrusiveListNode> child_scopes;
        /// The column references in this scope
        IntrusiveList<Expression> expressions;
        /// The table references in this scope
        IntrusiveList<TableReference> table_references;

        /// The result targets in this scope
        std::vector<ResultTarget> result_targets;
        /// The named tables in scope
        std::unordered_map<std::string_view, std::reference_wrapper<const CatalogEntry::TableDeclaration>>
            referenced_tables_by_name;
    };

    /// The default database name
    const RegisteredName default_database_name;
    /// The default schema name
    const RegisteredName default_schema_name;

    /// The parsed script
    std::shared_ptr<ParsedScript> parsed_script;
    /// The catalog version
    Catalog::Version catalog_version;
    /// The analyzer errors
    std::vector<proto::AnalyzerErrorT> errors;
    /// The table references
    ChunkBuffer<TableReference, 16> table_references;
    /// The expressions
    ChunkBuffer<Expression, 16> expressions;
    /// The name scopes
    ChunkBuffer<NameScope, 16> name_scopes;
    /// The name scopes by scope root
    std::unordered_map<size_t, std::reference_wrapper<NameScope>> name_scopes_by_root_node;

    /// Traverse the name scopes for a given ast node id
    void FollowPathUpwards(uint32_t ast_node_id, std::vector<uint32_t>& ast_node_path,
                           std::vector<std::reference_wrapper<AnalyzedScript::NameScope>>& scopes) const;

   public:
    /// Constructor
    AnalyzedScript(std::shared_ptr<ParsedScript> parsed, Catalog& catalog);

    /// Describe the catalog entry
    virtual flatbuffers::Offset<proto::CatalogEntry> DescribeEntry(
        flatbuffers::FlatBufferBuilder& builder) const override;
    /// Get the name search index
    const CatalogEntry::NameSearchIndex& GetNameSearchIndex() override;
    /// Build the program
    flatbuffers::Offset<proto::AnalyzedScript> Pack(flatbuffers::FlatBufferBuilder& builder);
};

class Script;

struct ScriptCursor {
    /// Cursor is pointing at a table reference
    struct TableRefContext {
        /// The table ref that the cursor is pointing into
        uint32_t table_reference_id;
    };
    /// Cursor is pointing at a column reference
    struct ColumnRefContext {
        /// The table ref that the cursor is pointing into
        uint32_t expression_id;
    };

    /// The script
    const Script& script;
    /// The text offset
    size_t text_offset = 0;
    /// The text offset
    std::string_view text;
    /// The current scanner location (if any)
    std::optional<ScannedScript::LocationInfo> scanner_location;
    /// The current statement id (if any)
    std::optional<uint32_t> statement_id;
    /// The current ast node id (if any)
    std::optional<uint32_t> ast_node_id;
    /// The ast node path to the root
    std::vector<uint32_t> ast_path_to_root;
    /// The name scopes of that the cursor is in (if any).
    /// Left-to-right == innermost-to-outermost
    std::vector<std::reference_wrapper<AnalyzedScript::NameScope>> name_scopes;
    /// The inner cursor type based on what we're pointing at
    std::variant<std::monostate, TableRefContext, ColumnRefContext> context;

    /// Move the cursor to a script at a position
    ScriptCursor(const Script& script, size_t text_offset);
    /// Pack the cursor info
    flatbuffers::Offset<proto::ScriptCursor> Pack(flatbuffers::FlatBufferBuilder& builder) const;

    /// Create a script cursor
    static std::pair<std::unique_ptr<ScriptCursor>, proto::StatusCode> Place(const Script& script, size_t text_offset);
};

class Script {
   public:
    /// The catalog
    Catalog& catalog;
    /// The catalog entry id
    const CatalogEntryID catalog_entry_id;

    /// The underlying rope
    rope::Rope text;

    /// The last scanned script
    std::shared_ptr<ScannedScript> scanned_script;
    /// The last parsed script
    std::shared_ptr<ParsedScript> parsed_script;
    /// The last analyzed script
    std::shared_ptr<AnalyzedScript> analyzed_script;

    /// The last cursor
    std::unique_ptr<ScriptCursor> cursor;

    /// The memory statistics
    proto::ScriptProcessingTimings timing_statistics;
    /// Get memory statisics
    std::unique_ptr<proto::ScriptMemoryStatistics> GetMemoryStatistics();

   public:
    /// Constructor
    Script(Catalog& catalog, CatalogEntryID external_id = 1);
    /// Destructor
    ~Script();
    /// Scripts must not be copied
    Script(const Script& other) = delete;
    /// Scripts must not be copy-assigned
    Script& operator=(const Script& other) = delete;

    /// Get the catalog entry id
    auto GetCatalogEntryId() const { return catalog_entry_id; }
    /// Get the catalog
    auto& GetCatalog() const { return catalog; }

    /// Insert a unicode codepoint at an offset
    void InsertCharAt(size_t offset, uint32_t unicode);
    /// Insert a text at an offset
    void InsertTextAt(size_t offset, std::string_view text);
    /// Erase a text range
    void EraseTextRange(size_t offset, size_t count);
    /// Replace the entire text
    void ReplaceText(std::string_view text);
    /// Print a script as string
    std::string ToString();
    /// Returns the pretty-printed string for this script
    std::string Format();

    /// Parse the latest scanned script
    std::pair<ScannedScript*, proto::StatusCode> Scan();
    /// Parse the latest scanned script
    std::pair<ParsedScript*, proto::StatusCode> Parse();
    /// Analyze the latest parsed script
    std::pair<AnalyzedScript*, proto::StatusCode> Analyze();

    /// Move the cursor
    std::pair<const ScriptCursor*, proto::StatusCode> MoveCursor(size_t text_offset);
    /// Complete at the cursor
    std::pair<std::unique_ptr<Completion>, proto::StatusCode> CompleteAtCursor(size_t limit = 10) const;
    /// Get statisics
    std::unique_ptr<proto::ScriptStatisticsT> GetStatistics();
};

}  // namespace sqlynx
