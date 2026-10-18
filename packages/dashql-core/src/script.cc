#include "dashql/script.h"

#include <flatbuffers/flatbuffer_builder.h>

#include <algorithm>
#include <chrono>
#include <iomanip>
#include <memory>
#include <optional>
#include <sstream>
#include <type_traits>
#include <unordered_set>
#include <variant>

#include "dashql/analyzer/analyzer.h"
#include "dashql/analyzer/completion.h"
#include "dashql/buffers/index_generated.h"
#include "dashql/catalog.h"
#include "dashql/exception.h"
#include "dashql/external.h"
#include "dashql/formatter/formatter.h"
#include "dashql/parser/parse_context.h"
#include "dashql/parser/parser.h"
#include "dashql/parser/scanner.h"
#include "dashql/script_compiler.h"
#include "dashql/utils/ast_attributes.h"
#include "dashql/visualize/markdown.h"
#include "dashql/visualize/umap.h"
#include "dashql/visualize/vegalite.h"

namespace dashql {

namespace {

using AttributeKey = buffers::parser::AttributeKey;
using Node = buffers::parser::Node;
using NodeType = buffers::parser::NodeType;
using StatementType = buffers::parser::StatementType;

constexpr uint8_t SCRIPT_SIGNATURE_VERSION = 1;

bool IsEnumNode(NodeType type) {
    auto id = static_cast<uint32_t>(type);
    return (id > static_cast<uint32_t>(NodeType::ENUM_KEYS_) &&
            id < static_cast<uint32_t>(NodeType::OBJECT_KEYS_)) ||
           (id >= static_cast<uint32_t>(NodeType::ENUM_VIS_ENCODING_CHANNEL) &&
            id <= static_cast<uint32_t>(NodeType::ENUM_VIS_SCALE_TYPE));
}

template <typename T>
void AppendInteger(std::string& output, T value) {
    using U = std::make_unsigned_t<T>;
    auto encoded = static_cast<U>(value);
    for (size_t i = 0; i < sizeof(U); ++i) {
        output.push_back(static_cast<char>((encoded >> (i * 8)) & 0xff));
    }
}

void AppendText(std::string& output, std::string_view text) {
    AppendInteger<uint64_t>(output, text.size());
    output.append(text);
}

void AppendSignatureNode(const ParsedScript& parsed, const Node& node, std::string& output,
                         bool normalize_attribute = false) {
    const auto type = node.node_type();
    AppendInteger<uint16_t>(output, static_cast<uint16_t>(type));
    AppendInteger<uint16_t>(output,
                            normalize_attribute ? 0 : static_cast<uint16_t>(node.attribute_key()));

    switch (type) {
        case NodeType::NONE:
        case NodeType::LITERAL_NULL:
            break;
        case NodeType::BOOL:
            AppendInteger<uint8_t>(output, node.children_begin_or_value() != 0);
            break;
        case NodeType::NAME:
            AppendText(output, parsed.scanned_script->name_registry.At(node.children_begin_or_value()).text);
            break;
        case NodeType::OPERATOR:
        case NodeType::LITERAL_INTEGER:
        case NodeType::LITERAL_FLOAT:
        case NodeType::LITERAL_STRING:
        case NodeType::LITERAL_INTERVAL:
            AppendText(output, parsed.scanned_script->ReadTextAtSymbolSpan(node.symbol_span()));
            break;
        case NodeType::ARRAY:
            AppendInteger<uint32_t>(output, node.children_count());
            break;
        default:
            if (IsEnumNode(type)) {
                AppendInteger<uint32_t>(output, node.children_begin_or_value());
            } else {
                AppendInteger<uint32_t>(output, node.children_count());
            }
            break;
    }
}

std::array<uint64_t, 2> HashSignatureBytes(std::string_view bytes) {
    std::array<uint64_t, 2> digest{14695981039346656037ull, 7809847782465536322ull};
    for (auto byte : bytes) {
        auto value = static_cast<uint8_t>(byte);
        digest[0] = (digest[0] ^ value) * 1099511628211ull;
        digest[1] = (digest[1] ^ static_cast<uint8_t>(value + 0x9d)) * 1099511628211ull;
    }
    return digest;
}

}  // namespace

/// Helper template for static_assert in generic visitor
template <typename T> constexpr bool always_false = false;

/// Finish a statement
std::unique_ptr<buffers::parser::StatementT> ParsedScript::Statement::Pack() const {
    auto stmt = std::make_unique<buffers::parser::StatementT>();
    stmt->statement_type = type;
    stmt->root_node = root;
    stmt->nodes_begin = nodes_begin;
    stmt->node_count = node_count;
    return stmt;
}

/// Constructor
ScannedScript::ScannedScript(const rope::Rope& text, TextVersion text_version, CatalogEntryID external_id)
    : external_id(external_id), text_buffer(text.ToString(true)), text_version(text_version) {}
/// Constructor
ScannedScript::ScannedScript(std::string text, TextVersion text_version, CatalogEntryID external_id)
    : external_id(external_id), text_buffer(std::move(text)), text_version(text_version) {
    if (text_buffer.size() < 2) {
        text_buffer.resize(2);
    }
    text_buffer[text_buffer.size() - 1] = 0;
    text_buffer[text_buffer.size() - 2] = 0;
}

/// Resolve a token-index SymbolSpan to a text-positional TextSpan
buffers::parser::TextSpan ScannedScript::ResolveTextSpan(buffers::parser::SymbolSpan span) const {
    if (span.length() == 0) {
        if (span.offset() >= symbols.GetSize()) {
            return buffers::parser::TextSpan(static_cast<uint32_t>(text_buffer.size() > 2 ? text_buffer.size() - 2 : 0),
                                             0);
        }
        auto& sym = symbols[span.offset()];
        return buffers::parser::TextSpan(sym.location.offset(), 0);
    }
    auto& first = symbols[span.offset()];
    auto& last = symbols[span.offset() + span.length() - 1];
    uint32_t begin = first.location.offset();
    uint32_t end = last.location.offset() + last.location.length();
    return buffers::parser::TextSpan(begin, end - begin);
}

/// Find a token at a text offset
ScannedScript::LocationInfo ScannedScript::FindSymbol(size_t text_offset) {
    using RelativePosition = ScannedScript::LocationInfo::RelativePosition;
    auto& chunks = symbols.GetChunks();
    auto user_text_end = std::max<size_t>(text_buffer.size(), 2) - 2;
    text_offset = std::min<size_t>(user_text_end, text_offset);

    // Helper to determine the insert mode
    auto get_relative_position = [&](size_t text_offset, ChunkBufferEntryID symbol_id) -> RelativePosition {
        // Should actually never happen.
        // We're never pointing one past the last chunk after searching the symbol.
        if (symbol_id.chunk_id >= chunks.size()) {
            return RelativePosition::AFTER_SYMBOL;
        }
        auto& chunk = chunks[symbol_id.chunk_id];
        auto symbol = chunk[symbol_id.chunk_entry_id];
        auto symbol_begin = symbol.location.offset();
        auto symbol_end = symbol.location.offset() + symbol.location.length();

        // Before the symbol?
        // Can happen wen the offset points at the beginning of the text
        if (text_offset < symbol_begin) {
            return RelativePosition::BEFORE_SYMBOL;
        }
        // Begin of the token?
        if (text_offset == symbol_begin) {
            return RelativePosition::BEGIN_OF_SYMBOL;
        }
        // End of the token?
        if (text_offset == symbol_end) {
            return RelativePosition::END_OF_SYMBOL;
        }
        // Mid of the token?
        if (text_offset > symbol_begin && (text_offset < symbol_end)) {
            return RelativePosition::MID_OF_SYMBOL;
        }
        // This happens when we're pointing at white-space after a symbol.
        // (end + 1), since end emits END_OF_SYMBOL
        return RelativePosition::AFTER_SYMBOL;
    };

    // Find chunk that contains the text offset.
    // Chunks grow exponentially in size, so this is logarithmic in cost
    auto chunk_iter = chunks.begin();
    for (; chunk_iter != chunks.end(); ++chunk_iter) {
        size_t text_from = chunk_iter->front().location.offset();
        if (text_from > text_offset) {
            break;
        }
    }

    // Get previous chunk
    if (chunk_iter > chunks.begin()) {
        --chunk_iter;
    }

    // Otherwise we found a chunk that contains the text offset.
    // Binary search the token offset.
    auto symbol_iter =
        std::upper_bound(chunk_iter->begin(), chunk_iter->end(), text_offset,
                         [](size_t ofs, parser::Parser::symbol_type& token) { return ofs < token.location.offset(); });
    if (symbol_iter > chunk_iter->begin()) {
        --symbol_iter;
    }
    size_t chunk_id = chunk_iter - chunks.begin();
    size_t chunk_symbol_id = symbol_iter - chunk_iter->begin();
    assert(symbols.GetSize() >= 1);

    // Hit EOF? Get last token before EOF (if there is one)
    if (symbol_iter->kind_ == parser::Parser::symbol_kind::S_YYEOF) {
        if (chunk_symbol_id == 0) {
            if (chunk_iter > chunks.begin()) {
                --chunk_iter;
                chunk_symbol_id = chunk_iter->size() - 1;
                symbol_iter = chunk_iter->begin() + chunk_symbol_id;
            } else {
                // Very first token is EOF token?
                // Special case empty script buffer
                SymbolLocationInfo current{ChunkBufferEntryID{0, 0}, *symbol_iter, text_offset,
                                           RelativePosition::BEFORE_SYMBOL};
                return LocationInfo{std::move(current), std::nullopt};
            }
        } else {
            --chunk_symbol_id;
            --symbol_iter;
        }
    }

    // Construct the current symbol information
    ChunkBufferEntryID symbol_id{chunk_id, chunk_symbol_id};
    SymbolLocationInfo current_symbol{symbol_id, *symbol_iter, text_offset,
                                      get_relative_position(text_offset, symbol_id)};

    // Resolve the previous symbol
    auto prev_symbol_id = symbols.GetPrevious(symbol_id);
    SymbolLocationInfo prev_symbol{prev_symbol_id, symbols[prev_symbol_id], text_offset,
                                   get_relative_position(text_offset, prev_symbol_id)};

    return {std::move(current_symbol), std::move(prev_symbol)};
}

/// Is a text offset inside a comment?
bool ScannedScript::IsInsideComment(size_t text_offset) const {
    // Comments are stored sorted by offset (the scanner emits them left to right), so binary search
    // for the last comment that starts at or before the cursor.
    auto iter = std::upper_bound(comments.begin(), comments.end(), text_offset,
                                 [](size_t ofs, const buffers::parser::TextSpan& c) { return ofs < c.offset(); });
    if (iter == comments.begin()) {
        return false;
    }
    --iter;
    auto begin = iter->offset();
    auto end = begin + iter->length();

    // The leading position is never "inside": a cursor right before `--` or `/*` still belongs to
    // the preceding code, so completion should fire there.
    if (text_offset <= begin) {
        return false;
    }

    // Line comments (`-- ...`) don't include the terminating newline in their span, so the cursor is
    // still inside the comment when it sits at the span end (end of the commented line). Block
    // comments (`/* ... */`) include the closing `*/`, so a cursor at the span end is past the
    // comment and completion should fire again.
    bool is_line_comment = iter->length() >= 2 && text_buffer[begin] == '-' && text_buffer[begin + 1] == '-';
    return is_line_comment ? (text_offset <= end) : (text_offset < end);
}

flatbuffers::Offset<buffers::parser::ScannedScript> ScannedScript::Pack(flatbuffers::FlatBufferBuilder& builder) {
    buffers::parser::ScannedScriptT out;
    out.external_id = external_id;
    out.errors.reserve(errors.size());
    for (auto& [loc, msg] : errors) {
        auto err = std::make_unique<buffers::parser::ErrorT>();
        err->text_span = std::make_unique<buffers::parser::TextSpan>(loc.offset(), loc.length());
        err->message = msg;
        out.errors.push_back(std::move(err));
    }
    out.line_breaks = line_breaks;
    out.comments = comments;
    return buffers::parser::ScannedScript::Pack(builder, &out);
}

/// Constructor
ParsedScript::ParsedScript(std::shared_ptr<ScannedScript> scan, parser::ParseContext&& ctx)
    : external_id(scan->external_id),
      scanned_script(scan),
      nodes(ctx.nodes.Flatten()),
      statements(std::move(ctx.statements)),
      errors(std::move(ctx.errors)),
      vis_spec_spans(std::move(ctx.vis_spec_spans)),
      comment_blocks(parser::GroupComments(scan->GetInput(), scan->comments)) {
    for (const auto& node : nodes) {
        switch (node.node_type()) {
            case buffers::parser::NodeType::OBJECT_VIS_VISUALISE:
                feature_flags |= static_cast<uint32_t>(buffers::parser::ParsedScriptFeature::VISUALIZE);
                break;
            default:
                break;
        }
    }
    assert(std::is_sorted(statements.begin(), statements.end(),
                          [](auto& l, auto& r) { return l.nodes_begin < r.nodes_begin; }));
}

std::unique_ptr<buffers::parser::StatementT> ParsedScript::PackStatement(size_t statement_id) const {
    const auto& parsed = *this;
    const auto& statement = statements[statement_id];
    auto out = statement.Pack();
    const auto& root = parsed.nodes[statement.root];
    auto find_attribute = [&](buffers::parser::AttributeKey key) -> const buffers::parser::Node* {
        for (size_t i = 0; i < root.children_count(); ++i) {
            const auto& child = parsed.nodes[root.children_begin_or_value() + i];
            if (child.attribute_key() == key) return &child;
        }
        return nullptr;
    };
    auto find_select_attribute = [&](buffers::parser::AttributeKey key) -> const buffers::parser::Node* {
        const buffers::parser::Node* current = &root;
        while (current->node_type() == buffers::parser::NodeType::OBJECT_SQL_SELECT) {
            const buffers::parser::Node* next = nullptr;
            for (size_t i = 0; i < current->children_count(); ++i) {
                const auto& child = parsed.nodes[current->children_begin_or_value() + i];
                if (child.attribute_key() == key) return &child;
                if (child.attribute_key() == buffers::parser::AttributeKey::SQL_COMBINE_INPUT &&
                    child.node_type() == buffers::parser::NodeType::ARRAY && child.children_count() > 0) {
                    next = &parsed.nodes[child.children_begin_or_value()];
                }
            }
            if (next == nullptr) break;
            current = next;
        }
        return nullptr;
    };
    auto read_name = [&](const buffers::parser::Node* source) -> std::string {
        if (!source || source->node_type() != buffers::parser::NodeType::NAME) return {};
        return std::string(parsed.scanned_script->GetNames().At(source->children_begin_or_value()).text);
    };
    auto read_target = [&](const buffers::parser::Node* source) {
        if (source && source->node_type() == buffers::parser::NodeType::OBJECT_SQL_TABLEREF) {
            for (size_t i = 0; i < source->children_count(); ++i) {
                const auto& child = parsed.nodes[source->children_begin_or_value() + i];
                if (child.attribute_key() == buffers::parser::AttributeKey::SQL_TABLEREF_NAME) {
                    source = &child;
                    break;
                }
            }
        }
        if (!source || source->node_type() != buffers::parser::NodeType::ARRAY) return;
        auto children = std::span{parsed.nodes}.subspan(source->children_begin_or_value(), source->children_count());
        if (children.empty() || children.size() > 3) return;
        auto target = std::make_unique<buffers::parser::StatementTargetT>();
        target->relation_name = read_name(&children.back());
        if (children.size() >= 2) target->schema_name = read_name(&children[children.size() - 2]);
        if (children.size() == 3) target->database_name = read_name(&children.front());
        if (!target->relation_name.empty()) out->target = std::move(target);
    };
    auto set_target = [&](buffers::parser::StatementTargetType type, buffers::parser::AttributeKey key) {
        out->target_type = type;
        read_target(find_attribute(key));
    };

    switch (statement.type) {
        case buffers::parser::StatementType::CREATE_TABLE:
            set_target(buffers::parser::StatementTargetType::TABLE,
                       buffers::parser::AttributeKey::SQL_CREATE_TABLE_NAME);
            break;
        case buffers::parser::StatementType::CREATE_TABLE_AS:
            set_target(buffers::parser::StatementTargetType::TABLE, buffers::parser::AttributeKey::SQL_CREATE_AS_NAME);
            break;
        case buffers::parser::StatementType::CREATE_VIEW:
            set_target(buffers::parser::StatementTargetType::VIEW, buffers::parser::AttributeKey::SQL_VIEW_NAME);
            break;
        case buffers::parser::StatementType::DROP_TABLE:
            set_target(buffers::parser::StatementTargetType::TABLE, buffers::parser::AttributeKey::SQL_DROP_NAME);
            break;
        case buffers::parser::StatementType::DROP_VIEW:
            set_target(buffers::parser::StatementTargetType::VIEW, buffers::parser::AttributeKey::SQL_DROP_NAME);
            break;
        case buffers::parser::StatementType::SELECT_INTO: {
            auto* into = find_select_attribute(buffers::parser::AttributeKey::SQL_SELECT_INTO);
            if (into && into->node_type() != buffers::parser::NodeType::NONE) {
                out->target_type = buffers::parser::StatementTargetType::TABLE;
                for (size_t i = 0; i < into->children_count(); ++i) {
                    const auto& child = parsed.nodes[into->children_begin_or_value() + i];
                    if (child.attribute_key() == buffers::parser::AttributeKey::SQL_TEMP_NAME) {
                        read_target(&child);
                        break;
                    }
                }
            }
            break;
        }
        case buffers::parser::StatementType::ATTACH_DATABASE: {
            auto attach = std::make_unique<buffers::parser::AttachDatabaseStatementT>();
            attach->path = read_name(find_attribute(buffers::parser::AttributeKey::SQL_ATTACH_DATABASE_PATH));
            attach->alias = read_name(find_attribute(buffers::parser::AttributeKey::SQL_ATTACH_DATABASE_ALIAS));
            attach->local = find_attribute(buffers::parser::AttributeKey::SQL_ATTACH_DATABASE_LOCAL) != nullptr;
            out->attach_database = std::move(attach);
            break;
        }
        case buffers::parser::StatementType::INSERT:
            set_target(buffers::parser::StatementTargetType::TABLE,
                       buffers::parser::AttributeKey::SQL_INSERT_TARGET);
            break;
        case buffers::parser::StatementType::DELETE:
            set_target(buffers::parser::StatementTargetType::TABLE,
                       buffers::parser::AttributeKey::SQL_DELETE_TARGET);
            break;
        default:
            break;
    }
    return out;
}

/// Return true when every byte in [begin, end) is SQL whitespace or a statement separator.
/// Comments are checked separately because their text may contain arbitrary characters.
static bool IsDescriptionGap(std::string_view text, size_t begin, size_t end) {
    for (size_t i = begin; i < end; ++i) {
        switch (text[i]) {
            case ' ':
            case '\t':
            case '\n':
            case '\r':
            case '\f':
            case ';':
                break;
            default:
                return false;
        }
    }
    return true;
}

/// Return the end of the statement source, including comments that trail its terminating semicolon
/// on the same line. Leading blocks for the next statement always begin after a line break.
static size_t StatementSourceEnd(std::string_view text, size_t sql_end, size_t limit,
                                 std::span<const TextSpan> comments) {
    size_t end = sql_end;
    for (auto& comment : comments) {
        if (comment.offset() < end || comment.offset() >= limit) {
            continue;
        }
        if (!IsDescriptionGap(text, end, comment.offset())) {
            break;
        }
        auto gap = text.substr(end, comment.offset() - end);
        if (gap.find_first_of("\n\r") != std::string_view::npos) {
            break;
        }
        end = comment.offset() + comment.length();
    }
    return end;
}

/// True when the only source between spans is a permitted description gap. A leading comment must start
/// on a fresh line when it follows prior SQL, so `select 1; -- trailing` never becomes the next
/// statement's description.
static bool IsLeadingDescriptionCommentGap(std::string_view text, size_t previous_end, const TextSpan& comment) {
    if (!IsDescriptionGap(text, previous_end, comment.offset())) {
        return false;
    }
    if (previous_end == 0 || comment.offset() == 0) {
        return true;
    }
    return text.substr(previous_end, comment.offset() - previous_end).find_first_of("\n\r") != std::string_view::npos;
}

std::vector<ParsedScript::StatementDescription> ParsedScript::AssociateDescriptions() const {
    auto input = scanned_script->GetInput();
    auto& comments = scanned_script->comments;
    std::vector<StatementDescription> metadata;
    metadata.reserve(statements.size());

    // AST root spans cover SQL tokens, but intentionally exclude statement separators and comments.
    // Extend each root to its first following semicolon before the next statement's root.
    for (size_t i = 0; i < statements.size(); ++i) {
        auto& statement = statements[i];
        auto root_span = scanned_script->ResolveTextSpan(nodes[statement.root].symbol_span());
        size_t end = root_span.offset() + root_span.length();
        size_t next_begin = input.size();
        if (i + 1 < statements.size()) {
            next_begin = scanned_script->ResolveTextSpan(nodes[statements[i + 1].root].symbol_span()).offset();
        }
        for (size_t cursor = end; cursor < next_begin; ++cursor) {
            auto comment = std::find_if(comments.begin(), comments.end(), [cursor](const TextSpan& span) {
                return span.offset() <= cursor && cursor < span.offset() + span.length();
            });
            if (comment != comments.end()) {
                cursor = comment->offset() + comment->length() - 1;
                continue;
            }
            if (input[cursor] == ';') {
                end = cursor + 1;
                break;
            }
        }
        end = StatementSourceEnd(input, end, next_begin, comments);
        metadata.push_back({
            .statement_span = root_span,
            .source_span = TextSpan(root_span.offset(), static_cast<uint32_t>(end - root_span.offset())),
        });
    }

    size_t comment_cursor = 0;
    size_t previous_end = 0;
    size_t block_cursor = 0;
    auto& blocks = comment_blocks.blocks;
    for (size_t i = 0; i < statements.size(); ++i) {
        auto& statement_metadata = metadata[i];
        while (comment_cursor < comments.size() && comments[comment_cursor].offset() < previous_end) {
            ++comment_cursor;
        }
        size_t begin = comment_cursor;
        size_t end = begin;
        size_t cursor = previous_end;
        while (end < comments.size() && comments[end].offset() < statement_metadata.source_span.offset()) {
            auto& comment = comments[end];
            bool first = end == begin;
            bool allowed = first ? IsLeadingDescriptionCommentGap(input, cursor, comment)
                                 : IsDescriptionGap(input, cursor, comment.offset());
            if (!allowed) {
                begin = end + 1;
            }
            cursor = comment.offset() + comment.length();
            ++end;
        }
        if (begin < end && IsDescriptionGap(input, cursor, statement_metadata.source_span.offset())) {
            statement_metadata.description_begin = static_cast<uint32_t>(begin);
            statement_metadata.description_count = static_cast<uint32_t>(end - begin);
            // Blocks never straddle the description comments, find the last description block among them
            while (block_cursor < blocks.size() && blocks[block_cursor].comments_begin() < begin) ++block_cursor;
            for (; block_cursor < blocks.size() && blocks[block_cursor].comments_begin() < end; ++block_cursor) {
                if (blocks[block_cursor].block_type() == buffers::parser::CommentBlockType::DASHQL_DESCRIPTION) {
                    statement_metadata.description_block = static_cast<uint32_t>(block_cursor);
                }
            }
        }
        previous_end = statement_metadata.source_span.offset() + statement_metadata.source_span.length();
        comment_cursor = end;
    }
    return metadata;
}

/// Resolve an ast node
std::optional<std::pair<size_t, size_t>> ParsedScript::FindNodeAtOffset(size_t text_offset) const {
    if (statements.empty()) {
        return std::nullopt;
    }
    auto& scan = *scanned_script;
    // Find statement that includes the text offset by searching the predecessor of the first statement after the text
    // offset
    size_t statement_id = 0;
    for (; statement_id < statements.size(); ++statement_id) {
        auto ts = scan.ResolveTextSpan(nodes[statements[statement_id].root].symbol_span());
        if (ts.offset() > text_offset) {
            break;
        }
    }
    // First statement and begins > text_offset, bail out
    if (statement_id == 0) {
        return std::nullopt;
    }
    --statement_id;
    // Traverse down the AST
    auto iter = statements[statement_id].root;
    while (true) {
        // Reached node without children? Then return that node
        auto& node = nodes[iter];
        if (node.children_count() == 0) {
            break;
        }
        // Otherwise find the first child that includes the offset
        // Children are not ordered by location but ideally, there should only be a single match.
        std::optional<size_t> child_exact;
        std::optional<size_t> child_end_plus_1;
        for (size_t i = 0; i < node.children_count(); ++i) {
            auto ci = node.children_begin_or_value() + i;
            auto ts = scan.ResolveTextSpan(nodes[ci].symbol_span());
            auto node_begin = ts.offset();
            auto node_end = node_begin + ts.length();
            // Includes the offset?
            // Note that we want an exact match here since AST nodes will include "holes".
            // For example, a select clause does not emit a node for a FROM keyword.
            // It would be misleading if we'd return the closest node that is materialized in the AST.
            if (node_begin <= text_offset) {
                if (node_end > text_offset) {
                    child_exact = ci;
                } else if (node_end == text_offset) {
                    child_end_plus_1 = ci;
                }
            }
        }
        auto child = child_exact.has_value() ? child_exact : child_end_plus_1;
        if (!child.has_value()) {
            // None of the children included the text offset.
            // Abort and return the current node as best match.
            break;
        }
        // Traverse down
        iter = *child;
        child_exact.reset();
        child_end_plus_1.reset();
    }
    // Return (statement, node)-pair
    return std::make_pair(statement_id, iter);
}

/// Pack the FlatBuffer
flatbuffers::Offset<buffers::parser::ParsedScript> ParsedScript::Pack(flatbuffers::FlatBufferBuilder& builder) {
    buffers::parser::ParsedScriptT out;
    out.external_id = external_id;
    out.nodes = nodes;
    out.statements.reserve(statements.size());
    auto descriptions = AssociateDescriptions();
    for (size_t i = 0; i < statements.size(); ++i) {
        auto statement = PackStatement(i);
        auto& metadata = descriptions[i];
        statement->statement_span = std::make_unique<buffers::parser::TextSpan>(metadata.statement_span);
        statement->description_begin = metadata.description_begin;
        statement->description_count = metadata.description_count;
        statement->description_block = metadata.description_block;
        out.statements.push_back(std::move(statement));
    }
    // Pack scanner errors
    out.scanner_errors.reserve(scanned_script->errors.size());
    for (auto& [loc, msg] : scanned_script->errors) {
        auto err = std::make_unique<buffers::parser::ErrorT>();
        err->text_span = std::make_unique<buffers::parser::TextSpan>(loc.offset(), loc.length());
        err->message = msg;
        out.scanner_errors.push_back(std::move(err));
    }
    // Pack parser errors
    out.parser_errors.reserve(errors.size());
    for (auto& parser_error : errors) {
        auto err = std::make_unique<buffers::parser::ErrorT>();
        err->symbol_span = std::make_unique<buffers::parser::SymbolSpan>(parser_error.location);
        err->text_span =
            std::make_unique<buffers::parser::TextSpan>(scanned_script->ResolveTextSpan(parser_error.location));
        err->message = parser_error.message;
        err->hint = parser_error.hint;
        out.parser_errors.push_back(std::move(err));
    }
    out.tokens = PackTokens();
    out.line_breaks = scanned_script->line_breaks;
    out.comments = scanned_script->comments;
    out.comment_blocks = comment_blocks.blocks;
    out.comment_lines = comment_blocks.lines;
    out.metadata_block = comment_blocks.metadata_block;
    out.feature_flags = feature_flags;
    return buffers::parser::ParsedScript::Pack(builder, &out);
}

flatbuffers::Offset<buffers::analyzer::QualifiedTableName> AnalyzedScript::QualifiedTableName::Pack(
    flatbuffers::FlatBufferBuilder& builder) const {
    flatbuffers::Offset<flatbuffers::String> database_name_ofs;
    flatbuffers::Offset<flatbuffers::String> schema_name_ofs;
    flatbuffers::Offset<flatbuffers::String> table_name_ofs;
    if (!database_name.get().text.empty()) {
        database_name_ofs = builder.CreateString(database_name.get().text);
    }
    if (!schema_name.get().text.empty()) {
        schema_name_ofs = builder.CreateString(schema_name.get().text);
    }
    if (!table_name.get().text.empty()) {
        table_name_ofs = builder.CreateString(table_name.get().text);
    }
    buffers::analyzer::QualifiedTableNameBuilder out{builder};
    out.add_ast_node_id(ast_node_id.value_or(PROTO_NULL_U32));
    out.add_database_name(database_name_ofs);
    out.add_schema_name(schema_name_ofs);
    out.add_table_name(table_name_ofs);
    return out.Finish();
}

flatbuffers::Offset<buffers::analyzer::QualifiedColumnName> AnalyzedScript::QualifiedColumnName::Pack(
    flatbuffers::FlatBufferBuilder& builder) const {
    flatbuffers::Offset<flatbuffers::String> table_alias_ofs;
    flatbuffers::Offset<flatbuffers::String> column_name_ofs;
    if (table_alias && !table_alias.value().get().text.empty()) {
        table_alias_ofs = builder.CreateString(table_alias.value().get().text);
    }
    if (!column_name.get().text.empty()) {
        column_name_ofs = builder.CreateString(column_name.get().text);
    }
    buffers::analyzer::QualifiedColumnNameBuilder out{builder};
    out.add_ast_node_id(ast_node_id.value_or(PROTO_NULL_U32));
    out.add_table_alias(table_alias_ofs);
    out.add_column_name(column_name_ofs);
    return out.Finish();
}

flatbuffers::Offset<buffers::analyzer::QualifiedFunctionName> AnalyzedScript::QualifiedFunctionName::Pack(
    flatbuffers::FlatBufferBuilder& builder) const {
    flatbuffers::Offset<flatbuffers::String> database_name_ofs;
    flatbuffers::Offset<flatbuffers::String> schema_name_ofs;
    flatbuffers::Offset<flatbuffers::String> function_name_ofs;
    if (!database_name.get().text.empty()) {
        database_name_ofs = builder.CreateString(database_name.get().text);
    }
    if (!schema_name.get().text.empty()) {
        schema_name_ofs = builder.CreateString(schema_name.get().text);
    }
    if (!function_name.get().text.empty()) {
        function_name_ofs = builder.CreateString(function_name.get().text);
    }
    buffers::analyzer::QualifiedFunctionNameBuilder out{builder};
    out.add_ast_node_id(ast_node_id.value_or(PROTO_NULL_U32));
    out.add_database_name(database_name_ofs);
    out.add_schema_name(schema_name_ofs);
    out.add_function_name(function_name_ofs);
    return out.Finish();
}

flatbuffers::Offset<buffers::analyzer::FunctionDeclaration> CatalogEntry::FunctionDeclaration::Pack(
    flatbuffers::FlatBufferBuilder& builder) const {
    auto function_name_ofs = function_name.Pack(builder);
    flatbuffers::Offset<flatbuffers::String> return_type_ofs;
    if (!return_type.empty()) {
        return_type_ofs = builder.CreateString(return_type);
    }
    std::vector<flatbuffers::Offset<buffers::analyzer::FunctionParam>> param_offsets;
    param_offsets.reserve(params.size());
    for (auto& p : params) {
        auto param_name_ofs = builder.CreateString(p.param_name.get().text);
        auto param_type_ofs = builder.CreateString(p.param_type);
        buffers::analyzer::FunctionParamBuilder pb{builder};
        pb.add_ast_node_id(p.ast_node_id.value_or(PROTO_NULL_U32));
        pb.add_param_name(param_name_ofs);
        pb.add_param_type(param_type_ofs);
        param_offsets.push_back(pb.Finish());
    }
    auto params_ofs = builder.CreateVector(param_offsets);
    buffers::analyzer::FunctionDeclarationBuilder out{builder};
    out.add_ast_node_id(ast_node_id);
    out.add_ast_statement_id(ast_statement_id.value_or(PROTO_NULL_U32));
    out.add_is_aggregate(is_aggregate);
    out.add_function_name(function_name_ofs);
    out.add_params(params_ofs);
    out.add_return_type(return_type_ofs);
    return out.Finish();
}

/// Pack as FlatBuffer
flatbuffers::Offset<buffers::analyzer::TableReference> AnalyzedScript::TableReference::Pack(
    flatbuffers::FlatBufferBuilder& builder) const {
    auto& relation_expr = std::get<AnalyzedScript::TableReference::RelationExpression>(inner);
    auto table_name_ofs = relation_expr.table_name.Pack(builder);

    flatbuffers::Offset<buffers::analyzer::ResolvedTable> resolved_ofs;
    if (relation_expr.resolved_table.has_value()) {
        auto& resolved = relation_expr.resolved_table.value();
        auto resolved_table_name = resolved.table_name.Pack(builder);
        buffers::analyzer::ResolvedTableBuilder resolved_builder{builder};
        auto [db_id, schema_id] = resolved.catalog_schema_id.UnpackSchemaID();
        auto table_id = resolved.catalog_table_id.UnpackTableID();
        resolved_builder.add_catalog_database_id(db_id);
        resolved_builder.add_catalog_schema_id(schema_id);
        resolved_builder.add_catalog_table_id(table_id.Pack());
        resolved_builder.add_table_name(resolved_table_name);
        resolved_builder.add_referenced_catalog_version(resolved.referenced_catalog_version);
        resolved_ofs = resolved_builder.Finish();
    }
    flatbuffers::Offset<flatbuffers::String> alias_name_ofs;
    if (alias.has_value()) {
        alias_name_ofs = builder.CreateString(alias.value().first.get().text);
    }
    buffers::analyzer::TableReferenceBuilder out{builder};
    out.add_ast_node_id(ast_node_id);
    out.add_ast_statement_id(ast_statement_id.value_or(PROTO_NULL_U32));
    if (location.has_value()) {
        out.add_symbol_span(&location.value());
    }
    out.add_table_name(table_name_ofs);
    if (alias.has_value()) {
        out.add_alias_name(alias_name_ofs);
    }
    if (!resolved_ofs.IsNull()) {
        out.add_resolved_table(resolved_ofs);
    }
    out.add_role(role == Role::Write ? buffers::analyzer::TableReferenceRole::WRITE
                                     : buffers::analyzer::TableReferenceRole::READ);
    return out.Finish();
}

/// Pack as FlatBuffer
flatbuffers::Offset<buffers::algebra::Expression> AnalyzedScript::Expression::Pack(
    flatbuffers::FlatBufferBuilder& builder) const {
    std::optional<buffers::algebra::ExpressionSubType> inner_type;
    flatbuffers::Offset<void> inner_ofs;

    // Use std::visit for type-safe variant handling
    std::visit(
        [&](const auto& value) {
            using T = std::decay_t<decltype(value)>;

            if constexpr (std::is_same_v<T, std::monostate>) {
                // Empty variant case - no action needed
            } else if constexpr (std::is_same_v<T, AnalyzedScript::Expression::ColumnRef>) {
                auto& column_ref = value;
                auto column_name_ofs = column_ref.column_name.Pack(builder);

                flatbuffers::Offset<buffers::algebra::ResolvedColumn> resolved_ofs;
                if (auto resolved = column_ref.GetResolvedColumnIDs()) {
                    buffers::algebra::ResolvedColumnBuilder resolved_builder{builder};
                    auto [db_id, schema_id] = resolved->catalog_schema_id.UnpackSchemaID();
                    auto [table_id, column_idx] = resolved->catalog_table_column_id.UnpackTableColumnID();
                    resolved_builder.add_catalog_database_id(db_id);
                    resolved_builder.add_catalog_schema_id(schema_id);
                    resolved_builder.add_catalog_table_id(table_id.Pack());
                    resolved_builder.add_column_id(column_idx);
                    resolved_builder.add_referenced_catalog_version(resolved->referenced_catalog_version);
                    resolved_ofs = resolved_builder.Finish();
                }
                buffers::algebra::ColumnRefExpressionBuilder out{builder};
                out.add_ast_scope_root(column_ref.ast_scope_root.value_or(std::numeric_limits<uint32_t>::max()));
                out.add_column_name(column_name_ofs);
                if (!resolved_ofs.IsNull()) {
                    out.add_resolved_column(resolved_ofs);
                }
                inner_type = buffers::algebra::ExpressionSubType::ColumnRefExpression;
                inner_ofs = out.Finish().Union();
            } else if constexpr (std::is_same_v<T, AnalyzedScript::Expression::Literal>) {
                auto& literal = value;
                auto raw_value_ofs = builder.CreateString(literal.raw_value);

                buffers::algebra::LiteralBuilder literal_builder{builder};
                literal_builder.add_literal_type(literal.literal_type);
                literal_builder.add_raw_value(raw_value_ofs);

                inner_type = buffers::algebra::ExpressionSubType::Literal;
                inner_ofs = literal_builder.Finish().Union();
            } else if constexpr (std::is_same_v<T, AnalyzedScript::Expression::Comparison>) {
                auto& comparison = value;

                buffers::algebra::ComparisonBuilder comparison_builder{builder};
                comparison_builder.add_func(comparison.func);
                comparison_builder.add_left_child(comparison.left_expression_id);
                comparison_builder.add_right_child(comparison.right_expression_id);

                inner_type = buffers::algebra::ExpressionSubType::Comparison;
                inner_ofs = comparison_builder.Finish().Union();
            } else if constexpr (std::is_same_v<T, AnalyzedScript::Expression::BinaryExpression>) {
                auto& binary = value;

                buffers::algebra::BinaryExpressionBuilder binary_builder{builder};
                binary_builder.add_func(binary.func);
                binary_builder.add_left_child(binary.left_expression_id);
                binary_builder.add_right_child(binary.right_expression_id);

                inner_type = buffers::algebra::ExpressionSubType::BinaryExpression;
                inner_ofs = binary_builder.Finish().Union();
            } else if constexpr (std::is_same_v<T, AnalyzedScript::Expression::FunctionCallExpression>) {
                auto& func_call = value;

                flatbuffers::Offset<buffers::analyzer::QualifiedFunctionName> func_name_ofs;
                if (std::holds_alternative<CatalogEntry::QualifiedFunctionName>(func_call.function_name)) {
                    auto& qualified_name = std::get<CatalogEntry::QualifiedFunctionName>(func_call.function_name);
                    func_name_ofs = qualified_name.Pack(builder);
                }

                // Handle generic arguments as a vector of uint32_t expression IDs
                flatbuffers::Offset<flatbuffers::Vector<uint32_t>> arguments_ofs;
                if (std::holds_alternative<AnalyzedScript::Expression::FunctionCallExpression::GenericArguments>(
                        func_call.arguments)) {
                    auto& generic_args = std::get<AnalyzedScript::Expression::FunctionCallExpression::GenericArguments>(
                        func_call.arguments);
                    std::vector<uint32_t> arg_ids;
                    arg_ids.reserve(generic_args.size());
                    for (const auto& arg : generic_args) {
                        if (arg.expression_id.has_value()) {
                            arg_ids.push_back(arg.expression_id.value());
                        }
                    }
                    arguments_ofs = builder.CreateVector(arg_ids);
                }
                // Note: Other argument types (CastArguments, ExtractArguments, etc.) are handled as std::monostate
                // and will result in an empty arguments vector, which is fine for now

                buffers::algebra::FunctionCallExpressionBuilder func_builder{builder};
                if (!func_name_ofs.IsNull()) {
                    func_builder.add_func_name(func_name_ofs);
                }
                func_builder.add_func_call_modifiers(func_call.function_call_modifiers);
                if (!arguments_ofs.IsNull()) {
                    func_builder.add_arguments(arguments_ofs);
                }

                inner_type = buffers::algebra::ExpressionSubType::FunctionCallExpression;
                inner_ofs = func_builder.Finish().Union();
            } else if constexpr (std::is_same_v<T, AnalyzedScript::Expression::ConstIntervalCast>) {
                auto& interval_cast = value;

                buffers::algebra::ConstIntervalCastBuilder interval_builder{builder};
                interval_builder.add_value_expression(interval_cast.value_expression_id);
                if (interval_cast.interval.has_value()) {
                    interval_builder.add_interval_type(interval_cast.interval.value().interval_type);
                    if (interval_cast.interval.value().precision_expression.has_value()) {
                        interval_builder.add_interval_precision(
                            interval_cast.interval.value().precision_expression.value());
                    }
                }

                inner_type = buffers::algebra::ExpressionSubType::ConstIntervalCast;
                inner_ofs = interval_builder.Finish().Union();
            } else {
                // This will cause a compile error if a new type is added to the variant
                // but not handled in the visitor
                static_assert(always_false<T>, "Unhandled expression type in Pack method");
            }
        },
        inner);
    buffers::algebra::ExpressionBuilder out{builder};
    out.add_ast_node_id(ast_node_id);
    out.add_ast_statement_id(ast_statement_id.value_or(PROTO_NULL_U32));
    if (location.has_value()) {
        out.add_symbol_span(&location.value());
    }
    if (inner_type.has_value()) {
        out.add_inner_type(inner_type.value());
        out.add_inner(inner_ofs);
    }
    return out.Finish();
}

/// Constructor
AnalyzedScript::AnalyzedScript(std::shared_ptr<ParsedScript> parsed, Catalog& catalog)
    : CatalogEntry(catalog, parsed->external_id), parsed_script(std::move(parsed)), node_markers() {
    assert(parsed_script != nullptr);
    node_markers.resize(parsed_script->GetNodes().size(), buffers::analyzer::SemanticNodeMarkerType::NONE);
}

/// Get the name search index
flatbuffers::Offset<buffers::catalog::CatalogEntry> AnalyzedScript::DescribeEntry(
    flatbuffers::FlatBufferBuilder& builder) const {
    std::vector<flatbuffers::Offset<buffers::catalog::SchemaTable>> table_offsets;
    table_offsets.reserve(table_declarations.GetSize());
    uint32_t table_id = 0;
    for (auto& table_chunk : table_declarations.GetChunks()) {
        for (auto& table : table_chunk) {
            auto table_name = builder.CreateString(table.table_name.table_name.get().text);

            std::vector<flatbuffers::Offset<buffers::catalog::SchemaTableColumn>> column_offsets;
            column_offsets.reserve(table.table_columns.size());
            for (auto& column : table.table_columns) {
                auto column_name = builder.CreateString(column.column_name.get().text);
                buffers::catalog::SchemaTableColumnBuilder column_builder{builder};
                column_builder.add_column_name(column_name);
                column_offsets.push_back(column_builder.Finish());
            }
            auto columns_offset = builder.CreateVector(column_offsets);

            buffers::catalog::SchemaTableBuilder table_builder{builder};
            table_builder.add_table_id(table_id++);
            table_builder.add_table_name(table_name);
            table_builder.add_columns(columns_offset);
        }
    }
    auto tables_offset = builder.CreateVector(table_offsets);

    buffers::catalog::SchemaDescriptorBuilder schemaBuilder{builder};
    schemaBuilder.add_tables(tables_offset);
    auto schema_offset = schemaBuilder.Finish();
    std::vector<flatbuffers::Offset<buffers::catalog::SchemaDescriptor>> schemas{schema_offset};
    auto schemas_offset = builder.CreateVector(schemas);

    buffers::catalog::CatalogEntryBuilder catalog{builder};
    catalog.add_catalog_entry_id(catalog_entry_id);
    catalog.add_catalog_entry_type(buffers::catalog::CatalogEntryType::DESCRIPTOR_POOL);
    catalog.add_rank(0);
    catalog.add_schemas(schemas_offset);
    return catalog.Finish();
}

/// Get the name search index
const CatalogEntry::NameSearchIndex& AnalyzedScript::GetNameSearchIndex() {
    if (!name_search_index.has_value()) {
        auto& index = name_search_index.emplace();
        auto& names = parsed_script->scanned_script->name_registry.GetChunks();
        for (auto& names_chunk : names) {
            for (auto& name : names_chunk) {
                auto s = name.text;
                for (size_t i = 1; i <= s.size(); ++i) {
                    auto suffix = s.substr(s.size() - i);
                    index.insert({{suffix.data(), suffix.size()}, name});
                }
            }
        }
    }
    return name_search_index.value();
}

template <typename In, typename Out, size_t ChunkSize>
static flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<Out>>> PackVector(
    flatbuffers::FlatBufferBuilder& builder, const ChunkBuffer<In, ChunkSize>& elems) {
    std::vector<flatbuffers::Offset<Out>> offsets;
    offsets.reserve(elems.GetSize());
    for (auto& chunk : elems.GetChunks()) {
        for (auto& elem : chunk) {
            offsets.push_back(elem.Pack(builder));
        }
    }
    return builder.CreateVector(offsets);
};

template <typename In, typename Out, size_t ChunkSize>
static flatbuffers::Offset<flatbuffers::Vector<const Out*>> packStructVector(flatbuffers::FlatBufferBuilder& builder,
                                                                             const ChunkBuffer<In, ChunkSize>& elems) {
    Out* writer;
    auto out = builder.CreateUninitializedVectorOfStructs(elems.GetSize(), &writer);
    for (auto& chunk : elems.GetChunks()) {
        for (auto& elem : chunk) {
            *(writer++) = static_cast<const Out>(elem);
        }
    }
    return out;
};

// Pack an analyzed script
flatbuffers::Offset<buffers::analyzer::AnalyzedScript> AnalyzedScript::Pack(flatbuffers::FlatBufferBuilder& builder) {
    // Pack tables
    flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<buffers::analyzer::Table>>> tables_ofs;
    {
        std::vector<flatbuffers::Offset<buffers::analyzer::Table>> table_offsets;
        table_offsets.reserve(table_declarations.GetSize());
        for (auto& table_chunk : table_declarations.GetChunks()) {
            for (auto& table : table_chunk) {
                table_offsets.push_back(table.Pack(builder));
            }
        }
        tables_ofs = builder.CreateVector(table_offsets);
    }
    // Pack table references
    auto table_references_ofs =
        PackVector<AnalyzedScript::TableReference, buffers::analyzer::TableReference>(builder, table_references);
    flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<buffers::analyzer::InsertStatement>>>
        insert_statements_ofs;
    {
        std::vector<flatbuffers::Offset<buffers::analyzer::InsertStatement>> insert_offsets;
        insert_offsets.reserve(insert_statements.GetSize());
        insert_statements.ForEach([&](size_t, const InsertStatement& insert) {
            std::vector<flatbuffers::Offset<buffers::analyzer::InsertTargetColumn>> column_offsets;
            column_offsets.reserve(insert.target_columns.size());
            for (auto& column : insert.target_columns) {
                auto name_ofs = builder.CreateString(column.column_name.get().text);
                flatbuffers::Offset<buffers::algebra::ResolvedColumn> resolved_ofs;
                if (column.resolved) {
                    auto& resolved_column = column.resolved->get();
                    auto& table = resolved_column.table->get();
                    auto [db_id, schema_id] = table.catalog_schema_id.UnpackSchemaID();
                    auto [table_id, column_id] = resolved_column.object_id.UnpackTableColumnID();
                    buffers::algebra::ResolvedColumnBuilder rb{builder};
                    rb.add_catalog_database_id(db_id);
                    rb.add_catalog_schema_id(schema_id);
                    rb.add_catalog_table_id(table_id.Pack());
                    rb.add_column_id(column_id);
                    rb.add_referenced_catalog_version(table.catalog_version);
                    resolved_ofs = rb.Finish();
                }
                buffers::analyzer::InsertTargetColumnBuilder cb{builder};
                cb.add_ast_node_id(column.ast_node_id);
                cb.add_column_name(name_ofs);
                if (!resolved_ofs.IsNull()) cb.add_resolved_column(resolved_ofs);
                column_offsets.push_back(cb.Finish());
            }
            auto columns_ofs = builder.CreateVector(column_offsets);
            buffers::analyzer::InsertStatementBuilder ib{builder};
            ib.add_ast_node_id(insert.ast_node_id);
            ib.add_ast_statement_id(insert.ast_statement_id.value_or(PROTO_NULL_U32));
            ib.add_target_table_reference_id(insert.target.get().table_reference_id.GetObject());
            ib.add_source_ast_node_id(insert.source_ast_node_id.value_or(PROTO_NULL_U32));
            ib.add_default_values(insert.default_values);
            ib.add_returning(insert.returning);
            ib.add_target_columns(columns_ofs);
            insert_offsets.push_back(ib.Finish());
        });
        insert_statements_ofs = builder.CreateVector(insert_offsets);
    }
    // Pack expressions
    auto expressions_ofs = PackVector<AnalyzedScript::Expression, buffers::algebra::Expression>(builder, expressions);

    // Build index: (db_id, schema_id, table_id) -> table_ref*
    flatbuffers::Offset<flatbuffers::Vector<const buffers::analyzer::IndexedTableReference*>>
        resolved_table_refs_by_id_ofs;
    {
        std::vector<buffers::analyzer::IndexedTableReference> table_refs_by_id;
        table_refs_by_id.reserve(table_references.GetSize());
        table_references.ForEach([&](size_t ref_id, TableReference& ref) {
            if (auto* table_ref = std::get_if<TableReference::RelationExpression>(&ref.inner);
                table_ref && table_ref->resolved_table.has_value()) {
                auto& resolved = table_ref->resolved_table.value();
                auto [db_id, schema_id] = resolved.catalog_schema_id.UnpackSchemaID();
                auto table_id = resolved.catalog_table_id.UnpackTableID().Pack();
                table_refs_by_id.emplace_back(db_id, schema_id, table_id, ref_id);
            }
        });
        std::sort(table_refs_by_id.begin(), table_refs_by_id.end(),
                  [&](buffers::analyzer::IndexedTableReference& l, buffers::analyzer::IndexedTableReference& r) {
                      auto a = std::make_tuple(l.catalog_database_id(), l.catalog_schema_id(), l.catalog_table_id());
                      auto b = std::make_tuple(r.catalog_database_id(), r.catalog_schema_id(), r.catalog_table_id());
                      return a < b;
                  });
        resolved_table_refs_by_id_ofs = builder.CreateVectorOfStructs(table_refs_by_id);
    }

    // Build index: (db_id, schema_id, table_id, column_id) -> column_ref*
    flatbuffers::Offset<flatbuffers::Vector<const buffers::analyzer::IndexedColumnReference*>>
        resolved_column_refs_by_id_ofs;
    {
        std::vector<buffers::analyzer::IndexedColumnReference> column_refs_by_id;
        column_refs_by_id.reserve(expressions.GetSize());
        expressions.ForEach([&](size_t ref_id, Expression& ref) {
            if (auto* column_ref = std::get_if<AnalyzedScript::Expression::ColumnRef>(&ref.inner);
                column_ref && column_ref->IsResolved()) {
                if (auto resolved = column_ref->GetResolvedColumnIDs()) {
                    auto [db_id, schema_id] = resolved->catalog_schema_id.UnpackSchemaID();
                    auto [table_id, column_idx] = resolved->catalog_table_column_id.UnpackTableColumnID();
                    column_refs_by_id.emplace_back(db_id, schema_id, table_id.Pack(), column_idx, ref_id);
                }
            }
        });
        std::sort(column_refs_by_id.begin(), column_refs_by_id.end(),
                  [&](buffers::analyzer::IndexedColumnReference& l, buffers::analyzer::IndexedColumnReference& r) {
                      auto a = std::make_tuple(l.catalog_database_id(), l.catalog_schema_id(), l.catalog_table_id(),
                                               l.table_column_id());
                      auto b = std::make_tuple(r.catalog_database_id(), r.catalog_schema_id(), r.catalog_table_id(),
                                               r.table_column_id());
                      return a < b;
                  });
        resolved_column_refs_by_id_ofs = builder.CreateVectorOfStructs(column_refs_by_id);
    }

    // Pack name scopes
    flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<buffers::analyzer::NameScope>>> name_scopes_ofs;
    {
        std::vector<flatbuffers::Offset<buffers::analyzer::NameScope>> name_scope_offsets;
        name_scopes.ForEach([&](size_t scope_id, const NameScope& scope) {
            // Encode child scopes
            builder.StartVector<uint32_t>(scope.child_scopes.GetSize());
            for (auto& child_scope : scope.child_scopes) {
                builder.PushElement(child_scope.buffer_index);
            }
            flatbuffers::Offset<flatbuffers::Vector<uint32_t>> child_scopes_ofs{
                builder.EndVector(scope.child_scopes.GetSize())};

            // Encode expressions
            builder.StartVector<uint32_t>(scope.child_scopes.GetSize());
            for (auto& expr : scope.expressions) {
                builder.PushElement(expr.buffer_index);
            }
            flatbuffers::Offset<flatbuffers::Vector<uint32_t>> expressions_ofs{
                builder.EndVector(scope.expressions.GetSize())};

            // Encode table references
            builder.StartVector<uint32_t>(scope.table_references.GetSize());
            for (auto& ref : scope.table_references) {
                builder.PushElement(ref.buffer_index);
            }
            flatbuffers::Offset<flatbuffers::Vector<uint32_t>> table_refs_ofs{
                builder.EndVector(scope.table_references.GetSize())};

            buffers::analyzer::NameScopeBuilder scope_builder{builder};
            scope_builder.add_scope_id(scope_id);
            scope_builder.add_ast_node_id(scope.ast_node_id);
            scope_builder.add_ast_statement_id(scope.ast_statement_id);
            scope_builder.add_child_scopes(child_scopes_ofs);
            scope_builder.add_expressions(expressions_ofs);
            scope_builder.add_table_references(table_refs_ofs);

            name_scope_offsets.push_back(scope_builder.Finish());
        });
        name_scopes_ofs = builder.CreateVector(name_scope_offsets);
    }

    // Pack constant expressions
    buffers::analyzer::ConstantExpression* constant_expressions_writer;
    auto constant_expressions_ofs =
        builder.CreateUninitializedVectorOfStructs(constant_expressions.GetSize(), &constant_expressions_writer);
    constant_expressions.ForEach([&](size_t i, const AnalyzedScript::ConstantExpression& filter) {
        auto& root = filter.root.get();
        assert(root.location.has_value());
        constant_expressions_writer[i] =
            buffers::analyzer::ConstantExpression(root.ast_node_id, root.ast_statement_id.value_or(PROTO_NULL_U32),
                                                  root.location.value(), root.expression_id);
    });

    // Pack function declarations
    flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<buffers::analyzer::FunctionDeclaration>>>
        func_decls_ofs;
    {
        std::vector<flatbuffers::Offset<buffers::analyzer::FunctionDeclaration>> func_offsets;
        func_offsets.reserve(function_declarations.GetSize());
        for (auto& func_chunk : function_declarations.GetChunks()) {
            for (auto& func : func_chunk) {
                func_offsets.push_back(func.Pack(builder));
            }
        }
        func_decls_ofs = builder.CreateVector(func_offsets);
    }

    // Pack visualization specs (with Vega-Lite JSON generated on demand)
    flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<buffers::analyzer::VisualizationSpec>>>
        visualization_specs_ofs;
    {
        std::vector<flatbuffers::Offset<buffers::analyzer::VisualizationSpec>> spec_offsets;
        spec_offsets.reserve(visualization_specs.GetSize());
        visualization_specs.ForEach([&](size_t, VisualizationSpec& spec) {
            // Each renderer emits its own serialized spec string. The grammar rejects
            // unknown renderers, so only the branches below can produce output here.
            bool is_vegalite = spec.renderer.has_value() && *spec.renderer == "vegalite";
            bool is_umap = spec.renderer.has_value() && *spec.renderer == "umap";
            bool is_markdown = spec.renderer.has_value() && *spec.renderer == "markdown";
            bool is_table = spec.renderer.has_value() && *spec.renderer == "table";
            flatbuffers::Offset<flatbuffers::String> vegalite_ofs;
            if (is_vegalite) {
                // Generate the Vega-Lite JSON once, lazily, and cache it on the spec.
                if (spec.vegalite_json.empty()) {
                    spec.vegalite_json = visualize::GenerateVegaLiteSpec(spec, *this);
                }
                if (!spec.vegalite_json.empty()) {
                    vegalite_ofs = builder.CreateString(spec.vegalite_json);
                }
            }

            flatbuffers::Offset<buffers::visualization::UmapSpec> umap_ofs;
            if (is_umap) {
                auto umap = visualize::CompileUmapSpec(spec, *this);
                if (umap) umap_ofs = visualize::PackUmapSpec(builder, *umap);
            }

            flatbuffers::Offset<buffers::visualization::MarkdownSpec> markdown_ofs;
            if (is_markdown) {
                auto markdown = visualize::CompileMarkdownSpec(spec);
                if (markdown) markdown_ofs = visualize::PackMarkdownSpec(builder, *markdown);
            }

            auto dashboard_ofs = buffers::visualization::CreateDashboardSpec(
                builder, spec.dashboard.row, spec.dashboard.column, spec.dashboard.width, spec.dashboard.height);
            flatbuffers::Offset<buffers::visualization::TableSpec> table_ofs;
            if (is_table) {
                table_ofs = buffers::visualization::CreateTableSpec(builder);
            }

            flatbuffers::Offset<flatbuffers::String> renderer_ofs;
            if (spec.renderer.has_value()) {
                renderer_ofs = builder.CreateString(std::string(*spec.renderer));
            }

            buffers::analyzer::VisualizationSpecBuilder sb{builder};
            sb.add_ast_node_id(spec.ast_node_id);
            sb.add_ast_statement_id(spec.ast_statement_id.value_or(PROTO_NULL_U32));
            sb.add_source_kind(static_cast<buffers::analyzer::VisSourceKind>(spec.resolved_source.kind));
            sb.add_source_ast_node_id(spec.source_node_id.value_or(PROTO_NULL_U32));
            sb.add_source_inline_select_ast_node_id(
                spec.resolved_source.inline_select_ast_node_id.value_or(PROTO_NULL_U32));
            sb.add_renderer(renderer_ofs);
            sb.add_vegalite_spec(vegalite_ofs);
            sb.add_umap_spec(umap_ofs);
            sb.add_markdown_spec(markdown_ofs);
            sb.add_dashboard(dashboard_ofs);
            sb.add_table_spec(table_ofs);
            spec_offsets.push_back(sb.Finish());
        });
        visualization_specs_ofs = builder.CreateVector(spec_offsets);
    }

    // Pack the inferred table schemas
    flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<buffers::analyzer::InferredTableSchema>>>
        inferred_table_schemas_ofs;
    {
        std::vector<flatbuffers::Offset<buffers::analyzer::InferredTableSchema>> schema_offsets;
        schema_offsets.reserve(inferred_table_schemas.GetSize());
        inferred_table_schemas.ForEach([&](size_t, InferredTableSchema& schema) {
            auto table_name_ofs = schema.table_name.Pack(builder);

            std::vector<flatbuffers::Offset<buffers::analyzer::InferredColumn>> column_offsets;
            column_offsets.reserve(schema.columns.size());
            for (auto& column : schema.columns) {
                auto col_name_ofs = builder.CreateString(column.column_name.get().text);

                flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<buffers::analyzer::QualifiedTableName>>>
                    candidate_names_ofs;
                if (!column.candidate_table_names.empty()) {
                    std::vector<flatbuffers::Offset<buffers::analyzer::QualifiedTableName>> cand_offsets;
                    cand_offsets.reserve(column.candidate_table_names.size());
                    for (auto& cand : column.candidate_table_names) {
                        cand_offsets.push_back(cand.Pack(builder));
                    }
                    candidate_names_ofs = builder.CreateVector(cand_offsets);
                }

                buffers::analyzer::InferredColumnBuilder cb{builder};
                cb.add_column_name(col_name_ofs);
                cb.add_confidence(static_cast<buffers::analyzer::InferenceConfidence>(column.confidence));
                if (!column.candidate_table_names.empty()) {
                    cb.add_candidate_table_names(candidate_names_ofs);
                }
                column_offsets.push_back(cb.Finish());
            }
            auto columns_ofs = builder.CreateVector(column_offsets);

            buffers::analyzer::InferredTableSchemaBuilder tb{builder};
            tb.add_table_name(table_name_ofs);
            tb.add_confidence(static_cast<buffers::analyzer::InferenceConfidence>(schema.confidence));
            tb.add_columns(columns_ofs);
            schema_offsets.push_back(tb.Finish());
        });
        inferred_table_schemas_ofs = builder.CreateVector(schema_offsets);
    }

    buffers::analyzer::AnalyzedScriptBuilder out{builder};
    out.add_catalog_entry_id(catalog_entry_id);
    out.add_tables(tables_ofs);
    out.add_table_references(table_references_ofs);
    out.add_insert_statements(insert_statements_ofs);
    out.add_resolved_table_references_by_id(resolved_table_refs_by_id_ofs);
    out.add_expressions(expressions_ofs);
    out.add_resolved_column_references_by_id(resolved_column_refs_by_id_ofs);
    out.add_constant_expressions(constant_expressions_ofs);
    out.add_name_scopes(name_scopes_ofs);
    out.add_function_declarations(func_decls_ofs);
    out.add_visualization_specs(visualization_specs_ofs);
    out.add_inferred_table_schemas(inferred_table_schemas_ofs);
    return out.Finish();
}

void AnalyzedScript::FollowPathUpwards(uint32_t ast_node_id, std::vector<uint32_t>& ast_node_path,
                                       std::vector<std::reference_wrapper<AnalyzedScript::NameScope>>& scopes) const {
    assert(parsed_script != nullptr);

    ast_node_path.clear();
    scopes.clear();

    // Traverse all parent ids of the node
    auto& nodes = parsed_script->nodes;
    for (std::optional<size_t> node_iter = ast_node_id; node_iter.has_value();
         node_iter = nodes[node_iter.value()].parent() != node_iter.value()
                         ? std::optional{nodes[node_iter.value()].parent()}
                         : std::nullopt) {
        // Remember the node path
        ast_node_path.push_back(*node_iter);
        // Probe the name scopes
        auto scope_iter = name_scopes_by_root_node.find(node_iter.value());
        if (scope_iter != name_scopes_by_root_node.end()) {
            scopes.push_back(scope_iter->second);
        }
    }
}

Script::Script(Catalog& catalog) : catalog(catalog), catalog_entry_id(catalog.AllocateEntryId()), text(1024) {}

Script::~Script() { catalog.DropScript(*this); }

/// Insert a character at an offet
void Script::InsertCharAt(size_t char_idx, uint32_t unicode) {
    std::array<std::byte, 6> buffer;
    auto length = dashql::utf8::utf8proc_encode_char(unicode, reinterpret_cast<uint8_t*>(buffer.data()));
    std::string_view encoded{reinterpret_cast<char*>(buffer.data()), static_cast<size_t>(length)};
    InsertTextAt(char_idx, encoded);
}
/// Insert a text at an offet
void Script::InsertTextAt(size_t char_idx, std::string_view encoded) {
    if (encoded.empty()) return;
    text.Insert(char_idx, encoded);
    ++text_version;
}
/// Erase a text at an offet
void Script::EraseTextRange(size_t char_idx, size_t count) {
    if (count == 0 || char_idx >= text.GetStats().utf8_codepoints) return;
    text.Remove(char_idx, count);
    ++text_version;
}
/// Replace the text in the script
void Script::ReplaceText(std::string_view encoded) {
    if (encoded.size() == text.GetStats().text_bytes && encoded == text.ToString()) return;
    text = rope::Rope{1024, encoded};
    ++text_version;
}

/// Print the entire script as a string
std::string Script::ToString() { return text.ToString(); }
/// Print a script byte span as a string
std::string Script::ToString(TextSpan span) {
    auto output = text.ToString();
    if (span.offset() >= output.size()) {
        return {};
    }
    return output.substr(span.offset(), span.length());
}

/// Print the first parsed statement without its separator or surrounding trivia.
std::string Script::GetStatementText(bool parse_if_outdated) {
    if (parse_if_outdated &&
        (parsed_script == nullptr || parsed_script->scanned_script->text_version != text_version)) {
        Parse();
    }
    if (!parsed_script) {
        throw Exception(buffers::status::StatusCode::SCRIPT_NOT_PARSED);
    }
    auto descriptions = parsed_script->AssociateDescriptions();
    if (descriptions.empty()) {
        return {};
    }
    return ToString(descriptions.front().statement_span);
}

std::string Script::RewriteDashboard(std::optional<int32_t> row, std::optional<int32_t> column, int32_t width,
                                     int32_t height, bool parse_if_outdated) {
    if (parse_if_outdated &&
        (parsed_script == nullptr || parsed_script->scanned_script->text_version != text_version)) {
        Parse();
    }
    if (!parsed_script || !parsed_script->errors.empty() || parsed_script->statements.empty()) {
        throw Exception(buffers::status::StatusCode::SCRIPT_NOT_PARSED);
    }

    const auto& statement = parsed_script->statements.back();
    if (statement.type != StatementType::VIS_VISUALISE) {
        throw Exception(buffers::status::StatusCode::SCRIPT_NOT_PARSED);
    }
    const auto& root = parsed_script->nodes[statement.root];
    auto children = std::span{parsed_script->nodes}.subspan(root.children_begin_or_value(), root.children_count());
    auto [spec] = LookupAttributes<AttributeKey::VIS_VISUALISE_SPEC>(children);
    if (!spec) throw Exception(buffers::status::StatusCode::SCRIPT_NOT_PARSED);

    width = std::clamp(width, 1, 12);
    height = std::max(height, 1);
    if (row && *row < 0) row.reset();
    if (column) *column = std::clamp(*column, 0, 12 - width);

    std::string replacement = "dashboard => (";
    bool has_field = false;
    auto append_field = [&](std::string_view name, int32_t value) {
        if (has_field) replacement.append(", ");
        replacement.append(name);
        replacement.append(" => ");
        replacement.append(std::to_string(value));
        has_field = true;
    };
    if (row) append_field("row", *row);
    if (column) append_field("column", *column);
    append_field("width", width);
    append_field("height", height);
    replacement.push_back(')');

    auto source = text.ToString();
    auto spec_children = std::span{parsed_script->nodes}.subspan(spec->children_begin_or_value(), spec->children_count());
    auto [dashboard] = LookupAttributes<AttributeKey::VIS_SPEC_DASHBOARD>(spec_children);
    if (dashboard) {
        auto span = parsed_script->scanned_script->ResolveTextSpan(dashboard->symbol_span());
        source.replace(span.offset(), span.length(), replacement);
        return source;
    }

    auto root_span = parsed_script->scanned_script->ResolveTextSpan(root.symbol_span());
    auto insert_at = static_cast<size_t>(root_span.offset()) + root_span.length();
    if (insert_at == 0 || source[insert_at - 1] != ')') {
        throw Exception(buffers::status::StatusCode::SCRIPT_NOT_PARSED);
    }
    --insert_at;
    const bool has_spec_fields = std::any_of(spec_children.begin(), spec_children.end(),
                                             [](const Node& child) { return child.node_type() != NodeType::NONE; });
    source.insert(insert_at, has_spec_fields ? ", " + replacement : replacement);
    return source;
}

std::string Script::ComputeSignature(bool parse_if_outdated) {
    if (parse_if_outdated &&
        (parsed_script == nullptr || parsed_script->scanned_script->text_version != text_version)) {
        Parse();
    }
    if (!parsed_script || !parsed_script->scanned_script->errors.empty() || !parsed_script->errors.empty()) {
        throw Exception(buffers::status::StatusCode::SCRIPT_NOT_PARSED);
    }

    std::string script_bytes;
    script_bytes.append("DQLSIG", 6);
    AppendInteger<uint8_t>(script_bytes, SCRIPT_SIGNATURE_VERSION);
    AppendInteger<uint32_t>(script_bytes, parsed_script->statements.size());
    for (size_t i = 0; i < parsed_script->statements.size(); ++i) {
        const auto& statement = parsed_script->statements[i];
        auto type = statement.type;
        std::optional<SymbolSpan> included_span;
        std::optional<NodeID> included_root;
        if (i + 1 == parsed_script->statements.size() && type == StatementType::VIS_VISUALISE) {
            const auto& wrapper = parsed_script->nodes[statement.root];
            auto [source] = LookupAttributes<AttributeKey::VIS_VISUALISE_SELECT>(
                std::span{parsed_script->nodes}.subspan(wrapper.children_begin_or_value(), wrapper.children_count()));
            if (!source) throw Exception(buffers::status::StatusCode::SCRIPT_NOT_PARSED);
            included_span = source->symbol_span();
            included_root = static_cast<NodeID>(source - parsed_script->nodes.data());
            type = StatementType::SELECT;
        }

        std::string statement_bytes;
        for (size_t node_id = statement.nodes_begin;
             node_id < statement.nodes_begin + statement.node_count;
             ++node_id) {
            const auto& node = parsed_script->nodes[node_id];
            if (included_span) {
                const auto span = node.symbol_span();
                const auto included_end = included_span->offset() + included_span->length();
                const auto node_end = span.offset() + span.length();
                if (span.offset() < included_span->offset() || node_end > included_end) continue;
            }
            AppendSignatureNode(*parsed_script, node, statement_bytes, included_root == node_id);
        }
        const auto statement_digest = HashSignatureBytes(statement_bytes);
        AppendInteger<uint8_t>(script_bytes, static_cast<uint8_t>(type));
        AppendInteger<uint64_t>(script_bytes, statement_digest[0]);
        AppendInteger<uint64_t>(script_bytes, statement_digest[1]);
    }

    const auto digest = HashSignatureBytes(script_bytes);
    std::ostringstream output;
    output << std::hex << std::setfill('0');
    output << std::setw(16) << digest[0] << std::setw(16) << digest[1];
    return output.str();
}

ScriptCompilationResult Script::CompileQuery(const buffers::formatting::FormattingConfigT& config,
                                             ScriptCompilationOptions options) {
    return ScriptCompiler::Compile(*this, config, options);
}

/// Update memory statisics
std::unique_ptr<buffers::statistics::ScriptMemoryStatistics> Script::GetMemoryStatistics() {
    auto memory = std::make_unique<buffers::statistics::ScriptMemoryStatistics>();
    memory->mutate_rope_bytes(text.GetStats().text_bytes);

    std::unordered_set<const ScannedScript*> registered_scanned;
    std::unordered_set<const ParsedScript*> registered_parsed;
    std::unordered_set<const AnalyzedScript*> registered_analyzed;
    registered_scanned.reserve(4);
    registered_parsed.reserve(4);
    registered_analyzed.reserve(4);
    auto registerScript = [&](AnalyzedScript* analyzed, buffers::statistics::ScriptProcessingMemoryStatistics& stats) {
        if (!analyzed) return;
        // Added analyzed before?
        if (registered_analyzed.contains(analyzed)) return;
        size_t table_column_bytes = 0;
        for (auto& table_chunk : analyzed->table_declarations.GetChunks()) {
            for (auto& table : table_chunk) {
                table_column_bytes += table.table_columns.size() * sizeof(CatalogEntry::TableColumn);
            }
        }
        size_t analyzer_description_bytes =
            analyzed->database_references.GetSize() * sizeof(CatalogEntry::DatabaseReference) +
            analyzed->schema_references.GetSize() * sizeof(CatalogEntry::SchemaReference) +
            analyzed->table_declarations.GetSize() * sizeof(CatalogEntry::TableDeclaration) + table_column_bytes +
            analyzed->table_references.GetSize() * sizeof(decltype(analyzed->table_references)::value_type) +
            analyzed->expressions.GetSize() * sizeof(decltype(analyzed->expressions)::value_type) +
            analyzed->function_arguments.GetSize() * sizeof(decltype(analyzed->function_arguments)::value_type) +
            analyzed->name_scopes.GetSize() * sizeof(decltype(analyzed->name_scopes)::value_type);
        size_t analyzer_name_index_bytes = 0;
        size_t analyzer_name_search_index_size = 0;
        if (auto& index = analyzed->name_search_index) {
            analyzer_name_index_bytes = index->size() * index->average_bytes_per_value();
            analyzer_name_search_index_size = index->size();
        }
        stats.mutate_analyzer_description_bytes(analyzer_description_bytes);
        stats.mutate_analyzer_name_index_size(analyzer_name_search_index_size);
        stats.mutate_analyzer_name_index_bytes(analyzer_name_index_bytes);

        // Added parsed before?
        ParsedScript* parsed = analyzed->parsed_script.get();
        if (registered_parsed.contains(parsed)) return;
        size_t parser_ast_bytes = parsed->nodes.size() * sizeof(decltype(parsed->nodes)::value_type);
        stats.mutate_parser_ast_bytes(parser_ast_bytes);

        // Added scanned before?
        ScannedScript* scanned = parsed->scanned_script.get();
        if (registered_scanned.contains(scanned)) return;
        size_t scanner_symbol_bytes = scanned->symbols.GetSize() + sizeof(parser::Parser::symbol_type);
        size_t scanner_dictionary_bytes = scanned->name_pool.GetSize() + scanned->name_registry.GetByteSize();
        stats.mutate_scanner_input_bytes(scanned->GetInput().size());
        stats.mutate_scanner_symbol_bytes(scanner_symbol_bytes);
        stats.mutate_scanner_name_dictionary_bytes(scanner_dictionary_bytes);
    };
    registerScript(analyzed_script.get(), memory->mutable_latest_script());
    return memory;
}

/// Get statisics
std::unique_ptr<buffers::statistics::ScriptStatisticsT> Script::GetStatistics() {
    auto stats = std::make_unique<buffers::statistics::ScriptStatisticsT>();
    stats->memory = GetMemoryStatistics();
    stats->timings = std::make_unique<buffers::statistics::ScriptProcessingTimings>(timing_statistics);
    return stats;
}

void Script::Scan() {
    auto time_before = std::chrono::steady_clock::now();
    scanned_script = parser::Scanner::Scan(text, text_version, catalog_entry_id);  // throws on error
    timing_statistics.mutate_scanner_last_elapsed(
        std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - time_before).count());
}

