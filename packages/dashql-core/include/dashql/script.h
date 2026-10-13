#pragma once

#include <flatbuffers/buffer.h>
#include <flatbuffers/flatbuffer_builder.h>

#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <type_traits>
#include <variant>

#include "dashql/analyzer/analyzer_types.h"
#include "dashql/buffers/index_generated.h"
#include "dashql/catalog.h"
#include "dashql/catalog_object.h"
#include "dashql/external.h"
#include "dashql/parser/parser.h"
#include "dashql/text/rope.h"
#include "dashql/utils/intrusive_list.h"
#include "dashql/utils/string_pool.h"

namespace dashql {

struct ScriptCompilationResult;
struct ScriptCompilationOptions {
    bool allow_extensions = true;
    bool parse_if_outdated = true;
};
namespace parser {
class ParseContext;
}  // namespace parser

class NameSuffixIndex;
struct Analyzer;
struct Completion;

using Key = buffers::parser::AttributeKey;
using SymbolSpan = buffers::parser::SymbolSpan;
using TextSpan = buffers::parser::TextSpan;
using NameID = uint32_t;
using NodeID = uint32_t;
using ColumnID = uint32_t;
using StatementID = uint32_t;
using TextVersion = uint64_t;
using CompletionPtr = flatbuffers::Offset<buffers::completion::Completion>;

class ScannedScript {
    friend class Script;

   public:
    /// The origin id
    const CatalogEntryID external_id;
    /// The copied text buffer
    std::string text_buffer;
    /// The text version
    TextVersion text_version;

    /// The scanner errors
    std::vector<std::pair<buffers::parser::TextSpan, std::string>> errors;
    /// The line breaks
    std::vector<buffers::parser::TextSpan> line_breaks;
    /// The comments
    std::vector<buffers::parser::TextSpan> comments;

    /// The name pool
    StringPool<1024> name_pool;
    /// The name registry
    NameRegistry name_registry;
    /// All symbols
    ChunkBuffer<parser::Parser::symbol_type> symbols;

   public:
    /// Constructor
    ScannedScript(const rope::Rope& text, TextVersion text_version = 0, CatalogEntryID external_id = 1);
    /// Constructor
    ScannedScript(std::string text, TextVersion text_version = 0, CatalogEntryID external_id = 1);

    /// Get the input
    std::string_view GetInput() const {
        return std::string_view{text_buffer}.substr(0, std::max<size_t>(text_buffer.size(), 2) - 2);
    }
    /// Get the tokens
    auto& GetSymbols() const { return symbols; }
    /// Get the name dictionary
    auto& GetNames() { return name_registry; }

    /// Register a keyword as name
    NameID RegisterKeywordAsName(std::string_view s, sx::parser::SymbolSpan location) {
        return name_registry.Register(s, sx::parser::TextSpan(location.offset(), location.length())).name_id;
    }
    /// Resolve a token-index SymbolSpan to a text-positional TextSpan
    sx::parser::TextSpan ResolveTextSpan(sx::parser::SymbolSpan span) const;
    /// Read the text at a symbol span (resolves through tokens)
    std::string_view ReadTextAtSymbolSpan(sx::parser::SymbolSpan span) const {
        auto ts = ResolveTextSpan(span);
        return std::string_view{text_buffer}.substr(ts.offset(), ts.length());
    }
    /// Read the text at a text span
    std::string_view ReadTextAtTextSpan(sx::parser::TextSpan span) const {
        return std::string_view{text_buffer}.substr(span.offset(), span.length());
    }

    /// A symbol location info
    struct SymbolLocationInfo {
        using RelativePosition = dashql::buffers::cursor::RelativeSymbolPosition;
        /// The chunk symbol id
        ChunkBufferEntryID symbol_id;
        /// The symbols
        parser::Parser::symbol_type& symbol;
        /// The text offset
        size_t text_offset;
        /// The relative position for the text offset
        RelativePosition relative_pos;

        /// Constructor
        explicit SymbolLocationInfo(ChunkBufferEntryID symbol_id, parser::Parser::symbol_type& symbol,
                                    size_t text_offset, RelativePosition rel)
            : symbol_id(symbol_id), symbol(symbol), text_offset(text_offset), relative_pos(rel) {}