void Script::Parse() {
    if (scanned_script == nullptr || scanned_script->text_version != text_version) {
        Scan();
    }
    auto time_before = std::chrono::steady_clock::now();
    parsed_script = parser::Parser::Parse(scanned_script);
    timing_statistics.mutate_parser_last_elapsed(
        std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - time_before).count());
}

/// Analyze a script
void Script::Analyze(bool parse_if_outdated) {
    catalog.AnalyzeScript(*this, parse_if_outdated);
}

void Script::AnalyzeInternal(bool parse_if_outdated) {
    if (parse_if_outdated) {
        // Scan the script, if needed
        if (scanned_script == nullptr || scanned_script->text_version != text_version) {
            Scan();  // throws on error
        }
        // Parse the script, if needed
        if (parsed_script == nullptr || parsed_script->scanned_script.get() != scanned_script.get()) {
            Parse();  // throws on error
        }
    }

    if (!parsed_script) throw Exception(buffers::status::StatusCode::SCRIPT_NOT_PARSED);
    // Never reuse names/intrusive links from an older analysis, even if it was destroyed.
    // Analyze(false) must clone its parsed text snapshot, not silently parse edits.
    auto& parsed_scan = parsed_script->scanned_script;
    bool names_have_been_analyzed = false;
    for (auto& chunk : parsed_scan->name_registry.GetChunks()) {
        for (auto& name : chunk) {
            // Inspect only list metadata: the linked objects may already have been destroyed.
            names_have_been_analyzed |= name.coarse_analyzer_tags != 0 || !name.resolved_objects.IsEmpty();
        }
    }
    auto local_scan_owners = scanned_script == parsed_scan ? 2 : 1;
    if (names_have_been_analyzed ||
        parsed_script.use_count() > 1 || parsed_scan.use_count() > local_scan_owners) {
        auto& previous_scan = *parsed_script->scanned_script;
        rope::Rope snapshot{1024, previous_scan.GetInput()};
        scanned_script = parser::Scanner::Scan(snapshot, previous_scan.text_version, catalog_entry_id);
        parsed_script = parser::Parser::Parse(scanned_script);
    }
    cursor.reset();
    // Analyze a script
    auto time_before_analyzing = std::chrono::steady_clock::now();
    analyzed_script = Analyzer::Analyze(parsed_script, catalog);  // throws on error
    timing_statistics.mutate_analyzer_last_elapsed(
        std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - time_before_analyzing)
            .count());
}