        /// Is the symbol a dot?
        bool symbolIsDot() const {
            return symbol.kind_ == parser::Parser::symbol_kind_type::S_DOT ||
                   symbol.kind_ == parser::Parser::symbol_kind_type::S_DOT_STAR_LA;
        }
        /// Is the symbol a dot + space?
        bool symbolIsTrailingDot() const { return symbol.kind_ == parser::Parser::symbol_kind_type::S_DOT_TRAILING; }
    };

    /// A location info
    struct LocationInfo {
        using RelativePosition = dashql::buffers::cursor::RelativeSymbolPosition;
        /// The last scanner symbol that does not have a begin greater than the text offset.
        SymbolLocationInfo current;
        /// The previous symbol (if any)
        /// The previous symbol might *end* at text_offset, which makes it relevant for completion.
        std::optional<SymbolLocationInfo> previous;

        /// Constructor
        LocationInfo(SymbolLocationInfo current_symbol, std::optional<SymbolLocationInfo> previous_symbol)
            : current(std::move(current_symbol)), previous(std::move(previous_symbol)) {}

        /// Has a previous symbol?
        bool hasPreviousSymbol() const { return previous.has_value(); }
    };
    /// Find token at text offset
    LocationInfo FindSymbol(size_t text_offset);
    /// Is a text offset inside a comment?
    /// Comments are not part of the symbol stream (they live in `comments`), so a cursor within a
    /// comment would otherwise snap to an adjacent token. Returns true when the offset sits strictly
    /// inside a comment span; the leading position is excluded so completion still fires right before
    /// a comment, and the trailing `*/` of a block comment is excluded so it fires right after one.
    bool IsInsideComment(size_t text_offset) const;
    /// Pack scanned program
    flatbuffers::Offset<buffers::parser::ScannedScript> Pack(flatbuffers::FlatBufferBuilder& builder);
};

class ParsedScript {
   public:
    /// A statement
    struct Statement {
        /// The statement type
        buffers::parser::StatementType type = buffers::parser::StatementType::NONE;
        /// The root node
        NodeID root = std::numeric_limits<uint32_t>::max();
        /// The begin of the nodes
        size_t nodes_begin = 0;
        /// The node count
        size_t node_count = 0;
        /// Get as flatbuffer object
        std::unique_ptr<buffers::parser::StatementT> Pack() const;
    };

    /// Source-level description metadata corresponding one-to-one with `statements`. Kept outside
    /// `Statement` so the generated parser's embedded ParseContext layout stays stable.
    struct StatementDescription {
        TextSpan statement_span;
        TextSpan source_span;
        uint32_t description_begin = 0;
        uint32_t description_count = 0;
    };

    /// The origin id
    const CatalogEntryID external_id;
    /// The scanned script
    std::shared_ptr<ScannedScript> scanned_script;
    /// The nodes
    std::vector<buffers::parser::Node> nodes;
    /// The statements
    std::vector<Statement> statements;
    /// The parser errors
    std::vector<parser::ParseError> errors;
    /// Symbol-index spans (begin, end) covering the bodies of vis specs
    std::vector<std::pair<uint32_t, uint32_t>> vis_spec_spans;
    /// Bitwise OR of ParsedScriptFeature values detected by the parser.
    uint32_t feature_flags = 0;

   public:
    /// Constructor
    ParsedScript(std::shared_ptr<ScannedScript> scan, parser::ParseContext&& context);

    /// Derive source spans and contiguous description comment blocks after parsing.
    std::vector<StatementDescription> AssociateDescriptions() const;
    /// Pack normalized metadata for a single statement.
    std::unique_ptr<buffers::parser::StatementT> PackStatement(size_t statement_id) const;

    /// Get the nodes
    auto& GetNodes() const { return nodes; }
    /// Resolve statement and ast node at a text offset
    std::optional<std::pair<size_t, size_t>> FindNodeAtOffset(size_t text_offset) const;
    /// Pack syntax tokens (uses AST to correct keyword-as-identifier types)
    std::unique_ptr<buffers::parser::ScannerTokensT> PackTokens();
    /// Build the script
    flatbuffers::Offset<buffers::parser::ParsedScript> Pack(flatbuffers::FlatBufferBuilder& builder);
};

class AnalyzedScript : public CatalogEntry {
    friend class Script;
    friend struct NameResolutionPass;

   public:
    // Type aliases for backward compatibility - types are now defined in dashql/analyzer/analyzer_types.h
    using TableReference = dashql::TableReference;
    using InsertStatement = dashql::InsertStatement;
    using Expression = dashql::Expression;
    using ResultTarget = dashql::ResultTarget;
    using CTEDefinition = dashql::CTEDefinition;
    using NameScope = dashql::NameScope;
    using ConstantExpression = dashql::ConstantExpression;
    using VisEncodingChannel = dashql::VisEncodingChannel;
    using VisualizationSpec = dashql::VisualizationSpec;
    using InferenceConstraint = dashql::InferenceConstraint;
    using InferredColumn = dashql::InferredColumn;
    using InferredTableSchema = dashql::InferredTableSchema;

    /// The parsed script
    std::shared_ptr<ParsedScript> parsed_script;

    /// The analyzer errors
    std::vector<buffers::analyzer::AnalyzerErrorT> errors;

    /// The node markers.
    /// Semantic node markers annotate the ast with lightweight semantic tags.
    /// For example, we remember which ast nodes store a column ref, literals or constant expressions.
    /// These markers can be used in the UI for hints and highlighting.
    std::vector<buffers::analyzer::SemanticNodeMarkerType> node_markers;

    /// The table references
    ChunkBuffer<TableReference, 16> table_references;
    /// INSERT statements
    ChunkBuffer<InsertStatement, 4> insert_statements;
    /// The expressions
    ChunkBuffer<Expression, 16> expressions;
    /// The function arguments (referenced by function call expressions)
    ChunkBuffer<Expression::FunctionArgument, 16> function_arguments;
    /// The name scopes
    ChunkBuffer<NameScope, 16> name_scopes;

    /// The name scopes by scope root.
    /// Name scopes maintain intrusive lists with all column reference expressions.
    std::unordered_map<NodeID, std::reference_wrapper<NameScope>> name_scopes_by_root_node;

    /// The constant expressions in the script
    ChunkBuffer<ConstantExpression, 16> constant_expressions;
    /// The visualization specs in the script
    ChunkBuffer<VisualizationSpec, 4> visualization_specs;

    /// The schema-inference constraints collected from unresolved column uses.
    /// Each constraint says a column must be owned by one of a set of unresolved tables.
    ChunkBuffer<InferenceConstraint, 16> inference_constraints;
    /// The inferred schemas for tables not present in the catalog, keyed by normalized table name.
    ChunkBuffer<InferredTableSchema, 8> inferred_table_schemas;
    /// The inferred table schemas indexed by normalized (db, schema, table) name.
    std::unordered_map<CatalogEntry::QualifiedTableName::Key, std::reference_wrapper<InferredTableSchema>, TupleHasher>
        inferred_table_schemas_by_name;

    /// Traverse the name scopes for a given ast node id
    void FollowPathUpwards(uint32_t ast_node_id, std::vector<uint32_t>& ast_node_path,
                           std::vector<std::reference_wrapper<AnalyzedScript::NameScope>>& scopes) const;

   public:
    /// Constructor
    AnalyzedScript(std::shared_ptr<ParsedScript> parsed, Catalog& catalog);

    /// Helper to add an expression
    template <typename Inner> Expression& AddExpression(size_t node_id, SymbolSpan location, Inner&& inner) {
        auto& n = expressions.PushBack(AnalyzedScript::Expression());
        n.buffer_index = expressions.GetSize() - 1;
        n.expression_id = static_cast<uint32_t>(expressions.GetSize() - 1);
        n.ast_node_id = node_id;
        n.ast_statement_id = std::nullopt;
        n.location = location;
        n.is_constant_expression = false;
        n.inner = std::move(inner);
        return n;
    }

    /// Describe the catalog entry
    virtual flatbuffers::Offset<buffers::catalog::CatalogEntry> DescribeEntry(
        flatbuffers::FlatBufferBuilder& builder) const override;
    /// Get the name search index
    const CatalogEntry::NameSearchIndex& GetNameSearchIndex() override;
    /// Build the program
    flatbuffers::Offset<buffers::analyzer::AnalyzedScript> Pack(flatbuffers::FlatBufferBuilder& builder);
};

class Script;

struct ScriptCursor {
    /// Cursor is pointing at a table reference
    struct TableRefContext {
        /// The table ref that the cursor is pointing into
        uint32_t table_reference_id;
        /// Points at the table ref alias?
        bool at_alias;
    };
    /// Cursor is pointing at a column reference
    struct ColumnRefContext {
        /// The table ref that the cursor is pointing into
        uint32_t expression_id;
    };
    /// A name component type
    enum NameComponentType { Name, Star, TrailingDot, Index };
    /// A name component
    struct NameComponent {
        /// The location
        sx::parser::SymbolSpan loc;
        /// The component type
        NameComponentType type;
        /// The name (if any)
        std::optional<std::reference_wrapper<RegisteredName>> name;
    };