/// Move the cursor to a offset
const ScriptCursor* Script::MoveCursor(size_t text_offset) {
    cursor = ScriptCursor::Place(*this, text_offset);  // throws on error
    return cursor.get();
}
/// Complete at the cursor
std::unique_ptr<Completion> Script::CompleteAtCursor(size_t limit) const {
    // Fail if the user forgot to move the cursor
    if (cursor == nullptr) {
        throw Exception(buffers::status::StatusCode::COMPLETION_MISSES_CURSOR);
    }
    // Fail if the scanner is not associated with a scanner token
    if (!cursor->scanner_location.has_value()) {
        throw Exception(buffers::status::StatusCode::COMPLETION_MISSES_SCANNER_TOKEN);
    }
    // Compute the completion
    return Completion::Compute(*cursor, limit);  // throws on error
}
/// Format a script
std::string Script::Format(const buffers::formatting::FormattingConfigT& config, bool parse_if_outdated) {
    if (parse_if_outdated) {
        if (scanned_script == nullptr || scanned_script->text_version != text_version) {
            Scan();
        }
        if (parsed_script == nullptr || parsed_script->scanned_script.get() != scanned_script.get()) {
            Parse();
        }
    }
    if (!parsed_script) {
        throw Exception(buffers::status::StatusCode::SCRIPT_NOT_PARSED);
    }
    Formatter formatter{*parsed_script};
    return formatter.Format(config);
}

std::vector<uint32_t> Script::GetUnformattableNodes(const buffers::formatting::FormattingConfigT& config,
                                                    bool parse_if_outdated) {
    if (parse_if_outdated) {
        if (scanned_script == nullptr || scanned_script->text_version != text_version) Scan();
        if (parsed_script == nullptr || parsed_script->scanned_script.get() != scanned_script.get()) Parse();
    }
    if (!parsed_script) throw Exception(buffers::status::StatusCode::SCRIPT_NOT_PARSED);
    Formatter formatter{*parsed_script};
    formatter.Format(config);
    return formatter.GetUnformattableNodes();
}

bool Script::IsFullyFormattable(const buffers::formatting::FormattingConfigT& config, bool parse_if_outdated) {
    return GetUnformattableNodes(config, parse_if_outdated).empty();
}

}  // namespace dashql