    /// The script
    const Script& script;
    /// The text offset
    size_t text_offset = 0;
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
    /// Read the name path of the current cursor
    std::vector<NameComponent> ReadCursorNamePath(sx::parser::SymbolSpan& name_path_loc) const;

    /// Pack the cursor info
    flatbuffers::Offset<buffers::cursor::ScriptCursor> Pack(flatbuffers::FlatBufferBuilder& builder) const;

    /// Create a script cursor (throws Exception on error)
    static std::unique_ptr<ScriptCursor> Place(const Script& script, size_t text_offset);
};

class Script {
    friend class Catalog;

   protected:
    void AnalyzeInternal(bool parse_if_outdated);

   public:
    /// The catalog
    Catalog& catalog;
    /// The catalog entry id
    const CatalogEntryID catalog_entry_id;

    /// The underlying rope
    rope::Rope text;
    /// The text version
    TextVersion text_version = 0;

    /// The last scanned script
    std::shared_ptr<ScannedScript> scanned_script;
    /// The last parsed script
    std::shared_ptr<ParsedScript> parsed_script;
    /// The last analyzed script
    std::shared_ptr<AnalyzedScript> analyzed_script;
    /// The last cursor
    std::unique_ptr<ScriptCursor> cursor;

    /// The memory statistics
    buffers::statistics::ScriptProcessingTimings timing_statistics;
    /// Get memory statisics
    std::unique_ptr<buffers::statistics::ScriptMemoryStatistics> GetMemoryStatistics();

   public:
    /// Constructor
    Script(Catalog& catalog);
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
    /// Get the latest scanned script
    auto& GetScannedScript() const { return scanned_script; };
    /// Get the latest scanned script
    auto& GetParsedScript() const { return parsed_script; };
    /// Get the latest parsed script
    auto& GetAnalyzedScript() const { return analyzed_script; };

    /// Insert a unicode codepoint at an offset
    void InsertCharAt(size_t offset, uint32_t unicode);
    /// Insert a text at an offset
    void InsertTextAt(size_t offset, std::string_view text);
    /// Erase a text range
    void EraseTextRange(size_t offset, size_t count);
    /// Replace the entire text
    void ReplaceText(std::string_view text);
    /// Replace the execution-derived output schema. Returns true if it changed.
    /// Print the entire script as a string.
    std::string ToString();
    /// Print a byte span of the script as a string.
    std::string ToString(TextSpan span);
    /// Print the first parsed statement without its separator or surrounding trivia.
    std::string GetStatementText(bool parse_if_outdated = true);
    /// Rewrite the terminal VISUALIZE statement's dashboard clause.
    std::string RewriteDashboard(std::optional<int32_t> row, std::optional<int32_t> column, int32_t width,
                                 int32_t height, bool parse_if_outdated = true);
    /// Compute a versioned semantic signature from the parsed statement ASTs.
    /// Source trivia and a terminal VISUALIZE specification do not participate.
    std::string ComputeSignature(bool parse_if_outdated = true);
    /// Compile the script into an executable query.
    ScriptCompilationResult CompileQuery(const buffers::formatting::FormattingConfigT& config,
                                         ScriptCompilationOptions options = {});

    /// Scans the script unconditionally (throws Exception on error)
    void Scan();
    /// Parses the script unconditionally (throws Exception on error)
    void Parse();
    /// Analyzes the script (throws Exception on error)
    /// When `parse_if_outdated` is set we scan and parse the script, if it changed.
    void Analyze(bool parse_if_outdated = true);

    /// Move the cursor (throws Exception on error)
    const ScriptCursor* MoveCursor(size_t text_offset);
    /// Complete at the cursor (throws Exception on error)
    std::unique_ptr<Completion> CompleteAtCursor(size_t limit = 10) const;
    /// Get statisics
    std::unique_ptr<buffers::statistics::ScriptStatisticsT> GetStatistics();

    /// Format a script
    std::string Format(const buffers::formatting::FormattingConfigT& config, bool parse_if_outdated = true);
    std::vector<uint32_t> GetUnformattableNodes(const buffers::formatting::FormattingConfigT& config,
                                                bool parse_if_outdated = true);
    bool IsFullyFormattable(const buffers::formatting::FormattingConfigT& config, bool parse_if_outdated = true);
};

}  // namespace dashql
