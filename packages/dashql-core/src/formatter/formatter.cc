#include "dashql/formatter/formatter.h"

#include <algorithm>
#include <cctype>
#include <optional>
#include <string>
#include <vector>

#include "dashql/formatter/formatting_program.h"

namespace dashql {

using AttributeKey = buffers::parser::AttributeKey;
using NodeType = buffers::parser::NodeType;
using ExpressionOperator = buffers::parser::ExpressionOperator;
using ColumnConstraint = buffers::parser::ColumnConstraint;
using TableConstraint = buffers::parser::TableConstraint;
using ConstraintAttribute = buffers::parser::ConstraintAttribute;
using KeyMatch = buffers::parser::KeyMatch;
using KeyActionCommand = buffers::parser::KeyActionCommand;
using KeyActionTrigger = buffers::parser::KeyActionTrigger;
using GroupByItemType = buffers::parser::GroupByItemType;
using NumericType = buffers::parser::NumericType;
using CharacterType = buffers::parser::CharacterType;
using OrderDirection = buffers::parser::OrderDirection;
using OrderNullRule = buffers::parser::OrderNullRule;
using KnownFunction = buffers::parser::KnownFunction;
using IntervalType = buffers::parser::IntervalType;
using ExtractTarget = buffers::parser::ExtractTarget;
using TrimDirection = buffers::parser::TrimDirection;
using WindowBoundDirection = buffers::parser::WindowBoundDirection;
using WindowBoundMode = buffers::parser::WindowBoundMode;
using WindowRangeMode = buffers::parser::WindowRangeMode;
using RowLockingStrength = buffers::parser::RowLockingStrength;
using RowLockingBlockBehavior = buffers::parser::RowLockingBlockBehavior;
using SampleCountUnit = buffers::parser::SampleCountUnit;

namespace {

bool IsWhitespace(std::string_view text) {
    for (char ch : text) {
        if (!std::isspace(static_cast<unsigned char>(ch))) return false;
    }
    return true;
}

std::string_view TrimWhitespace(std::string_view text) {
    while (!text.empty() && std::isspace(static_cast<unsigned char>(text.front()))) {
        text.remove_prefix(1);
    }
    while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back()))) {
        text.remove_suffix(1);
    }
    return text;
}

void AppendCommentLine(std::string& output, std::string_view text, size_t max_width) {
    if (!output.empty() && output.back() != '\n') output += '\n';
    output += "--";
    if (text.empty()) return;

    if (max_width >= 4) output += ' ';
    output += text;
}

void AppendWrappedCommentParagraph(std::string& output, const std::vector<std::string_view>& words,
                                   size_t max_width) {
    if (words.empty()) {
        AppendCommentLine(output, {}, max_width);
        return;
    }

    const size_t prefix_width = max_width >= 4 ? 3 : 2;
    const size_t content_width = max_width > prefix_width ? max_width - prefix_width : 1;
    std::string line;
    for (const auto& word : words) {
        size_t offset = 0;
        while (offset < word.size()) {
            size_t remaining = word.size() - offset;
            if (!line.empty() && line.size() + 1 + remaining > content_width) {
                AppendCommentLine(output, line, max_width);
                line.clear();
                continue;
            }

            if (remaining <= content_width - line.size() - (line.empty() ? 0 : 1)) {
                if (!line.empty()) line += ' ';
                line.append(word.substr(offset, remaining));
                offset = word.size();
            } else {
                size_t available = content_width - line.size() - (line.empty() ? 0 : 1);
                if (!line.empty()) line += ' ';
                line.append(word.substr(offset, available));
                offset += available;
                AppendCommentLine(output, line, max_width);
                line.clear();
            }
        }
    }
    if (!line.empty()) AppendCommentLine(output, line, max_width);
}

void AppendWrappedLineComments(std::string& output, std::string_view input,
                               std::span<const buffers::parser::TextSpan> comments, size_t max_width) {
    std::vector<std::string_view> normalized_lines;
    for (const auto& comment : comments) {
        auto text = input.substr(comment.offset(), comment.length());
        if (text.starts_with("--")) text.remove_prefix(2);

        while (true) {
            auto line_end = text.find_first_of("\r\n");
            auto line = TrimWhitespace(text.substr(0, line_end));
            normalized_lines.push_back(line);

            if (line_end == std::string_view::npos) break;
            size_t next = line_end + 1;
            if (text[line_end] == '\r' && next < text.size() && text[next] == '\n') ++next;
            text.remove_prefix(next);
        }
    }

    while (!normalized_lines.empty() && normalized_lines.front().empty()) {
        normalized_lines.erase(normalized_lines.begin());
    }
    while (!normalized_lines.empty() && normalized_lines.back().empty()) {
        normalized_lines.pop_back();
    }

    if (normalized_lines.empty()) {
        AppendCommentLine(output, {}, max_width);
        return;
    }

    std::vector<std::string_view> words;
    for (const auto& line : normalized_lines) {
        if (line.empty()) {
            if (!words.empty()) {
                AppendWrappedCommentParagraph(output, words, max_width);
                words.clear();
            }
            AppendCommentLine(output, {}, max_width);
            continue;
        }

        std::string_view remaining = line;
        while (!remaining.empty()) {
            auto word_end = remaining.find_first_of(" \t\r\n\f");
            auto word = remaining.substr(0, word_end);
            if (!word.empty()) words.push_back(word);
            if (word_end == std::string_view::npos) break;
            remaining.remove_prefix(word_end + 1);
            remaining = TrimWhitespace(remaining);
        }
    }
    if (!words.empty()) AppendWrappedCommentParagraph(output, words, max_width);
}

/// The tag name of a `-- @dashql:<tag>` line comment and whether the tag is alone on its line
struct CommentTag {
    std::string_view name;
    bool alone;
};

std::optional<CommentTag> ReadCommentTag(std::string_view input, const buffers::parser::TextSpan& comment) {
    auto text = input.substr(comment.offset(), comment.length());
    if (!text.starts_with("--")) return std::nullopt;
    text = TrimWhitespace(text.substr(2));
    constexpr std::string_view prefix = "@dashql:";
    if (!text.starts_with(prefix)) return std::nullopt;
    text.remove_prefix(prefix.size());
    auto name_end = text.find_first_of(" \t\r\n\f");
    auto name = text.substr(0, name_end);
    if (name.empty()) return std::nullopt;
    bool alone = name_end == std::string_view::npos || TrimWhitespace(text.substr(name_end)).empty();
    return CommentTag{name, alone};
}

/// Format a run of line comments. Regions from `-- @dashql:<tag>` to `-- @dashql:end` are kept as written, since
/// their content is structured (e.g. JSON) and rewrapping it would break it. Other comments are rewrapped.
/// A blank line that follows a region is kept, `following` is the offset of the text after the comment block.
void AppendLineCommentBlock(std::string& output, std::string_view input,
                            std::span<const buffers::parser::TextSpan> comments, size_t max_width,
                            size_t following) {
    size_t pending = 0;
    size_t i = 0;
    while (i < comments.size()) {
        auto tag = ReadCommentTag(input, comments[i]);
        if (!tag.has_value() || tag->name == "end") {
            ++i;
            continue;
        }
        size_t close = i + 1;
        while (close < comments.size()) {
            auto end_tag = ReadCommentTag(input, comments[close]);
            if (end_tag.has_value() && end_tag->alone && end_tag->name == "end") break;
            ++close;
        }
        // An unterminated region is an ordinary comment
        if (close == comments.size()) {
            ++i;
            continue;
        }
        if (pending < i) {
            AppendWrappedLineComments(output, input, comments.subspan(pending, i - pending), max_width);
        }
        for (size_t j = i; j <= close; ++j) {
            if (!output.empty() && output.back() != '\n') output += '\n';
            auto text = input.substr(comments[j].offset(), comments[j].length());
            while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back()))) text.remove_suffix(1);
            output.append(text);
        }
        size_t region_end = comments[close].offset() + comments[close].length();
        size_t next = close + 1 < comments.size() ? comments[close + 1].offset() : following;
        if (next != std::string_view::npos && next >= region_end) {
            auto gap = input.substr(region_end, next - region_end);
            if (std::count(gap.begin(), gap.end(), '\n') > 1) output += "\n\n";
        }
        pending = close + 1;
        i = close + 1;
    }
    if (pending < comments.size()) {
        AppendWrappedLineComments(output, input, comments.subspan(pending), max_width);
    }
}

void AppendComments(std::string& output, std::string_view input,
                    std::span<const buffers::parser::TextSpan> comments, size_t max_width,
                    size_t following = std::string_view::npos) {
    size_t block_begin = 0;
    for (size_t i = 0; i <= comments.size(); ++i) {
        bool end_block = i == comments.size();
        bool is_block_comment = false;
        if (!end_block) {
            auto text = input.substr(comments[i].offset(), comments[i].length());
            is_block_comment = text.starts_with("/*");
            end_block = is_block_comment;
        }
        if (!end_block && !is_block_comment && i > block_begin) {
            size_t previous_end = comments[i - 1].offset() + comments[i - 1].length();
            auto gap = input.substr(previous_end, comments[i].offset() - previous_end);
            end_block = !IsWhitespace(gap) || std::count(gap.begin(), gap.end(), '\n') > 1;
        }
        if (end_block) {
            if (i > block_begin) {
                size_t next = i < comments.size() ? comments[i].offset() : following;
                AppendLineCommentBlock(output, input, comments.subspan(block_begin, i - block_begin), max_width,
                                       next);
            }
            block_begin = i;
        }
        if (is_block_comment) {
            if (!output.empty() && output.back() != '\n') output += '\n';
            output.append(input.substr(comments[i].offset(), comments[i].length()));
            block_begin = i + 1;
        }
    }
}

struct OperatorPrecedence {
    size_t precedence;
    Formatter::Associativity associativity;
};

OperatorPrecedence GetOperatorPrecedence(ExpressionOperator op) {
    switch (op) {
        case ExpressionOperator::OR:
            return {3, Formatter::Associativity::Left};
        case ExpressionOperator::AND:
            return {4, Formatter::Associativity::Left};
        case ExpressionOperator::NOT:
            return {5, Formatter::Associativity::Right};
        case ExpressionOperator::IS_NULL:
        case ExpressionOperator::NOT_NULL:
        case ExpressionOperator::IS_TRUE:
        case ExpressionOperator::IS_FALSE:
        case ExpressionOperator::IS_UNKNOWN:
        case ExpressionOperator::IS_DISTINCT_FROM:
        case ExpressionOperator::IS_OF:
        case ExpressionOperator::IS_NOT_TRUE:
        case ExpressionOperator::IS_NOT_FALSE:
        case ExpressionOperator::IS_NOT_UNKNOWN:
        case ExpressionOperator::IS_NOT_DISTINCT_FROM:
        case ExpressionOperator::IS_NOT_OF:
        case ExpressionOperator::EQUAL:
        case ExpressionOperator::NOT_EQUAL:
        case ExpressionOperator::GREATER_EQUAL:
        case ExpressionOperator::GREATER_THAN:
        case ExpressionOperator::LESS_EQUAL:
        case ExpressionOperator::LESS_THAN:
            return {6, Formatter::Associativity::NonAssoc};
        case ExpressionOperator::BETWEEN_SYMMETRIC:
        case ExpressionOperator::BETWEEN_ASYMMETRIC:
        case ExpressionOperator::NOT_BETWEEN_SYMMETRIC:
        case ExpressionOperator::NOT_BETWEEN_ASYMMETRIC:
        case ExpressionOperator::IN:
        case ExpressionOperator::NOT_IN:
        case ExpressionOperator::GLOB:
        case ExpressionOperator::NOT_GLOB:
        case ExpressionOperator::LIKE:
        case ExpressionOperator::NOT_LIKE:
        case ExpressionOperator::ILIKE:
        case ExpressionOperator::NOT_ILIKE:
        case ExpressionOperator::SIMILAR_TO:
        case ExpressionOperator::NOT_SIMILAR_TO:
        case ExpressionOperator::OVERLAPS:
            return {7, Formatter::Associativity::NonAssoc};
        case ExpressionOperator::PLUS:
        case ExpressionOperator::MINUS:
            return {12, Formatter::Associativity::Left};
        case ExpressionOperator::MULTIPLY:
        case ExpressionOperator::DIVIDE:
        case ExpressionOperator::MODULUS:
            return {13, Formatter::Associativity::Left};
        case ExpressionOperator::XOR:
            return {14, Formatter::Associativity::Left};
        case ExpressionOperator::AT_TIMEZONE:
            return {15, Formatter::Associativity::Left};
        case ExpressionOperator::COLLATE:
            return {16, Formatter::Associativity::Left};
        case ExpressionOperator::NEGATE:
            return {17, Formatter::Associativity::Right};
        case ExpressionOperator::TYPECAST:
            return {20, Formatter::Associativity::Left};
        case ExpressionOperator::DEFAULT:
            return {0, Formatter::Associativity::NonAssoc};
    }
}

enum class OperatorBreakPreference { BreakBefore, BreakAfter };

OperatorBreakPreference GetOperatorBreakPreference(ExpressionOperator op) {
    switch (op) {
        case ExpressionOperator::OR:
        case ExpressionOperator::AND:
            return OperatorBreakPreference::BreakBefore;
        default:
            return OperatorBreakPreference::BreakAfter;
    }
}

std::string_view GetOperatorText(ExpressionOperator op) {
    switch (op) {
        case ExpressionOperator::NEGATE:
            return "-";
        case ExpressionOperator::NOT:
            return "not";
        case ExpressionOperator::PLUS:
            return "+";
        case ExpressionOperator::MINUS:
            return "-";
        case ExpressionOperator::MULTIPLY:
            return "*";
        case ExpressionOperator::DIVIDE:
            return "/";
        case ExpressionOperator::MODULUS:
            return "%";
        case ExpressionOperator::AND:
            return "and";
        case ExpressionOperator::OR:
            return "or";
        case ExpressionOperator::XOR:
            return "#";
        case ExpressionOperator::EQUAL:
            return "=";
        case ExpressionOperator::NOT_EQUAL:
            return "<>";
        case ExpressionOperator::LESS_THAN:
            return "<";
        case ExpressionOperator::GREATER_THAN:
            return ">";
        case ExpressionOperator::LESS_EQUAL:
            return "<=";
        case ExpressionOperator::GREATER_EQUAL:
            return ">=";
        case ExpressionOperator::LIKE:
            return "like";
        case ExpressionOperator::NOT_LIKE:
            return "not like";
        case ExpressionOperator::ILIKE:
            return "ilike";
        case ExpressionOperator::NOT_ILIKE:
            return "not ilike";
        case ExpressionOperator::SIMILAR_TO:
            return "similar to";
        case ExpressionOperator::NOT_SIMILAR_TO:
            return "not similar to";
        case ExpressionOperator::OVERLAPS:
            return "overlaps";
        case ExpressionOperator::GLOB:
            return "glob";
        case ExpressionOperator::NOT_GLOB:
            return "not glob";
        case ExpressionOperator::IS_NULL:
            return "is null";
        case ExpressionOperator::NOT_NULL:
            return "is not null";
        case ExpressionOperator::IS_TRUE:
            return "is true";
        case ExpressionOperator::IS_FALSE:
            return "is false";
        case ExpressionOperator::IS_UNKNOWN:
            return "is unknown";
        case ExpressionOperator::IS_NOT_TRUE:
            return "is not true";
        case ExpressionOperator::IS_NOT_FALSE:
            return "is not false";
        case ExpressionOperator::IS_NOT_UNKNOWN:
            return "is not unknown";
        case ExpressionOperator::IS_DISTINCT_FROM:
            return "is distinct from";
        case ExpressionOperator::IS_NOT_DISTINCT_FROM:
            return "is not distinct from";
        case ExpressionOperator::IN:
            return "in";
        case ExpressionOperator::NOT_IN:
            return "not in";
        case ExpressionOperator::BETWEEN_ASYMMETRIC:
        case ExpressionOperator::BETWEEN_SYMMETRIC:
            return "between";
        case ExpressionOperator::NOT_BETWEEN_ASYMMETRIC:
        case ExpressionOperator::NOT_BETWEEN_SYMMETRIC:
            return "not between";
        case ExpressionOperator::COLLATE:
            return "collate";
        case ExpressionOperator::AT_TIMEZONE:
            return "at time zone";
        case ExpressionOperator::DEFAULT:
            return "default";
        default:
            return "";
    }
}

std::string_view GetKnownFunctionText(KnownFunction fn) {
    switch (fn) {
        case KnownFunction::COLLATION_FOR:
            return "collation for";
        case KnownFunction::CURRENT_DATE:
            return "current_date";
        case KnownFunction::CURRENT_TIME:
            return "current_time";
        case KnownFunction::CURRENT_TIMESTAMP:
            return "current_timestamp";
        case KnownFunction::LOCALTIME:
            return "localtime";
        case KnownFunction::LOCALTIMESTAMP:
            return "localtimestamp";
        case KnownFunction::CURRENT_ROLE:
            return "current_role";
        case KnownFunction::CURRENT_USER:
            return "current_user";
        case KnownFunction::SESSION_USER:
            return "session_user";
        case KnownFunction::USER:
            return "user";
        case KnownFunction::CURRENT_CATALOG:
            return "current_catalog";
        case KnownFunction::CURRENT_SCHEMA:
            return "current_schema";
        case KnownFunction::CAST:
            return "cast";
        case KnownFunction::EXTRACT:
            return "extract";
        case KnownFunction::OVERLAY:
            return "overlay";
        case KnownFunction::POSITION:
            return "position";
        case KnownFunction::SUBSTRING:
            return "substring";
        case KnownFunction::TREAT:
            return "treat";
        case KnownFunction::TRIM:
            return "trim";
        case KnownFunction::NULLIF:
            return "nullif";
        case KnownFunction::COALESCE:
            return "coalesce";
    }
    return "";
}

}  // namespace

void Formatter::MarkExplainInnerStatementRoot(size_t root_id) {
    const auto& root_node = ast[root_id];
    if (root_node.node_type() != NodeType::OBJECT_EXT_EXPLAIN) return;
    auto children = ast.subspan(root_node.children_begin_or_value(), root_node.children_count());
    for (const auto& child : children) {
        if (child.attribute_key() == AttributeKey::EXT_EXPLAIN_STATEMENT) {
            size_t inner_id = &child - ast.data();
            if (inner_id < node_states.size()) {
                node_states[inner_id].is_statement_root = true;
            }
            break;
        }
    }
}

Formatter::Formatter(ParsedScript& parsed)
    : scanned(*parsed.scanned_script),
      parsed(parsed),
      ast(parsed.GetNodes().data(), parsed.GetNodes().size()),
      config(),
      fmt(),
      node_states(parsed.GetNodes().size()) {
    for (const auto& statement : parsed.statements) {
        if (statement.root < node_states.size()) {
            node_states[statement.root].is_statement_root = true;
            MarkExplainInnerStatementRoot(statement.root);
        }
    }
}

size_t Formatter::EstimateFormattedSize() const { return scanned.GetInput().size() + 64; }

void Formatter::PreparePrecedence() {
    for (size_t i = 0; i < ast.size(); ++i) {
        const auto& node = ast[i];
        if (node.node_type() != NodeType::OBJECT_SQL_NARY_EXPRESSION) continue;

        auto [op_node, args_node] =
            GetAttributes<AttributeKey::SQL_EXPRESSION_OPERATOR, AttributeKey::SQL_EXPRESSION_ARGS>(node);
        if (!op_node) continue;

        size_t precedence = 0;
        Associativity associativity = Associativity::NonAssoc;
        if (op_node->node_type() == NodeType::ENUM_SQL_EXPRESSION_OPERATOR) {
            auto op = static_cast<ExpressionOperator>(op_node->children_begin_or_value());
            auto op_precedence = GetOperatorPrecedence(op);
            precedence = op_precedence.precedence;
            associativity = op_precedence.associativity;
        } else if (op_node->node_type() == NodeType::OPERATOR) {
            precedence = 11;
            associativity = Associativity::Left;
        } else {
            continue;
        }
        auto& state = node_states[i];
        state.precedence = precedence;
        state.associativity = associativity;
        if (args_node) {
            auto& args_state = GetState(*args_node);
            args_state.precedence = precedence;
            args_state.associativity = associativity;
        }
    }
}

void Formatter::IdentifyParentheses(size_t node_id) {
    const auto& node = ast[node_id];
    if (node.node_type() != NodeType::OBJECT_SQL_NARY_EXPRESSION) return;

    auto& state = node_states[node_id];
    size_t parent_id = node.parent();
    if (parent_id >= ast.size()) return;

    const auto& parent = ast[parent_id];
    if (parent.node_type() != NodeType::ARRAY) return;

    size_t args_begin = parent.children_begin_or_value();
    size_t args_count = parent.children_count();
    if (node_id < args_begin || node_id >= args_begin + args_count) return;

    size_t arg_index = node_id - args_begin;
    const auto& parent_state = node_states[parent_id];

    bool need_parens = false;
    if (args_count == 1) {
        need_parens = true;
    } else {
        need_parens = (state.precedence < parent_state.precedence) ||
                      (state.precedence == parent_state.precedence &&
                       ((arg_index == 0 && (parent_state.associativity == Associativity::Right ||
                                            parent_state.associativity == Associativity::NonAssoc)) ||
                        (arg_index == args_count - 1 && (parent_state.associativity == Associativity::Left ||
                                                         parent_state.associativity == Associativity::NonAssoc)) ||
                        (arg_index > 0 && arg_index + 1 < args_count)));
    }
    state.needs_parentheses = need_parens;
}

FmtReg Formatter::FormatLeaf(const buffers::parser::Node& node) {
    auto text = scanned.ReadTextAtSymbolSpan(node.symbol_span());
    if (replace_obfuscated_literals) {
        auto text_offset = static_cast<uint32_t>(text.data() - scanned.text_buffer.data());
        if (auto* literal = scanned.FindObfuscatedLiteral(text_offset)) {
            return fmt.Verbatim(literal->replacement);
        }
    }
    if (node.node_type() == NodeType::BOOL || node.node_type() == NodeType::LITERAL_NULL ||
        node.node_type() == NodeType::OPERATOR) {
        return fmt.Text(text);
    }
    return fmt.Verbatim(text);
}

FmtReg Formatter::FormatUnimplemented(const buffers::parser::Node& node) {
    unformattable_nodes.push_back(static_cast<uint32_t>(&node - ast.data()));
    std::string_view type_name = buffers::parser::EnumNameNodeType(node.node_type());
    return fmt.Concat({fmt.Text("'<"), fmt.Verbatim(type_name), fmt.Text(">'")});
}

FmtReg Formatter::FormatCommaList(const buffers::parser::Node& node, bool indent_after_breaks) {
    auto children = GetArrayStates(node);
    std::vector<FmtReg> parts;
    parts.reserve(children.size());
    for (auto& child : children) {
        parts.push_back(child.reg);
    }
    auto inline_separator = fmt.Text(", ");
    auto break_separator = fmt.Concat({fmt.Text(","), fmt.Break()});
    return fmt.Join(parts, inline_separator, break_separator, std::nullopt, indent_after_breaks);
}

FmtReg Formatter::FormatQualifiedName(const buffers::parser::Node& node) {
    auto children = GetArrayStates(node);
    if (children.empty()) return fmt.Empty();

    std::vector<FmtReg> parts;
    parts.reserve(children.size());
    for (auto& child : children) {
        parts.push_back(child.reg);
    }
    auto inline_separator = fmt.Text(".");
    auto break_separator = fmt.Concat({fmt.Break(), fmt.Text(".")});
    return fmt.Join(parts, inline_separator, break_separator, std::nullopt, true);
}

FmtReg Formatter::FormatArray(const buffers::parser::Node& node) {
    if (node.attribute_key() == AttributeKey::NONE) {
        size_t parent_id = node.parent();
        if (parent_id < ast.size() && ast[parent_id].attribute_key() == AttributeKey::SQL_SELECT_VALUES) {
            return fmt.Parenthesized(FormatCommaList(node));
        }
        if (parent_id < ast.size() && ast[parent_id].attribute_key() == AttributeKey::SQL_EXPRESSION_ARGS) {
            return FormatCommaList(node);
        }
        if (parent_id < ast.size() && ast[parent_id].attribute_key() == AttributeKey::SQL_ROW_LOCKING_OF) {
            return FormatQualifiedName(node);
        }
        if (parent_id < ast.size() && ast[parent_id].attribute_key() == AttributeKey::SQL_GRAPH_MATCH_PATTERNS) {
            auto children = GetArrayStates(node);
            std::vector<FmtReg> parts;
            parts.reserve(children.size());
            for (auto& child : children) parts.push_back(child.reg);
            return fmt.Join(parts, fmt.Empty(), fmt.Break(), FormattingJoinPolicy::BreakOnOverflow, true);
        }
        if (parent_id < ast.size() && ast[parent_id].node_type() == NodeType::OBJECT_SQL_NARY_EXPRESSION) {
            return FormatCommaList(node);
        }
    }

    switch (node.attribute_key()) {
        case AttributeKey::SQL_SELECT_TARGETS:
        case AttributeKey::SQL_SELECT_FROM:
        case AttributeKey::SQL_SELECT_GROUPS:
        case AttributeKey::SQL_SELECT_ORDER:
        case AttributeKey::SQL_WINDOW_FRAME_PARTITION:
        case AttributeKey::SQL_WINDOW_FRAME_ORDER:
        case AttributeKey::SQL_FUNCTION_WITHIN_GROUP:
        case AttributeKey::SQL_FUNCTION_ARGUMENTS:
        case AttributeKey::SQL_EXPRESSION_ARGS:
        case AttributeKey::SQL_DESCRIPTOR_COLUMNS:
        case AttributeKey::SQL_ROW_TYPE_FIELDS:
        case AttributeKey::SQL_CASE_CLAUSES:
        case AttributeKey::SQL_CREATE_TABLE_ELEMENTS:
        case AttributeKey::SQL_CREATE_AS_COLUMNS:
        case AttributeKey::SQL_VIEW_COLUMNS:
        case AttributeKey::SQL_CREATE_FUNCTION_PARAMS:
        case AttributeKey::SQL_SELECT_WINDOWS:
        case AttributeKey::SQL_SELECT_ROW_LOCKING:
        case AttributeKey::SQL_ROW_LOCKING_OF:
        case AttributeKey::SQL_GROUP_BY_ITEM_ARG:
        case AttributeKey::SQL_NUMERIC_TYPE_MODIFIERS:
        case AttributeKey::SQL_GENERIC_TYPE_MODIFIERS:
        case AttributeKey::SQL_TYPENAME_ARRAY:
        case AttributeKey::SQL_ATTACH_DATABASE_OPTIONS:
        case AttributeKey::SQL_INSERT_COLUMNS:
        case AttributeKey::SQL_INSERT_RETURNING:
        case AttributeKey::SQL_DELETE_USING:
        case AttributeKey::SQL_DELETE_RETURNING:
        case AttributeKey::SQL_CTE_COLUMNS:
        case AttributeKey::SQL_GRAPH_ELEMENT_TABLE_LABELS:
        case AttributeKey::SQL_GRAPH_MATCH_PATTERNS:
        case AttributeKey::SQL_RESULT_TARGET_EXCLUDE:
            return FormatCommaList(node);
        case AttributeKey::SQL_PROPERTY_GRAPH_VERTEX_TABLES:
        case AttributeKey::SQL_PROPERTY_GRAPH_EDGE_TABLES:
        case AttributeKey::SQL_GRAPH_ELEMENT_TABLE_KEY:
        case AttributeKey::SQL_GRAPH_VERTEX_REFERENCE_KEY:
        case AttributeKey::SQL_GRAPH_VERTEX_REFERENCE_COLUMNS:
        case AttributeKey::SQL_GRAPH_PROPERTIES_COLUMNS:
        case AttributeKey::SQL_GRAPH_PROPERTIES_EXCLUDE:
        case AttributeKey::SQL_GRAPH_TABLE_COLUMNS:
            return FormatCommaList(node, false);
        case AttributeKey::EXT_EXPLAIN_OPTIONS:
            return FormatCommaList(node, false);
        case AttributeKey::EXT_EXPLAIN_EXPRESSIONS: {
            auto expressions = GetArrayStates(node);
            std::vector<FmtReg> parts;
            parts.reserve(expressions.size());
            for (auto& expression : expressions) parts.push_back(expression.reg);
            return fmt.Join(parts, fmt.Text(", "), fmt.Concat({fmt.Text(","), fmt.Break()}),
                            FormattingJoinPolicy::ForceBreak);
        }
        case AttributeKey::EXT_VARARG_FIELD_VALUE:
        case AttributeKey::SQL_GENERIC_OPTION_VALUE:
            return fmt.Parenthesized(FormatCommaList(node));
        case AttributeKey::SQL_INDIRECTION_PATH: {
            // Only field accesses for now, (p).x
            auto elements = GetArrayStates(node);
            std::vector<FmtReg> parts;
            parts.reserve(elements.size() * 2);
            auto begin = node.children_begin_or_value();
            for (size_t i = 0; i < elements.size(); ++i) {
                if (ast[begin + i].node_type() != NodeType::NAME || elements[i].reg == 0) {
                    return FormatUnimplemented(node);
                }
                parts.push_back(fmt.Text("."));
                parts.push_back(elements[i].reg);
            }
            return fmt.Concat(std::move(parts));
        }
        case AttributeKey::SQL_ROW_EXPRESSION_VALUES: {
            auto values = GetArrayStates(node);
            std::vector<FmtReg> parts;
            parts.reserve(values.size());
            for (auto& value : values) {
                if (value.reg == 0) return FormatUnimplemented(node);
                parts.push_back(value.reg);
            }
            return fmt.Join(parts, fmt.Text(", "), fmt.Concat({fmt.Text(","), fmt.Break()}),
                            FormattingJoinPolicy::BreakOnOverflow, true);
        }
        case AttributeKey::SQL_WINDOW_FRAME_BOUNDS: {
            auto bounds = GetArrayStates(node);
            if (bounds.size() == 1 && bounds.front().reg != 0) return bounds.front().reg;
            if (bounds.size() == 2 && bounds.front().reg != 0 && bounds.back().reg != 0) {
                return fmt.Concat({fmt.Text("between "), bounds.front().reg, fmt.Text(" and "), bounds.back().reg});
            }
            return FormatUnimplemented(node);
        }
        case AttributeKey::SQL_SELECT_VALUES: {
            auto rows = GetArrayStates(node);
            std::vector<FmtReg> parts;
            parts.reserve(rows.size());
            for (auto& row : rows) {
                if (row.reg == 0) return FormatUnimplemented(node);
                parts.push_back(row.reg);
            }
            auto policy = config.mode == buffers::formatting::FormattingMode::PRETTY
                              ? FormattingJoinPolicy::ForceBreak
                              : FormattingJoinPolicy::BreakOnOverflow;
            bool indent_after_breaks = config.mode != buffers::formatting::FormattingMode::PRETTY;
            return fmt.Join(parts, fmt.Text(", "), fmt.Concat({fmt.Text(","), fmt.Break()}), policy,
                            indent_after_breaks);
        }
        case AttributeKey::SQL_TEMP_NAME:
        case AttributeKey::SQL_CREATE_TABLE_NAME:
        case AttributeKey::SQL_FUNCTION_NAME:
        case AttributeKey::SQL_CONST_CAST_FUNC_NAME:
        case AttributeKey::SQL_COLUMN_CONSTRAINT_COLLATE:
        case AttributeKey::SQL_TABLEREF_NAME:
        case AttributeKey::SQL_PARAMETER_NAME:
        case AttributeKey::SQL_TABLE_CONSTRAINT_REFERENCES_NAME:
        case AttributeKey::SQL_COLUMN_REF_PATH:
        case AttributeKey::SQL_CREATE_AS_NAME:
        case AttributeKey::SQL_VIEW_NAME:
        case AttributeKey::SQL_CREATE_FUNCTION_NAME:
        case AttributeKey::SQL_DROP_NAME:
        case AttributeKey::EXT_VARARG_FIELD_KEY:
        case AttributeKey::SQL_GRAPH_TABLE_GRAPH:
            return FormatQualifiedName(node);
        case AttributeKey::SQL_SELECT_DISTINCT:
        case AttributeKey::SQL_SELECT_WITH_CTES:
        case AttributeKey::SQL_COMBINE_INPUT:
        case AttributeKey::SQL_JOIN_INPUT:
        case AttributeKey::SQL_TABLE_CONSTRAINT_COLUMNS:
        case AttributeKey::SQL_TABLE_CONSTRAINT_REFERENCES_COLUMNS:
        case AttributeKey::SQL_JOIN_USING:
        case AttributeKey::SQL_FUNCTION_TRIM_INPUT:
        case AttributeKey::SQL_ALIAS_COLUMN_NAMES:
        case AttributeKey::SQL_ALIAS_COLUMN_DEFS:
        case AttributeKey::EXT_VARARG_ARRAY_VALUES:
            return FormatCommaList(node);
        default:
            return FormatUnimplemented(node);
    }
}

FmtReg Formatter::FormatTableRef(const buffers::parser::Node& node) {
    auto [name, alias, table, lateral, sample, only] =
        GetAttributes<AttributeKey::SQL_TABLEREF_NAME, AttributeKey::SQL_TABLEREF_ALIAS,
                      AttributeKey::SQL_TABLEREF_TABLE, AttributeKey::SQL_TABLEREF_LATERAL,
                       AttributeKey::SQL_TABLEREF_SAMPLE, AttributeKey::SQL_TABLEREF_ONLY>(node);

    FmtReg base_reg = 0;
    if (table) {
        base_reg = Reg(*table);
        if (table->node_type() == NodeType::OBJECT_SQL_SELECT) {
            base_reg = fmt.Parenthesized(base_reg);
        }
    } else if (name) {
        base_reg = Reg(*name);
    }
    if (base_reg == 0) return FormatUnimplemented(node);

    if (only && only->node_type() == NodeType::BOOL && only->children_begin_or_value() != 0) {
        base_reg = fmt.Concat({fmt.Text("only "), base_reg});
    }

    if (lateral && lateral->node_type() == NodeType::BOOL && lateral->children_begin_or_value() != 0) {
        base_reg = fmt.Concat({fmt.Text("lateral "), base_reg});
    }

    if (alias) {
        auto alias_reg = Reg(*alias);
        if (alias_reg == 0) return FormatUnimplemented(node);
        base_reg = fmt.Concat({base_reg, fmt.Text(" "), alias_reg});
    }
    if (sample) {
        auto sample_reg = Reg(*sample);
        if (sample_reg == 0) return FormatUnimplemented(node);
        base_reg = fmt.Concat({base_reg, fmt.Text(" "), sample_reg});
    }
    return base_reg;
}

FmtReg Formatter::FormatInto(const buffers::parser::Node& node) {
    auto [temp, name] = GetAttributes<AttributeKey::SQL_TEMP_TYPE, AttributeKey::SQL_TEMP_NAME>(node);
    if (!name) return FormatUnimplemented(node);

    std::vector<FmtReg> parts{fmt.Text("into ")};
    if (temp) {
        auto type = static_cast<buffers::parser::TempType>(temp->children_begin_or_value());
        if (type != buffers::parser::TempType::NONE) {
            parts.push_back(Reg(*temp));
            parts.push_back(fmt.Text(" "));
        }
    }
    parts.push_back(Reg(*name));
    return fmt.Concat(std::move(parts));
}

FmtReg Formatter::FormatWindowDef(const buffers::parser::Node& node) {
    auto [name, frame] =
        GetAttributes<AttributeKey::SQL_WINDOW_DEF_NAME, AttributeKey::SQL_WINDOW_DEF_FRAME>(node);
    if (!name || !frame) return FormatUnimplemented(node);
    return fmt.Concat({Reg(*name), fmt.Text(" as "), fmt.Parenthesized(Reg(*frame))});
}

FmtReg Formatter::FormatRowLockingStrength(const buffers::parser::Node& node) {
    switch (static_cast<RowLockingStrength>(node.children_begin_or_value())) {
        case RowLockingStrength::UPDATE:
            return fmt.Text("for update");
        case RowLockingStrength::NO_KEY_UPDATE:
            return fmt.Text("for no key update");
        case RowLockingStrength::SHARE:
            return fmt.Text("for share");
        case RowLockingStrength::KEY_SHARE:
            return fmt.Text("for key share");
        case RowLockingStrength::READ_ONLY:
            return fmt.Text("for read only");
    }
    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatRowLockingBlockBehavior(const buffers::parser::Node& node) {
    switch (static_cast<RowLockingBlockBehavior>(node.children_begin_or_value())) {
        case RowLockingBlockBehavior::NOWAIT:
            return fmt.Text("nowait");
        case RowLockingBlockBehavior::SKIP_LOCKED:
            return fmt.Text("skip locked");
    }
    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatRowLocking(const buffers::parser::Node& node) {
    auto [strength, of, behavior] =
        GetAttributes<AttributeKey::SQL_ROW_LOCKING_STRENGTH, AttributeKey::SQL_ROW_LOCKING_OF,
                      AttributeKey::SQL_ROW_LOCKING_BLOCK_BEHAVIOR>(node);
    if (!strength) return FormatUnimplemented(node);

    std::vector<FmtReg> parts{Reg(*strength)};
    if (of && of->children_count() > 0) {
        parts.push_back(fmt.Text(" of "));
        parts.push_back(Reg(*of));
    }
    if (behavior) {
        parts.push_back(fmt.Text(" "));
        parts.push_back(Reg(*behavior));
    }
    return fmt.Concat(std::move(parts));
}

FmtReg Formatter::FormatSampleUnit(const buffers::parser::Node& node) {
    switch (static_cast<SampleCountUnit>(node.children_begin_or_value())) {
        case SampleCountUnit::PERCENT:
            return fmt.Text("%");
        case SampleCountUnit::ROWS:
            return fmt.Text(" rows");
    }
    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatSample(const buffers::parser::Node& node, bool table_sample) {
    auto [value, unit, function, repeat, seed] =
        GetAttributes<AttributeKey::SQL_SAMPLE_COUNT_VALUE, AttributeKey::SQL_SAMPLE_COUNT_UNIT,
                      AttributeKey::SQL_SAMPLE_FUNCTION, AttributeKey::SQL_SAMPLE_REPEAT,
                      AttributeKey::SQL_SAMPLE_SEED>(node);
    if (!value || !unit) return FormatUnimplemented(node);

    auto count = fmt.Concat({Reg(*value), Reg(*unit)});
    FmtReg body = count;
    if (function && seed) {
        body = fmt.Concat({count, fmt.Text(" "), fmt.Parenthesized(
                                                       fmt.Concat({Reg(*function), fmt.Text(", "), Reg(*seed)}))});
    } else if (function) {
        body = fmt.Concat({Reg(*function), fmt.Parenthesized(count)});
    }
    if (repeat) {
        body = fmt.Concat({body, fmt.Text(" repeatable "), fmt.Parenthesized(Reg(*repeat))});
    }
    return fmt.Concat({fmt.Text(table_sample ? "tablesample " : "using sample "), body});
}

FmtReg Formatter::FormatJoinedTable(const buffers::parser::Node& node) {
    using JoinType = buffers::parser::JoinType;
    auto [inputs, join_type, join_on, join_using] =
        GetAttributes<AttributeKey::SQL_JOIN_INPUT, AttributeKey::SQL_JOIN_TYPE, AttributeKey::SQL_JOIN_ON,
                      AttributeKey::SQL_JOIN_USING>(node);
    if (!inputs || !join_type || inputs->node_type() != NodeType::ARRAY || inputs->children_count() != 2) {
        return FormatUnimplemented(node);
    }

    auto left_reg = Reg(ast[inputs->children_begin_or_value()]);
    auto right_reg = Reg(ast[inputs->children_begin_or_value() + 1]);
    if (left_reg == 0 || right_reg == 0) return FormatUnimplemented(node);

    auto jt = static_cast<JoinType>(join_type->children_begin_or_value());
    std::string_view join_text;
    switch (jt) {
        case JoinType::NONE:
            join_text = "cross join";
            break;
        case JoinType::INNER:
            join_text = "join";
            break;
        case JoinType::LEFT:
        case JoinType::OUTER_LEFT:
            join_text = "left join";
            break;
        case JoinType::RIGHT:
        case JoinType::OUTER_RIGHT:
            join_text = "right join";
            break;
        case JoinType::FULL:
        case JoinType::OUTER_FULL:
            join_text = "full join";
            break;
        case JoinType::SEMI:
            join_text = "semi join";
            break;
        case JoinType::ANTI:
            join_text = "anti join";
            break;
        case JoinType::NATURAL_INNER:
            join_text = "natural join";
            break;
        case JoinType::NATURAL_LEFT:
        case JoinType::NATURAL_OUTER_LEFT:
            join_text = "natural left join";
            break;
        case JoinType::NATURAL_RIGHT:
        case JoinType::NATURAL_OUTER_RIGHT:
            join_text = "natural right join";
            break;
        case JoinType::NATURAL_FULL:
        case JoinType::NATURAL_OUTER_FULL:
            join_text = "natural full join";
            break;
        default:
            return FormatUnimplemented(node);
    }

    std::vector<FmtReg> join_clause_parts;
    join_clause_parts.reserve(3);
    join_clause_parts.push_back(fmt.Concat({fmt.Text(join_text), fmt.Text(" "), right_reg}));

    if (join_on) {
        auto on_reg = Reg(*join_on);
        if (on_reg == 0) return FormatUnimplemented(node);
        join_clause_parts.push_back(fmt.Concat({fmt.Text("on "), on_reg}));
    } else if (join_using) {
        auto using_reg = Reg(*join_using);
        if (using_reg == 0) return FormatUnimplemented(node);
        join_clause_parts.push_back(fmt.Concat({fmt.Text("using "), fmt.Parenthesized(using_reg)}));
    }

    auto join_clause =
        fmt.Join(join_clause_parts, fmt.Text(" "), fmt.Break(), FormattingJoinPolicy::BreakOnOverflow, true);

    std::vector<FmtReg> parts;
    parts.reserve(2);
    parts.push_back(left_reg);
    parts.push_back(join_clause);

    auto clause_policy = config.mode == buffers::formatting::FormattingMode::PRETTY
                              ? FormattingJoinPolicy::ForceBreak
                              : FormattingJoinPolicy::BreakAllOrNone;

    bool is_left_nested_join = false;
    size_t table_ref_id = node.parent();
    if (table_ref_id < ast.size()) {
        size_t parent_id = ast[table_ref_id].parent();
        is_left_nested_join = parent_id < ast.size() && ast[parent_id].node_type() == NodeType::ARRAY &&
                              ast[parent_id].attribute_key() == AttributeKey::SQL_JOIN_INPUT &&
                              table_ref_id == ast[parent_id].children_begin_or_value();
    }
    return fmt.Join(parts, fmt.Text(" "), fmt.Break(), clause_policy, !is_left_nested_join);
}

FmtReg Formatter::FormatGroupByItem(const buffers::parser::Node& node) {
    auto [type, arg] = GetAttributes<AttributeKey::SQL_GROUP_BY_ITEM_TYPE, AttributeKey::SQL_GROUP_BY_ITEM_ARG>(node);
    if (!type || type->node_type() != NodeType::ENUM_SQL_GROUP_BY_ITEM_TYPE) {
        return fmt.Empty();
    }

    auto arg_reg = [&]() -> FmtReg {
        if (!arg || arg->node_type() == NodeType::NONE) return 0;
        return Reg(*arg);
    };

    auto item_type = static_cast<GroupByItemType>(type->children_begin_or_value());
    switch (item_type) {
        case GroupByItemType::EXPRESSION:
            if (auto reg = arg_reg()) return reg;
            return fmt.Empty();
        case GroupByItemType::EMPTY:
            return fmt.Text("()");
        case GroupByItemType::CUBE:
            if (auto reg = arg_reg()) return fmt.Concat({fmt.Text("cube"), fmt.Parenthesized(reg)});
            return fmt.Empty();
        case GroupByItemType::ROLLUP:
            if (auto reg = arg_reg()) return fmt.Concat({fmt.Text("rollup"), fmt.Parenthesized(reg)});
            return fmt.Empty();
        case GroupByItemType::GROUPING_SETS:
            if (auto reg = arg_reg()) return fmt.Concat({fmt.Text("grouping sets"), fmt.Parenthesized(reg)});
            return fmt.Empty();
    }

    return fmt.Empty();
}

FmtReg Formatter::FormatTypeName(const buffers::parser::Node& node) {
    auto [type, array, setof] = GetAttributes<AttributeKey::SQL_TYPENAME_TYPE, AttributeKey::SQL_TYPENAME_ARRAY,
                                              AttributeKey::SQL_TYPENAME_SETOF>(node);
    if (!type) return FormatUnimplemented(node);

    FmtReg type_reg = Reg(*type);
    if (array && array->node_type() == NodeType::ARRAY) {
        // Hyper does not accept row(...)[], only array(row(...))
        bool row_element = type->node_type() == NodeType::OBJECT_SQL_ROW_TYPE;
        auto begin = array->children_begin_or_value();
        for (size_t i = 0; i < array->children_count(); ++i) {
            const auto& bound = ast[begin + i];
            if (config.dialect == buffers::formatting::FormattingDialect::TRINO) {
                if (bound.node_type() != NodeType::BOOL) return FormatUnimplemented(node);
                type_reg = fmt.Concat({fmt.Text("array("), type_reg, fmt.Text(")")});
            } else if (row_element && bound.node_type() == NodeType::BOOL) {
                type_reg = fmt.Concat({fmt.Text("array("), type_reg, fmt.Text(")")});
            } else {
                type_reg = fmt.Concat({type_reg, fmt.Text("["),
                                       bound.node_type() == NodeType::BOOL ? fmt.Empty() : Reg(bound), fmt.Text("]")});
            }
        }
    }

    std::vector<FmtReg> parts;
    parts.reserve(2);
    if (setof && setof->node_type() == NodeType::BOOL && setof->children_begin_or_value() != 0) {
        parts.push_back(fmt.Text("setof "));
    }
    parts.push_back(type_reg);

    return fmt.Concat(std::move(parts));
}

FmtReg Formatter::FormatIntervalTypeEnum(const buffers::parser::Node& node) {
    if (node.node_type() != NodeType::ENUM_SQL_INTERVAL_TYPE) {
        return FormatUnimplemented(node);
    }

    auto value = static_cast<IntervalType>(node.children_begin_or_value());
    switch (value) {
        case IntervalType::YEAR:
            return fmt.Text("year");
        case IntervalType::MONTH:
            return fmt.Text("month");
        case IntervalType::DAY:
            return fmt.Text("day");
        case IntervalType::HOUR:
            return fmt.Text("hour");
        case IntervalType::MINUTE:
            return fmt.Text("minute");
        case IntervalType::SECOND:
        case IntervalType::INTERVAL_SECOND:
            return fmt.Text("second");
        case IntervalType::YEAR_TO_MONTH:
            return fmt.Text("year to month");
        case IntervalType::DAY_TO_HOUR:
            return fmt.Text("day to hour");
        case IntervalType::DAY_TO_MINUTE:
            return fmt.Text("day to minute");
        case IntervalType::DAY_TO_SECOND:
            return fmt.Text("day to second");
        case IntervalType::HOUR_TO_MINUTE:
            return fmt.Text("hour to minute");
        case IntervalType::HOUR_TO_SECOND:
            return fmt.Text("hour to second");
        case IntervalType::MINUTE_TO_SECOND:
            return fmt.Text("minute to second");
    }

    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatIntervalType(const buffers::parser::Node& node) {
    auto [type, precision] = GetAttributes<AttributeKey::SQL_INTERVAL_TYPE, AttributeKey::SQL_INTERVAL_PRECISION>(node);
    if (!type) return FormatUnimplemented(node);

    std::vector<FmtReg> parts;
    parts.reserve(2);
    parts.push_back(Reg(*type));
    if (precision) {
        parts.push_back(fmt.Parenthesized(Reg(*precision)));
    }
    return fmt.Concat(std::move(parts));
}

FmtReg Formatter::FormatConstTypeCast(const buffers::parser::Node& node) {
    auto [type, value] =
        GetAttributes<AttributeKey::SQL_CONST_CAST_TYPE, AttributeKey::SQL_CONST_CAST_VALUE>(node);
    if (!type || !value) return FormatUnimplemented(node);

    auto type_reg = Reg(*type);
    auto value_reg = Reg(*value);
    if (type_reg == 0 || value_reg == 0) return FormatUnimplemented(node);
    return fmt.Concat({type_reg, fmt.Text(" "), value_reg});
}

FmtReg Formatter::FormatConstIntervalCast(const buffers::parser::Node& node) {
    auto [value, interval] =
        GetAttributes<AttributeKey::SQL_CONST_CAST_VALUE, AttributeKey::SQL_CONST_CAST_INTERVAL>(node);
    if (!value) return FormatUnimplemented(node);

    std::vector<FmtReg> parts;
    parts.reserve(4);
    parts.push_back(fmt.Text("interval "));
    parts.push_back(Reg(*value));
    if (interval) {
        parts.push_back(fmt.Text(" "));
        parts.push_back(Reg(*interval));
    }
    return fmt.Concat(std::move(parts));
}

FmtReg Formatter::FormatConstFunctionCast(const buffers::parser::Node& node) {
    auto [name, args, order, value] =
        GetAttributes<AttributeKey::SQL_CONST_CAST_FUNC_NAME, AttributeKey::SQL_CONST_CAST_FUNC_ARGS_LIST,
                      AttributeKey::SQL_CONST_CAST_FUNC_ARGS_ORDER, AttributeKey::SQL_CONST_CAST_VALUE>(node);
    if (!name || !value) return FormatUnimplemented(node);

    auto name_reg = Reg(*name);
    auto value_reg = Reg(*value);
    if (name_reg == 0 || value_reg == 0) return FormatUnimplemented(node);

    std::vector<FmtReg> call_parts;
    call_parts.reserve(3);
    std::vector<FmtReg> arg_items;
    if (args) {
        if (args->node_type() != NodeType::ARRAY) return FormatUnimplemented(node);
        arg_items.reserve(args->children_count());
        auto begin = args->children_begin_or_value();
        for (size_t i = 0; i < args->children_count(); ++i) {
            auto reg = Reg(ast[begin + i]);
            if (reg == 0) return FormatUnimplemented(node);
            arg_items.push_back(reg);
        }
    }

    if (!arg_items.empty()) {
        call_parts.push_back(fmt.Join(arg_items, fmt.Text(", "), fmt.Concat({fmt.Text(","), fmt.Break()}),
                                      FormattingJoinPolicy::BreakOnOverflow, true));
    }

    if (order) {
        auto order_reg = Reg(*order);
        if (order_reg == 0) return FormatUnimplemented(node);
        if (!call_parts.empty()) {
            call_parts.push_back(fmt.Text(" order by "));
        } else {
            call_parts.push_back(fmt.Text("order by "));
        }
        call_parts.push_back(order_reg);
    }

    FmtReg call_reg = name_reg;
    if (!call_parts.empty()) {
        auto call_body = fmt.Concat(std::move(call_parts));
        if (call_body == 0) return FormatUnimplemented(node);
        call_reg = fmt.Concat({name_reg, fmt.Parenthesized(call_body)});
    }

    return fmt.Concat({call_reg, fmt.Text(" "), value_reg});
}

FmtReg Formatter::FormatNumericTypeBase(const buffers::parser::Node& node) {
    if (node.node_type() != NodeType::ENUM_SQL_NUMERIC_TYPE) return FormatUnimplemented(node);

    auto value = static_cast<NumericType>(node.children_begin_or_value());
    switch (value) {
        case NumericType::INT1:
            return fmt.Text("tinyint");
        case NumericType::INT2:
            return fmt.Text("smallint");
        case NumericType::INT4:
            return fmt.Text("integer");
        case NumericType::INT8:
            return fmt.Text("bigint");
        case NumericType::FLOAT4:
            return fmt.Text("real");
        case NumericType::FLOAT8:
            return fmt.Text("double precision");
        case NumericType::NUMERIC:
            return fmt.Text("numeric");
        case NumericType::BOOL:
            return fmt.Text("boolean");
    }

    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatNumericType(const buffers::parser::Node& node) {
    auto [base, modifiers] =
        GetAttributes<AttributeKey::SQL_NUMERIC_TYPE_BASE, AttributeKey::SQL_NUMERIC_TYPE_MODIFIERS>(node);
    if (!base) return FormatUnimplemented(node);

    std::vector<FmtReg> parts;
    parts.reserve(2);
    parts.push_back(Reg(*base));

    if (modifiers && modifiers->node_type() == NodeType::ARRAY && modifiers->children_count() > 0) {
        std::vector<FmtReg> values;
        values.reserve(modifiers->children_count());
        auto begin = modifiers->children_begin_or_value();
        for (size_t i = 0; i < modifiers->children_count(); ++i) {
            values.push_back(Reg(ast[begin + i]));
        }
        auto joined = fmt.Join(values, fmt.Text(", "), fmt.Concat({fmt.Text(","), fmt.Break()}), std::nullopt, true);
        parts.push_back(fmt.Parenthesized(joined));
    }

    return fmt.Concat(std::move(parts));
}

FmtReg Formatter::FormatCharacterTypeBase(const buffers::parser::Node& node) {
    if (node.node_type() != NodeType::ENUM_SQL_CHARACTER_TYPE) return FormatUnimplemented(node);

    auto value = static_cast<CharacterType>(node.children_begin_or_value());
    switch (value) {
        case CharacterType::VARCHAR:
            return fmt.Text("varchar");
        case CharacterType::BLANK_PADDED_CHAR:
            return fmt.Text("char");
    }

    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatCharacterType(const buffers::parser::Node& node) {
    auto [type, length] =
        GetAttributes<AttributeKey::SQL_CHARACTER_TYPE, AttributeKey::SQL_CHARACTER_TYPE_LENGTH>(node);
    if (!type) return FormatUnimplemented(node);

    std::vector<FmtReg> parts;
    parts.reserve(2);
    parts.push_back(Reg(*type));
    if (length) {
        parts.push_back(fmt.Parenthesized(Reg(*length)));
    }
    return fmt.Concat(std::move(parts));
}

FmtReg Formatter::FormatGenericType(const buffers::parser::Node& node) {
    auto [name, modifiers] =
        GetAttributes<AttributeKey::SQL_GENERIC_TYPE_NAME, AttributeKey::SQL_GENERIC_TYPE_MODIFIERS>(node);
    if (!name) return FormatUnimplemented(node);

    auto name_text = scanned.ReadTextAtSymbolSpan(name->symbol_span());
    if (name_text.size() == 5 && std::equal(name_text.begin(), name_text.end(), "array",
                                           [](unsigned char a, unsigned char b) { return std::tolower(a) == b; }) &&
        modifiers &&
        modifiers->node_type() == NodeType::ARRAY && modifiers->children_count() == 1) {
        const auto& element_node = ast[modifiers->children_begin_or_value()];
        auto element = Reg(element_node);
        // Hyper does not accept row(...)[], only array(row(...))
        auto [element_type] = GetAttributes<AttributeKey::SQL_TYPENAME_TYPE>(element_node);
        bool row_element = element_type && element_type->node_type() == NodeType::OBJECT_SQL_ROW_TYPE;
        if (config.dialect == buffers::formatting::FormattingDialect::HYPER && !row_element) {
            return fmt.Concat({element, fmt.Text("[]")});
        }
        return fmt.Concat({fmt.Text("array("), element, fmt.Text(")")});
    }

    std::vector<FmtReg> parts;
    parts.reserve(2);
    parts.push_back(Reg(*name));
    if (modifiers && modifiers->node_type() == NodeType::ARRAY && modifiers->children_count() > 0) {
        std::vector<FmtReg> values;
        values.reserve(modifiers->children_count());
        auto begin = modifiers->children_begin_or_value();
        for (size_t i = 0; i < modifiers->children_count(); ++i) {
            values.push_back(Reg(ast[begin + i]));
        }
        auto joined = fmt.Join(values, fmt.Text(", "), fmt.Concat({fmt.Text(","), fmt.Break()}), std::nullopt, true);
        parts.push_back(fmt.Parenthesized(joined));
    }
    return fmt.Concat(std::move(parts));
}

FmtReg Formatter::FormatTimestampType(const buffers::parser::Node& node) {
    auto [precision, with_tz] =
        GetAttributes<AttributeKey::SQL_TIME_TYPE_PRECISION, AttributeKey::SQL_TIME_TYPE_WITH_TIMEZONE>(node);
    bool is_time = (node.node_type() == NodeType::OBJECT_SQL_TIME_TYPE);
    std::vector<FmtReg> parts;
    parts.reserve(4);
    parts.push_back(fmt.Text(is_time ? "time" : "timestamp"));
    if (precision) {
        parts.push_back(fmt.Parenthesized(Reg(*precision)));
    }
    if (with_tz && with_tz->node_type() == NodeType::BOOL && with_tz->children_begin_or_value() != 0) {
        parts.push_back(fmt.Text(" with time zone"));
    }
    return fmt.Concat(std::move(parts));
}

FmtReg Formatter::FormatOrder(const buffers::parser::Node& node) {
    auto [value, direction, nullrule] = GetAttributes<AttributeKey::SQL_ORDER_VALUE, AttributeKey::SQL_ORDER_DIRECTION,
                                                      AttributeKey::SQL_ORDER_NULLRULE>(node);
    if (!value) return FormatUnimplemented(node);

    std::vector<FmtReg> parts;
    parts.reserve(3);
    parts.push_back(Reg(*value));

    if (direction) parts.push_back(Reg(*direction));

    if (nullrule) parts.push_back(Reg(*nullrule));

    return fmt.Join(parts, fmt.Text(" "), fmt.Break(), FormattingJoinPolicy::BreakAllOrNone, true);
}

FmtReg Formatter::FormatOrderDirection(const buffers::parser::Node& node) {
    if (node.node_type() != NodeType::ENUM_SQL_ORDER_DIRECTION) {
        return FormatUnimplemented(node);
    }

    auto dir = static_cast<OrderDirection>(node.children_begin_or_value());
    switch (dir) {
        case OrderDirection::ASCENDING:
            return fmt.Text("asc");
        case OrderDirection::DESCENDING:
            return fmt.Text("desc");
    }

    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatOrderNullRule(const buffers::parser::Node& node) {
    if (node.node_type() != NodeType::ENUM_SQL_ORDER_NULL_RULE) {
        return FormatUnimplemented(node);
    }

    auto rule = static_cast<OrderNullRule>(node.children_begin_or_value());
    switch (rule) {
        case OrderNullRule::NULLS_FIRST:
            return fmt.Text("nulls first");
        case OrderNullRule::NULLS_LAST:
            return fmt.Text("nulls last");
    }

    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatExtractTarget(const buffers::parser::Node& node) {
    if (node.node_type() != NodeType::ENUM_SQL_EXTRACT_TARGET) return FormatUnimplemented(node);
    auto value = static_cast<ExtractTarget>(node.children_begin_or_value());
    switch (value) {
        case ExtractTarget::YEAR:
            return fmt.Text("year");
        case ExtractTarget::MONTH:
            return fmt.Text("month");
        case ExtractTarget::DAY:
            return fmt.Text("day");
        case ExtractTarget::HOUR:
            return fmt.Text("hour");
        case ExtractTarget::MINUTE:
            return fmt.Text("minute");
        case ExtractTarget::SECOND:
            return fmt.Text("second");
    }
    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatTrimDirection(const buffers::parser::Node& node) {
    if (node.node_type() != NodeType::ENUM_SQL_TRIM_TARGET) return FormatUnimplemented(node);
    auto value = static_cast<TrimDirection>(node.children_begin_or_value());
    switch (value) {
        case TrimDirection::BOTH:
            return fmt.Text("both");
        case TrimDirection::LEADING:
            return fmt.Text("leading");
        case TrimDirection::TRAILING:
            return fmt.Text("trailing");
    }
    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatColumnRef(const buffers::parser::Node& node) {
    auto [path] = GetAttributes<AttributeKey::SQL_COLUMN_REF_PATH>(node);
    if (path) return Reg(*path);
    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatParameterRef(const buffers::parser::Node& node) {
    auto [prefix, name] =
        GetAttributes<AttributeKey::SQL_PARAMETER_PREFIX, AttributeKey::SQL_PARAMETER_NAME>(node);
    if (!prefix) return FormatUnimplemented(node);

    auto prefix_reg = Reg(*prefix);
    if (prefix_reg == 0) return FormatUnimplemented(node);
    // Positional parameters (?) have no name
    if (!name) return prefix_reg;
    auto name_reg = Reg(*name);
    if (name_reg == 0) return FormatUnimplemented(node);
    return fmt.Concat({prefix_reg, name_reg});
}

FmtReg Formatter::FormatRelationExpression(const buffers::parser::Node& node) {
    auto [name] = GetAttributes<AttributeKey::SQL_TABLEREF_NAME>(node);
    if (!name) return FormatUnimplemented(node);

    auto name_reg = Reg(*name);
    if (name_reg == 0) return FormatUnimplemented(node);
    return fmt.Concat({fmt.Text("table"), fmt.Parenthesized(name_reg)});
}

FmtReg Formatter::FormatDescriptor(const buffers::parser::Node& node) {
    auto [columns] = GetAttributes<AttributeKey::SQL_DESCRIPTOR_COLUMNS>(node);
    if (!columns) return FormatUnimplemented(node);

    auto columns_reg = Reg(*columns);
    if (columns_reg == 0) return FormatUnimplemented(node);
    return fmt.Concat({fmt.Text("descriptor"), fmt.Parenthesized(columns_reg)});
}

FmtReg Formatter::FormatIndirection(const buffers::parser::Node& node) {
    auto [value, path] = GetAttributes<AttributeKey::SQL_INDIRECTION_VALUE, AttributeKey::SQL_INDIRECTION_PATH>(node);
    if (!value || !path) return FormatUnimplemented(node);

    auto value_reg = Reg(*value);
    auto path_reg = Reg(*path);
    if (value_reg == 0 || path_reg == 0) return FormatUnimplemented(node);
    return fmt.Concat({fmt.Parenthesized(value_reg), path_reg});
}

FmtReg Formatter::FormatRowType(const buffers::parser::Node& node) {
    auto [fields] = GetAttributes<AttributeKey::SQL_ROW_TYPE_FIELDS>(node);
    if (!fields) return FormatUnimplemented(node);

    auto fields_reg = Reg(*fields);
    if (fields_reg == 0) return FormatUnimplemented(node);
    return fmt.Concat({fmt.Text("row"), fmt.Parenthesized(fields_reg)});
}

FmtReg Formatter::FormatRowExpression(const buffers::parser::Node& node) {
    auto [is_explicit, values] =
        GetAttributes<AttributeKey::SQL_ROW_EXPRESSION_EXPLICIT, AttributeKey::SQL_ROW_EXPRESSION_VALUES>(node);
    if (!values || values->node_type() != NodeType::ARRAY) return FormatUnimplemented(node);
    if (values->children_count() == 0) return fmt.Text("row()");

    auto values_reg = Reg(*values);
    if (values_reg == 0) return FormatUnimplemented(node);
    // (x) is just x, so a single value always needs the row keyword
    if (is_explicit || values->children_count() == 1) {
        return fmt.Concat({fmt.Text("row"), fmt.Parenthesized(values_reg)});
    }
    return fmt.Parenthesized(values_reg);
}

FmtReg Formatter::FormatColumnDef(const buffers::parser::Node& node) {
    auto [name, type, options, constraints] =
        GetAttributes<AttributeKey::SQL_COLUMN_DEF_NAME, AttributeKey::SQL_COLUMN_DEF_TYPE,
                      AttributeKey::SQL_COLUMN_DEF_OPTIONS, AttributeKey::SQL_COLUMN_DEF_CONSTRAINTS>(node);

    if (!name || !type) return FormatUnimplemented(node);

    auto reg_or_placeholder = [&](const buffers::parser::Node& child) -> FmtReg {
        auto reg = Reg(child);
        if (reg == 0) return FormatUnimplemented(child);
        return reg;
    };

    std::vector<FmtReg> parts;
    parts.reserve(6);
    parts.push_back(reg_or_placeholder(*name));
    parts.push_back(fmt.Text(" "));
    parts.push_back(reg_or_placeholder(*type));

    if (options) {
        if (options->node_type() != NodeType::ARRAY) {
            parts.push_back(fmt.Text(" "));
            parts.push_back(FormatUnimplemented(*options));
        } else if (options->children_count() > 0) {
            std::vector<FmtReg> option_parts;
            option_parts.reserve(options->children_count());
            auto begin = options->children_begin_or_value();
            for (size_t i = 0; i < options->children_count(); ++i) {
                option_parts.push_back(reg_or_placeholder(ast[begin + i]));
            }

            auto option_list = fmt.Join(option_parts, fmt.Text(", "), fmt.Concat({fmt.Text(","), fmt.Break()}),
                                        FormattingJoinPolicy::BreakOnOverflow, true);
            parts.push_back(fmt.Text(" options "));
            parts.push_back(fmt.Parenthesized(option_list));
        }
    }

    if (constraints) {
        if (constraints->node_type() != NodeType::ARRAY) {
            parts.push_back(fmt.Text(" "));
            parts.push_back(FormatUnimplemented(*constraints));
        } else if (constraints->children_count() > 0) {
            std::vector<FmtReg> constraint_parts;
            constraint_parts.reserve(constraints->children_count());
            auto begin = constraints->children_begin_or_value();
            for (size_t i = 0; i < constraints->children_count(); ++i) {
                constraint_parts.push_back(reg_or_placeholder(ast[begin + i]));
            }

            auto constraint_list =
                fmt.Join(constraint_parts, fmt.Text(" "), fmt.Break(), FormattingJoinPolicy::BreakOnOverflow, true);
            parts.push_back(fmt.Text(" "));
            parts.push_back(constraint_list);
        }
    }

    return fmt.Concat(std::move(parts));
}

FmtReg Formatter::FormatTableConstraintType(const buffers::parser::Node& node) {
    if (node.node_type() != NodeType::ENUM_SQL_TABLE_CONSTRAINT) {
        return FormatUnimplemented(node);
    }

    auto value = static_cast<TableConstraint>(node.children_begin_or_value());
    switch (value) {
        case TableConstraint::CHECK:
            return fmt.Text("check");
        case TableConstraint::UNIQUE:
            return fmt.Text("unique");
        case TableConstraint::PRIMARY_KEY:
            return fmt.Text("primary key");
        case TableConstraint::FOREIGN_KEY:
            return fmt.Text("foreign key");
    }

    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatKeyMatch(const buffers::parser::Node& node) {
    if (node.node_type() != NodeType::ENUM_SQL_KEY_MATCH) {
        return FormatUnimplemented(node);
    }

    auto value = static_cast<KeyMatch>(node.children_begin_or_value());
    switch (value) {
        case KeyMatch::FULL:
            return fmt.Text("match full");
        case KeyMatch::PARTIAL:
            return fmt.Text("match partial");
        case KeyMatch::SIMPLE:
            return fmt.Text("match simple");
    }

    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatKeyActionCommand(const buffers::parser::Node& node) {
    if (node.node_type() != NodeType::ENUM_SQL_KEY_ACTION_COMMAND) {
        return FormatUnimplemented(node);
    }

    auto value = static_cast<KeyActionCommand>(node.children_begin_or_value());
    switch (value) {
        case KeyActionCommand::NO_ACTION:
            return fmt.Text("no action");
        case KeyActionCommand::RESTRICT:
            return fmt.Text("restrict");
        case KeyActionCommand::CASCADE:
            return fmt.Text("cascade");
        case KeyActionCommand::SET_NULL:
            return fmt.Text("set null");
        case KeyActionCommand::SET_DEFAULT:
            return fmt.Text("set default");
    }

    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatKeyActionTrigger(const buffers::parser::Node& node) {
    if (node.node_type() != NodeType::ENUM_SQL_KEY_ACTION_TRIGGER) {
        return FormatUnimplemented(node);
    }

    auto value = static_cast<KeyActionTrigger>(node.children_begin_or_value());
    switch (value) {
        case KeyActionTrigger::UPDATE:
            return fmt.Text("on update");
        case KeyActionTrigger::DELETE:
            return fmt.Text("on delete");
    }

    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatKeyAction(const buffers::parser::Node& node) {
    auto [trigger, command] =
        GetAttributes<AttributeKey::SQL_KEY_ACTION_TRIGGER, AttributeKey::SQL_KEY_ACTION_COMMAND>(node);
    if (!trigger || !command) return FormatUnimplemented(node);
    std::vector<FmtReg> parts;
    parts.reserve(2);
    parts.push_back(Reg(*trigger));
    parts.push_back(Reg(*command));
    return fmt.Join(parts, fmt.Text(" "), fmt.Break(), FormattingJoinPolicy::BreakAllOrNone, true);
}

FmtReg Formatter::FormatTableConstraint(const buffers::parser::Node& node) {
    auto [constraint_type, constraint_name, constraint_argument, constraint_index, constraint_columns,
          constraint_references_name, constraint_references_columns, constraint_attributes, constraint_definition,
          constraint_key_actions, constraint_key_match] =
        GetAttributes<AttributeKey::SQL_TABLE_CONSTRAINT_TYPE, AttributeKey::SQL_TABLE_CONSTRAINT_NAME,
                      AttributeKey::SQL_TABLE_CONSTRAINT_ARGUMENT, AttributeKey::SQL_TABLE_CONSTRAINT_INDEX,
                      AttributeKey::SQL_TABLE_CONSTRAINT_COLUMNS, AttributeKey::SQL_TABLE_CONSTRAINT_REFERENCES_NAME,
                      AttributeKey::SQL_TABLE_CONSTRAINT_REFERENCES_COLUMNS,
                      AttributeKey::SQL_TABLE_CONSTRAINT_ATTRIBUTES, AttributeKey::SQL_TABLE_CONSTRAINT_DEFINITION,
                      AttributeKey::SQL_TABLE_CONSTRAINT_KEY_ACTIONS, AttributeKey::SQL_TABLE_CONSTRAINT_KEY_MATCH>(
            node);

    if (!constraint_type || constraint_type->node_type() != NodeType::ENUM_SQL_TABLE_CONSTRAINT) {
        return FormatUnimplemented(node);
    }

    auto reg_or_placeholder = [&](const buffers::parser::Node& child) -> FmtReg {
        auto reg = Reg(child);
        if (reg == 0) return FormatUnimplemented(child);
        return reg;
    };

    auto format_space_list = [&](const buffers::parser::Node& list) -> FmtReg {
        if (list.node_type() != NodeType::ARRAY) {
            return FormatUnimplemented(list);
        }
        if (list.children_count() == 0) {
            return fmt.Empty();
        }

        std::vector<FmtReg> parts;
        parts.reserve(list.children_count());
        auto begin = list.children_begin_or_value();
        for (size_t i = 0; i < list.children_count(); ++i) {
            parts.push_back(reg_or_placeholder(ast[begin + i]));
        }
        return fmt.Join(parts, fmt.Text(" "), fmt.Break(), FormattingJoinPolicy::BreakOnOverflow, true);
    };

    std::vector<FmtReg> parts;
    parts.reserve(16);

    if (constraint_name) {
        parts.push_back(fmt.Text("constraint "));
        parts.push_back(reg_or_placeholder(*constraint_name));
        parts.push_back(fmt.Text(" "));
    }

    auto ctype = static_cast<TableConstraint>(constraint_type->children_begin_or_value());
    parts.push_back(reg_or_placeholder(*constraint_type));

    switch (ctype) {
        case TableConstraint::CHECK:
            parts.push_back(fmt.Text(" "));
            parts.push_back(fmt.Parenthesized(constraint_argument ? reg_or_placeholder(*constraint_argument)
                                                                  : FormatUnimplemented(node)));
            break;
        case TableConstraint::UNIQUE:
        case TableConstraint::PRIMARY_KEY:
            if (constraint_index) {
                parts.push_back(fmt.Text(" using index "));
                parts.push_back(reg_or_placeholder(*constraint_index));
            } else {
                parts.push_back(fmt.Text(" "));
                parts.push_back(fmt.Parenthesized(constraint_columns ? reg_or_placeholder(*constraint_columns)
                                                                     : FormatUnimplemented(node)));
            }
            break;
        case TableConstraint::FOREIGN_KEY:
            parts.push_back(fmt.Text(" "));
            parts.push_back(fmt.Parenthesized(constraint_columns ? reg_or_placeholder(*constraint_columns)
                                                                 : FormatUnimplemented(node)));
            parts.push_back(fmt.Text(" references "));
            parts.push_back(constraint_references_name ? reg_or_placeholder(*constraint_references_name)
                                                       : FormatUnimplemented(node));
            if (constraint_references_columns && constraint_references_columns->node_type() == NodeType::ARRAY &&
                constraint_references_columns->children_count() > 0) {
                parts.push_back(fmt.Text(" "));
                parts.push_back(fmt.Parenthesized(reg_or_placeholder(*constraint_references_columns)));
            }
            break;
    }

    if (constraint_key_match) {
        parts.push_back(fmt.Text(" "));
        parts.push_back(reg_or_placeholder(*constraint_key_match));
    }

    if (constraint_key_actions) {
        auto actions = format_space_list(*constraint_key_actions);
        if (actions != 0) {
            parts.push_back(fmt.Text(" "));
            parts.push_back(actions);
        }
    }

    if (constraint_attributes) {
        auto attributes = format_space_list(*constraint_attributes);
        if (attributes != 0) {
            parts.push_back(fmt.Text(" "));
            parts.push_back(attributes);
        }
    }

    if (constraint_definition) {
        auto definition = reg_or_placeholder(*constraint_definition);
        if (definition != 0) {
            parts.push_back(fmt.Text(" with "));
            parts.push_back(fmt.Parenthesized(definition));
        }
    }

    return fmt.Concat(std::move(parts));
}

FmtReg Formatter::FormatColumnConstraintType(const buffers::parser::Node& node) {
    if (node.node_type() != NodeType::ENUM_SQL_COLUMN_CONSTRAINT) {
        return FormatUnimplemented(node);
    }

    auto value = static_cast<ColumnConstraint>(node.children_begin_or_value());
    switch (value) {
        case ColumnConstraint::NOT_NULL:
            return fmt.Text("not null");
        case ColumnConstraint::NULL_:
            return fmt.Text("null");
        case ColumnConstraint::UNIQUE:
            return fmt.Text("unique");
        case ColumnConstraint::PRIMARY_KEY:
            return fmt.Text("primary key");
        case ColumnConstraint::CHECK:
            return fmt.Text("check");
        case ColumnConstraint::DEFAULT:
            return fmt.Text("default");
        case ColumnConstraint::COLLATE:
            return fmt.Text("collate");
    }

    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatColumnConstraint(const buffers::parser::Node& node) {
    auto [constraint_type, constraint_name, constraint_value, constraint_no_inherit, constraint_definition,
          constraint_collate] =
        GetAttributes<AttributeKey::SQL_COLUMN_CONSTRAINT_TYPE, AttributeKey::SQL_COLUMN_CONSTRAINT_NAME,
                      AttributeKey::SQL_COLUMN_CONSTRAINT_VALUE, AttributeKey::SQL_COLUMN_CONSTRAINT_NO_INHERIT,
                      AttributeKey::SQL_COLUMN_CONSTRAINT_DEFINITION, AttributeKey::SQL_COLUMN_CONSTRAINT_COLLATE>(
            node);

    if (!constraint_type || constraint_type->node_type() != NodeType::ENUM_SQL_COLUMN_CONSTRAINT) {
        return FormatUnimplemented(node);
    }

    auto reg_or_placeholder = [&](const buffers::parser::Node& child) -> FmtReg {
        auto reg = Reg(child);
        if (reg == 0) return FormatUnimplemented(child);
        return reg;
    };

    std::vector<FmtReg> parts;
    parts.reserve(8);

    if (constraint_name) {
        parts.push_back(fmt.Text("constraint "));
        parts.push_back(reg_or_placeholder(*constraint_name));
        parts.push_back(fmt.Text(" "));
    }

    auto ctype = static_cast<ColumnConstraint>(constraint_type->children_begin_or_value());
    parts.push_back(reg_or_placeholder(*constraint_type));

    switch (ctype) {
        case ColumnConstraint::NOT_NULL:
        case ColumnConstraint::NULL_:
        case ColumnConstraint::UNIQUE:
        case ColumnConstraint::PRIMARY_KEY:
            break;
        case ColumnConstraint::CHECK:
            parts.push_back(fmt.Text(" "));
            parts.push_back(fmt.Parenthesized(constraint_value ? reg_or_placeholder(*constraint_value)
                                                               : FormatUnimplemented(node)));
            if (constraint_no_inherit && constraint_no_inherit->node_type() == NodeType::BOOL &&
                constraint_no_inherit->children_begin_or_value() != 0) {
                parts.push_back(fmt.Text(" no inherit"));
            }
            break;
        case ColumnConstraint::DEFAULT:
            parts.push_back(fmt.Text(" "));
            parts.push_back(constraint_value ? reg_or_placeholder(*constraint_value) : FormatUnimplemented(node));
            break;
        case ColumnConstraint::COLLATE:
            parts.push_back(fmt.Text(" "));
            parts.push_back(constraint_collate ? reg_or_placeholder(*constraint_collate) : FormatUnimplemented(node));
            break;
    }

    if (constraint_definition) {
        auto def_reg = reg_or_placeholder(*constraint_definition);
        if (def_reg != 0) {
            parts.push_back(fmt.Text(" with "));
            parts.push_back(fmt.Parenthesized(def_reg));
        }
    }

    return fmt.Concat(std::move(parts));
}

FmtReg Formatter::FormatConstraintAttribute(const buffers::parser::Node& node) {
    if (node.node_type() != NodeType::ENUM_SQL_CONSTRAINT_ATTRIBUTE) {
        return FormatUnimplemented(node);
    }

    auto value = static_cast<ConstraintAttribute>(node.children_begin_or_value());
    switch (value) {
        case ConstraintAttribute::DEFERRABLE:
            return fmt.Text("deferrable");
        case ConstraintAttribute::NOT_DEFERRABLE:
            return fmt.Text("not deferrable");
        case ConstraintAttribute::INITIALLY_DEFERRED:
            return fmt.Text("initially deferred");
        case ConstraintAttribute::INITIALLY_IMMEDIATE:
            return fmt.Text("initially immediate");
        case ConstraintAttribute::NOT_VALID:
            return fmt.Text("not valid");
        case ConstraintAttribute::NO_INHERIT:
            return fmt.Text("no inherit");
    }

    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatGenericOption(const buffers::parser::Node& node) {
    auto [key, value] =
        GetAttributes<AttributeKey::SQL_GENERIC_OPTION_KEY, AttributeKey::SQL_GENERIC_OPTION_VALUE>(node);
    if (!key) return FormatUnimplemented(node);
    auto key_reg = Reg(*key);
    if (!value || value->node_type() == NodeType::NONE) return key_reg;
    return fmt.Concat({key_reg, fmt.Text(" "), Reg(*value)});
}

FmtReg Formatter::FormatFunctionArg(const buffers::parser::Node& node) {
    auto [arg_name, arg_value] =
        GetAttributes<AttributeKey::SQL_FUNCTION_ARG_NAME, AttributeKey::SQL_FUNCTION_ARG_VALUE>(node);
    if (!arg_value) return FormatUnimplemented(node);

    auto value_reg = Reg(*arg_value);
    if (value_reg == 0) return FormatUnimplemented(node);

    if (!arg_name) return value_reg;
    auto name_reg = Reg(*arg_name);
    if (name_reg == 0) return FormatUnimplemented(node);
    return fmt.Concat({name_reg, fmt.Text(" => "), value_reg});
}

FmtReg Formatter::FormatFunctionExpression(const buffers::parser::Node& node) {
    auto [star, all, distinct, variadic, over, within_group, filter, name, args, order, cast_args, extract_args,
          overlay_args, position_args, substring_args, treat_args, trim_args] =
        GetAttributes<AttributeKey::SQL_FUNCTION_ARGUMENTS_STAR, AttributeKey::SQL_FUNCTION_ALL,
                      AttributeKey::SQL_FUNCTION_DISTINCT, AttributeKey::SQL_FUNCTION_VARIADIC,
                      AttributeKey::SQL_FUNCTION_OVER, AttributeKey::SQL_FUNCTION_WITHIN_GROUP,
                      AttributeKey::SQL_FUNCTION_FILTER, AttributeKey::SQL_FUNCTION_NAME,
                      AttributeKey::SQL_FUNCTION_ARGUMENTS, AttributeKey::SQL_FUNCTION_ORDER,
                      AttributeKey::SQL_FUNCTION_CAST_ARGS, AttributeKey::SQL_FUNCTION_EXTRACT_ARGS,
                      AttributeKey::SQL_FUNCTION_OVERLAY_ARGS, AttributeKey::SQL_FUNCTION_POSITION_ARGS,
                      AttributeKey::SQL_FUNCTION_SUBSTRING_ARGS, AttributeKey::SQL_FUNCTION_TREAT_ARGS,
                      AttributeKey::SQL_FUNCTION_TRIM_ARGS>(node);

    if (!name) return FormatUnimplemented(node);
    if (all && distinct) return FormatUnimplemented(node);

    if (cast_args || extract_args || overlay_args || position_args || substring_args || treat_args || trim_args) {
        FmtReg name_reg = 0;
        if (name->node_type() == NodeType::ENUM_SQL_KNOWN_FUNCTION) {
            auto name_text = GetKnownFunctionText(static_cast<KnownFunction>(name->children_begin_or_value()));
            if (name_text.empty()) return FormatUnimplemented(node);
            name_reg = fmt.Text(name_text);
        } else {
            return FormatUnimplemented(node);
        }
        if (name_reg == 0) return FormatUnimplemented(node);

        if (cast_args) {
            auto [cast_value, cast_type] =
                GetAttributes<AttributeKey::SQL_FUNCTION_CAST_VALUE, AttributeKey::SQL_FUNCTION_CAST_TYPE>(*cast_args);
            if (!cast_value || !cast_type) return FormatUnimplemented(node);
            auto value_reg = Reg(*cast_value);
            auto type_reg = Reg(*cast_type);
            if (value_reg == 0 || type_reg == 0) return FormatUnimplemented(node);
            return fmt.Concat({name_reg, fmt.Parenthesized(fmt.Concat({value_reg, fmt.Text(" as "), type_reg}))});
        }
        if (extract_args) {
            auto [extract_target, extract_input] =
                GetAttributes<AttributeKey::SQL_FUNCTION_EXTRACT_TARGET, AttributeKey::SQL_FUNCTION_EXTRACT_INPUT>(
                    *extract_args);
            if (!extract_target || !extract_input) return FormatUnimplemented(node);
            auto target_reg = Reg(*extract_target);
            auto input_reg = Reg(*extract_input);
            if (target_reg == 0 || input_reg == 0) return FormatUnimplemented(node);
            return fmt.Concat(
                {name_reg, fmt.Parenthesized(fmt.Concat({target_reg, fmt.Text(" from "), input_reg}))});
        }
        if (position_args) {
            auto [pos_search, pos_input] =
                GetAttributes<AttributeKey::SQL_FUNCTION_POSITION_SEARCH, AttributeKey::SQL_FUNCTION_POSITION_INPUT>(
                    *position_args);
            if (!pos_search || !pos_input) return FormatUnimplemented(node);
            auto search_reg = Reg(*pos_search);
            auto input_reg = Reg(*pos_input);
            if (search_reg == 0 || input_reg == 0) return FormatUnimplemented(node);
            return fmt.Concat(
                {name_reg, fmt.Parenthesized(fmt.Concat({search_reg, fmt.Text(" in "), input_reg}))});
        }
        if (substring_args) {
            auto [sub_input, sub_from, sub_for] =
                GetAttributes<AttributeKey::SQL_FUNCTION_SUBSTRING_INPUT, AttributeKey::SQL_FUNCTION_SUBSTRING_FROM,
                              AttributeKey::SQL_FUNCTION_SUBSTRING_FOR>(*substring_args);
            if (!sub_input || !sub_from) return FormatUnimplemented(node);
            auto input_reg = Reg(*sub_input);
            auto from_reg = Reg(*sub_from);
            if (input_reg == 0 || from_reg == 0) return FormatUnimplemented(node);
            std::vector<FmtReg> parts;
            parts.reserve(5);
            parts.push_back(input_reg);
            parts.push_back(fmt.Text(" from "));
            parts.push_back(from_reg);
            if (sub_for) {
                auto for_reg = Reg(*sub_for);
                if (for_reg == 0) return FormatUnimplemented(node);
                parts.push_back(fmt.Text(" for "));
                parts.push_back(for_reg);
            }
            return fmt.Concat({name_reg, fmt.Parenthesized(fmt.Concat(std::move(parts)))});
        }
        if (trim_args) {
            auto [trim_input, trim_dir, trim_chars] =
                GetAttributes<AttributeKey::SQL_FUNCTION_TRIM_INPUT, AttributeKey::SQL_FUNCTION_TRIM_DIRECTION,
                              AttributeKey::SQL_FUNCTION_TRIM_CHARACTERS>(*trim_args);
            if (!trim_input) return FormatUnimplemented(node);
            auto input_reg = Reg(*trim_input);
            if (input_reg == 0) return FormatUnimplemented(node);
            std::vector<FmtReg> parts;
            parts.reserve(6);
            if (trim_dir) {
                auto dir_reg = Reg(*trim_dir);
                if (dir_reg == 0) return FormatUnimplemented(node);
                parts.push_back(dir_reg);
                parts.push_back(fmt.Text(" "));
            }
            if (trim_chars) {
                auto chars_reg = Reg(*trim_chars);
                if (chars_reg == 0) return FormatUnimplemented(node);
                parts.push_back(chars_reg);
                parts.push_back(fmt.Text(" "));
            }
            if (trim_dir || trim_chars) {
                parts.push_back(fmt.Text("from "));
            }
            parts.push_back(input_reg);
            return fmt.Concat({name_reg, fmt.Parenthesized(fmt.Concat(std::move(parts)))});
        }
        if (overlay_args) {
            auto [ov_input, ov_placing, ov_from, ov_for] =
                GetAttributes<AttributeKey::SQL_FUNCTION_OVERLAY_INPUT, AttributeKey::SQL_FUNCTION_OVERLAY_PLACING,
                              AttributeKey::SQL_FUNCTION_OVERLAY_FROM, AttributeKey::SQL_FUNCTION_OVERLAY_FOR>(
                    *overlay_args);
            if (!ov_input || !ov_placing || !ov_from) return FormatUnimplemented(node);
            auto input_reg = Reg(*ov_input);
            auto placing_reg = Reg(*ov_placing);
            auto from_reg = Reg(*ov_from);
            if (input_reg == 0 || placing_reg == 0 || from_reg == 0) return FormatUnimplemented(node);
            std::vector<FmtReg> parts;
            parts.reserve(7);
            parts.push_back(input_reg);
            parts.push_back(fmt.Text(" placing "));
            parts.push_back(placing_reg);
            parts.push_back(fmt.Text(" from "));
            parts.push_back(from_reg);
            if (ov_for) {
                auto for_reg = Reg(*ov_for);
                if (for_reg == 0) return FormatUnimplemented(node);
                parts.push_back(fmt.Text(" for "));
                parts.push_back(for_reg);
            }
            return fmt.Concat({name_reg, fmt.Parenthesized(fmt.Concat(std::move(parts)))});
        }
        return FormatUnimplemented(node);
    }

    FmtReg name_reg = 0;
    if (name->node_type() == NodeType::ARRAY) {
        name_reg = Reg(*name);
    } else if (name->node_type() == NodeType::ENUM_SQL_KNOWN_FUNCTION) {
        auto name_text = GetKnownFunctionText(static_cast<KnownFunction>(name->children_begin_or_value()));
        if (name_text.empty()) return FormatUnimplemented(node);
        name_reg = fmt.Text(name_text);
    } else {
        return FormatUnimplemented(node);
    }
    if (name_reg == 0) return FormatUnimplemented(node);

    std::vector<FmtReg> call_parts;
    call_parts.reserve(4);

    if (star) {
        if (args || variadic || all || distinct || order) return FormatUnimplemented(node);
        call_parts.push_back(fmt.Text("*"));
    } else {
        std::vector<FmtReg> arg_items;
        if (args) {
            if (args->node_type() != NodeType::ARRAY) return FormatUnimplemented(node);
            arg_items.reserve(args->children_count());
            auto begin = args->children_begin_or_value();
            for (size_t i = 0; i < args->children_count(); ++i) {
                auto reg = Reg(ast[begin + i]);
                if (reg == 0) return FormatUnimplemented(node);
                arg_items.push_back(reg);
            }
        }

        if (variadic) {
            auto variadic_reg = Reg(*variadic);
            if (variadic_reg == 0) return FormatUnimplemented(node);
            arg_items.push_back(fmt.Concat({fmt.Text("variadic "), variadic_reg}));
        }

        if (all || distinct) {
            if (arg_items.empty()) return FormatUnimplemented(node);
            call_parts.push_back(all ? fmt.Text("all ") : fmt.Text("distinct "));
        }

        if (!arg_items.empty()) {
            call_parts.push_back(fmt.Join(arg_items, fmt.Text(", "), fmt.Concat({fmt.Text(","), fmt.Break()}),
                                          FormattingJoinPolicy::BreakOnOverflow, true));
        }
    }

    if (order) {
        auto order_reg = Reg(*order);
        if (order_reg == 0) return FormatUnimplemented(node);
        if (!call_parts.empty()) {
            call_parts.push_back(fmt.Text(" order by "));
        } else {
            call_parts.push_back(fmt.Text("order by "));
        }
        call_parts.push_back(order_reg);
    }

    auto call_body = fmt.Concat(std::move(call_parts));
    FmtReg result;
    if (call_body == 0) {
        if (name->node_type() == NodeType::ENUM_SQL_KNOWN_FUNCTION)
            result = name_reg;
        else
            result = fmt.Concat({name_reg, fmt.Text("()")});
    } else {
        result = fmt.Concat({name_reg, fmt.Parenthesized(call_body)});
    }

    if (filter) {
        auto filter_reg = Reg(*filter);
        if (filter_reg == 0) return FormatUnimplemented(node);
        result = fmt.Concat({result, fmt.Text(" filter "), fmt.Parenthesized(fmt.Concat({fmt.Text("where "), filter_reg}))});
    }
    if (within_group) {
        auto wg_reg = Reg(*within_group);
        if (wg_reg == 0) return FormatUnimplemented(node);
        result = fmt.Concat({result, fmt.Text(" within group "), fmt.Parenthesized(fmt.Concat({fmt.Text("order by "), wg_reg}))});
    }
    if (over) {
        auto over_reg = Reg(*over);
        if (over_reg == 0) {
            result = fmt.Concat({result, fmt.Text(" over ()")});
        } else {
            result = fmt.Concat({result, fmt.Text(" over "), fmt.Parenthesized(over_reg)});
        }
    }
    return result;
}

FmtReg Formatter::FormatFunctionTable(const buffers::parser::Node& node) {
    auto [func, rows_from, with_ordinality] =
        GetAttributes<AttributeKey::SQL_FUNCTION_TABLE_FUNCTION, AttributeKey::SQL_FUNCTION_TABLE_ROWS_FROM,
                      AttributeKey::SQL_FUNCTION_TABLE_WITH_ORDINALITY>(node);

    FmtReg base_reg = 0;
    if (func) {
        base_reg = Reg(*func);
    } else if (rows_from) {
        auto children = GetArrayStates(*rows_from);
        std::vector<FmtReg> items;
        items.reserve(children.size());
        for (auto& child : children) {
            if (child.reg == 0) return FormatUnimplemented(node);
            items.push_back(child.reg);
        }
        auto list = fmt.Join(items, fmt.Text(", "), fmt.Concat({fmt.Text(","), fmt.Break()}),
                             FormattingJoinPolicy::BreakOnOverflow, true);
        base_reg = fmt.Concat({fmt.Text("rows from "), fmt.Parenthesized(list)});
    }
    if (base_reg == 0) return FormatUnimplemented(node);

    if (with_ordinality && with_ordinality->node_type() == NodeType::BOOL &&
        with_ordinality->children_begin_or_value() != 0) {
        base_reg = fmt.Concat({base_reg, fmt.Text(" with ordinality")});
    }
    return base_reg;
}

FmtReg Formatter::FormatWindowFrame(const buffers::parser::Node& node) {
    auto [partition, order, mode, bounds, exclude, name] =
        GetAttributes<AttributeKey::SQL_WINDOW_FRAME_PARTITION, AttributeKey::SQL_WINDOW_FRAME_ORDER,
                      AttributeKey::SQL_WINDOW_FRAME_MODE, AttributeKey::SQL_WINDOW_FRAME_BOUNDS,
                      AttributeKey::SQL_WINDOW_FRAME_EXCLUDE, AttributeKey::SQL_WINDOW_FRAME_NAME>(node);

    if (exclude || (mode == nullptr) != (bounds == nullptr)) return FormatUnimplemented(node);

    std::vector<FmtReg> clauses;
    clauses.reserve(4);
    if (name) {
        auto name_reg = Reg(*name);
        if (name_reg == 0) return FormatUnimplemented(node);
        clauses.push_back(name_reg);
    }
    if (partition) {
        auto part_reg = Reg(*partition);
        if (part_reg == 0) return FormatUnimplemented(node);
        clauses.push_back(fmt.Concat({fmt.Text("partition by "), part_reg}));
    }
    if (order) {
        auto order_reg = Reg(*order);
        if (order_reg == 0) return FormatUnimplemented(node);
        clauses.push_back(fmt.Concat({fmt.Text("order by "), order_reg}));
    }
    if (mode) {
        auto mode_reg = Reg(*mode);
        auto bounds_reg = Reg(*bounds);
        if (mode_reg == 0 || bounds_reg == 0) return FormatUnimplemented(node);
        clauses.push_back(fmt.Concat({mode_reg, fmt.Text(" "), bounds_reg}));
    }
    if (clauses.empty()) return fmt.Empty();
    return fmt.Join(clauses, fmt.Text(" "), fmt.Break(), FormattingJoinPolicy::BreakOnOverflow, true);
}

FmtReg Formatter::FormatWindowBound(const buffers::parser::Node& node) {
    auto [mode, direction, value] =
        GetAttributes<AttributeKey::SQL_WINDOW_BOUND_MODE, AttributeKey::SQL_WINDOW_BOUND_DIRECTION,
                      AttributeKey::SQL_WINDOW_BOUND_VALUE>(node);
    if (!mode) return FormatUnimplemented(node);

    auto mode_value = static_cast<WindowBoundMode>(mode->children_begin_or_value());
    switch (mode_value) {
        case WindowBoundMode::UNBOUNDED:
            if (!direction || value) return FormatUnimplemented(node);
            return fmt.Concat({Reg(*mode), fmt.Text(" "), Reg(*direction)});
        case WindowBoundMode::CURRENT_ROW:
            if (direction || value) return FormatUnimplemented(node);
            return Reg(*mode);
        case WindowBoundMode::VALUE:
            if (!direction || !value) return FormatUnimplemented(node);
            return fmt.Concat({Reg(*value), fmt.Text(" "), Reg(*direction)});
    }
    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatWindowBoundMode(const buffers::parser::Node& node) {
    auto mode = static_cast<WindowBoundMode>(node.children_begin_or_value());
    switch (mode) {
        case WindowBoundMode::UNBOUNDED:
            return fmt.Text("unbounded");
        case WindowBoundMode::CURRENT_ROW:
            return fmt.Text("current row");
        case WindowBoundMode::VALUE:
            return fmt.Empty();
    }
    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatWindowBoundDirection(const buffers::parser::Node& node) {
    auto direction = static_cast<WindowBoundDirection>(node.children_begin_or_value());
    switch (direction) {
        case WindowBoundDirection::PRECEDING:
            return fmt.Text("preceding");
        case WindowBoundDirection::FOLLOWING:
            return fmt.Text("following");
    }
    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatWindowRangeMode(const buffers::parser::Node& node) {
    auto mode = static_cast<WindowRangeMode>(node.children_begin_or_value());
    switch (mode) {
        case WindowRangeMode::RANGE:
            return fmt.Text("range");
        case WindowRangeMode::ROWS:
            return fmt.Text("rows");
        case WindowRangeMode::GROUPS:
            return fmt.Text("groups");
    }
    return FormatUnimplemented(node);
}

FmtReg Formatter::FormatAlias(const buffers::parser::Node& node) {
    auto [name, col_names, col_defs] = GetAttributes<AttributeKey::SQL_ALIAS_NAME, AttributeKey::SQL_ALIAS_COLUMN_NAMES,
                                                     AttributeKey::SQL_ALIAS_COLUMN_DEFS>(node);
    if (!name) return FormatUnimplemented(node);
    auto name_reg = Reg(*name);
    if (name_reg == 0) return FormatUnimplemented(node);

    if (col_names && col_names->node_type() == NodeType::ARRAY && col_names->children_count() > 0) {
        auto cols = FormatCommaList(*col_names);
        return fmt.Concat({name_reg, fmt.Parenthesized(cols)});
    }
    if (col_defs && col_defs->node_type() == NodeType::ARRAY && col_defs->children_count() > 0) {
        auto cols = FormatCommaList(*col_defs);
        return fmt.Concat({name_reg, fmt.Parenthesized(cols)});
    }
    return name_reg;
}

FmtReg Formatter::FormatTypecastExpression(const buffers::parser::Node& node) {
    auto [value, type] = GetAttributes<AttributeKey::SQL_TYPECAST_VALUE, AttributeKey::SQL_TYPECAST_TYPE>(node);
    if (!value || !type) return FormatUnimplemented(node);
    auto value_reg = Reg(*value);
    auto type_reg = Reg(*type);
    if (value_reg == 0 || type_reg == 0) return FormatUnimplemented(node);
    if (value->node_type() == NodeType::OBJECT_SQL_NARY_EXPRESSION) {
        value_reg = fmt.Parenthesized(value_reg);
    }
    return fmt.Concat({value_reg, fmt.Text("::"), type_reg});
}

FmtReg Formatter::FormatCase(const buffers::parser::Node& node) {
    auto [argument, clauses, default_val] =
        GetAttributes<AttributeKey::SQL_CASE_ARGUMENT, AttributeKey::SQL_CASE_CLAUSES, AttributeKey::SQL_CASE_DEFAULT>(
            node);
    if (!clauses) return FormatUnimplemented(node);

    std::vector<FmtReg> parts;
    if (argument) {
        auto arg_reg = Reg(*argument);
        if (arg_reg == 0) return FormatUnimplemented(node);
        parts.push_back(fmt.Concat({fmt.Text("case "), arg_reg}));
    } else {
        parts.push_back(fmt.Text("case"));
    }

    auto clause_children = GetArrayStates(*clauses);
    for (auto& child : clause_children) {
        if (child.reg == 0) return FormatUnimplemented(node);
        parts.push_back(child.reg);
    }
    if (default_val) {
        auto default_reg = Reg(*default_val);
        if (default_reg == 0) return FormatUnimplemented(node);
        parts.push_back(fmt.Concat({fmt.Text("else "), default_reg}));
    }
    parts.push_back(fmt.Text("end"));

    if (config.mode == buffers::formatting::FormattingMode::PRETTY) {
        std::vector<FmtReg> body_parts(parts.begin() + 1, parts.end() - 1);
        body_parts.insert(body_parts.begin(), parts.front());
        auto body = fmt.Join(body_parts, fmt.Text(" "), fmt.Break(), FormattingJoinPolicy::ForceBreak, true);
        return fmt.Join(std::vector<FmtReg>{body, parts.back()}, fmt.Text(" "), fmt.Break(),
                        FormattingJoinPolicy::ForceBreak);
    }
    return fmt.Join(parts, fmt.Text(" "), fmt.Break(), FormattingJoinPolicy::BreakOnOverflow, true);
}

FmtReg Formatter::FormatCaseClause(const buffers::parser::Node& node) {
    auto [when_val, then_val] =
        GetAttributes<AttributeKey::SQL_CASE_CLAUSE_WHEN, AttributeKey::SQL_CASE_CLAUSE_THEN>(node);
    if (!when_val || !then_val) return FormatUnimplemented(node);
    auto when_reg = Reg(*when_val);
    auto then_reg = Reg(*then_val);
    if (when_reg == 0 || then_reg == 0) return FormatUnimplemented(node);
    return fmt.Concat({fmt.Text("when "), when_reg, fmt.Text(" then "), then_reg});
}

FmtReg Formatter::FormatExistsExpression(const buffers::parser::Node& node) {
    auto [statement] = GetAttributes<AttributeKey::SQL_EXISTS_EXPRESSION_STATEMENT>(node);
    if (!statement) return FormatUnimplemented(node);
    auto stmt_reg = Reg(*statement);
    if (stmt_reg == 0) return FormatUnimplemented(node);
    return fmt.Concat({fmt.Text("exists "), fmt.Parenthesized(stmt_reg)});
}

FmtReg Formatter::FormatCTE(const buffers::parser::Node& node) {
    auto [name, columns, statement, graph, secure, options] =
        GetAttributes<AttributeKey::SQL_CTE_NAME, AttributeKey::SQL_CTE_COLUMNS, AttributeKey::SQL_CTE_STATEMENT,
                      AttributeKey::SQL_CTE_PROPERTY_GRAPH, AttributeKey::SQL_CTE_SECURE,
                      AttributeKey::SQL_CTE_OPTIONS>(node);
    if (!name || (!statement && !graph)) return FormatUnimplemented(node);
    auto name_reg = Reg(*name);
    auto body_reg = statement ? Reg(*statement) : Reg(*graph);
    if (name_reg == 0 || body_reg == 0) return FormatUnimplemented(node);

    FmtReg body;
    if (graph && graph->children_count() == 0) {
        body = fmt.Text("()");
    } else if (config.mode == buffers::formatting::FormattingMode::PRETTY) {
        body = fmt.Concat(
            {fmt.Text("("), fmt.Indented(fmt.Concat({fmt.Break(), body_reg})), fmt.Break(), fmt.Text(")")});
    } else {
        body = fmt.Parenthesized(body_reg);
    }

    auto as_reg = graph ? fmt.Text(" as property graph ")
                        : (secure ? fmt.Text(" as secure ") : fmt.Text(" as "));
    FmtReg result;
    if (columns && columns->node_type() == NodeType::ARRAY && columns->children_count() > 0) {
        auto cols_reg = Reg(*columns);
        if (cols_reg == 0) return FormatUnimplemented(*columns);
        result = fmt.Concat({name_reg, fmt.Text(" "), fmt.Parenthesized(cols_reg), as_reg, body});
    } else {
        result = fmt.Concat({name_reg, as_reg, body});
    }
    if (options) {
        auto options_reg = Reg(*options);
        if (options_reg == 0) return FormatUnimplemented(*options);
        result = fmt.Concat({result, fmt.Text(" options "), fmt.Parenthesized(options_reg)});
    }
    return result;
}

FmtReg Formatter::FormatExpressionOperatorType(const buffers::parser::Node& node) {
    if (node.node_type() != NodeType::ENUM_SQL_EXPRESSION_OPERATOR) {
        return FormatUnimplemented(node);
    }

    auto op = static_cast<ExpressionOperator>(node.children_begin_or_value());
    auto text = GetOperatorText(op);
    if (text.empty()) return FormatUnimplemented(node);
    return fmt.Text(text);
}

FmtReg Formatter::FormatResultTarget(const buffers::parser::Node& node) {
    auto [value, name, star, exclude] =
        GetAttributes<AttributeKey::SQL_RESULT_TARGET_VALUE, AttributeKey::SQL_RESULT_TARGET_NAME,
                      AttributeKey::SQL_RESULT_TARGET_STAR, AttributeKey::SQL_RESULT_TARGET_EXCLUDE>(node);
    if (star) {
        if (name) return FormatUnimplemented(node);
        if (star->node_type() != NodeType::BOOL || star->children_begin_or_value() == 0) {
            return FormatUnimplemented(*star);
        }
        FmtReg result = value ? fmt.Concat({Reg(*value), fmt.Text(".*")}) : fmt.Text("*");
        if (exclude) {
            auto exclude_reg = Reg(*exclude);
            if (exclude_reg == 0) return FormatUnimplemented(*exclude);
            result = exclude->children_count() == 1
                         ? fmt.Concat({result, fmt.Text(" exclude "), exclude_reg})
                         : fmt.Concat({result, fmt.Text(" exclude "), fmt.Parenthesized(exclude_reg)});
        }
        return result;
    }
    if (!value) return FormatUnimplemented(node);

    auto value_reg = Reg(*value);
    if (value_reg == 0) return FormatUnimplemented(*value);

    if (!name) return value_reg;
    auto name_reg = Reg(*name);
    if (name_reg == 0) return FormatUnimplemented(*name);
    return fmt.Concat({value_reg, fmt.Text(" as "), name_reg});
}

FmtReg Formatter::FormatSelectExpression(const buffers::parser::Node& node) {
    auto [statement, indirection] =
        GetAttributes<AttributeKey::SQL_SELECT_EXPRESSION_STATEMENT, AttributeKey::SQL_SELECT_EXPRESSION_INDIRECTION>(
            node);
    if (!statement) return FormatUnimplemented(node);
    if (indirection && indirection->node_type() == NodeType::ARRAY && indirection->children_count() > 0) {
        return FormatUnimplemented(node);
    }
    return fmt.Parenthesized(Reg(*statement));
}

FmtReg Formatter::FormatExpression(size_t node_id) {
    const auto& node = ast[node_id];
    const auto& state = node_states[node_id];

    auto [op_node, args_node] =
        GetAttributes<AttributeKey::SQL_EXPRESSION_OPERATOR, AttributeKey::SQL_EXPRESSION_ARGS>(node);
    if (op_node && op_node->node_type() == NodeType::ENUM_SQL_EXPRESSION_OPERATOR &&
        static_cast<ExpressionOperator>(op_node->children_begin_or_value()) == ExpressionOperator::DEFAULT &&
        !args_node) {
        bool in_insert_values = false;
        auto parent_id = node.parent();
        for (size_t depth = 0; parent_id < ast.size() && depth < ast.size(); ++depth) {
            const auto& parent = ast[parent_id];
            if (parent.attribute_key() == AttributeKey::SQL_INSERT_SOURCE) {
                auto [values] = GetAttributes<AttributeKey::SQL_SELECT_VALUES>(parent);
                in_insert_values = parent.node_type() == NodeType::OBJECT_SQL_SELECT &&
                                   values != nullptr;
                break;
            }
            if (parent.node_type() == NodeType::OBJECT_SQL_INSERT) break;
            auto next_parent = parent.parent();
            if (next_parent == parent_id) break;
            parent_id = next_parent;
        }
        if (!in_insert_values) return FormatUnimplemented(node);
        return Reg(*op_node);
    }
    if (!op_node || !args_node ||
        (op_node->node_type() != NodeType::ENUM_SQL_EXPRESSION_OPERATOR &&
         op_node->node_type() != NodeType::OPERATOR) ||
        args_node->node_type() != NodeType::ARRAY || args_node->children_count() == 0) {
        return FormatUnimplemented(node);
    }

    bool known_operator = op_node->node_type() == NodeType::ENUM_SQL_EXPRESSION_OPERATOR;
    auto op = known_operator ? static_cast<ExpressionOperator>(op_node->children_begin_or_value())
                             : ExpressionOperator::DEFAULT;
    auto op_reg = Reg(*op_node);
    if (op_reg == 0) return FormatUnimplemented(node);

    std::vector<FmtReg> args;
    auto children = GetArrayStates(*args_node);
    args.reserve(children.size());
    for (auto& child : children) {
        args.push_back(child.reg);
    }
    if (!known_operator && args.size() != 2) return FormatUnimplemented(node);

    FmtReg reg = fmt.Empty();

    if (args.size() == 1 && known_operator) {
        switch (op) {
            case ExpressionOperator::NEGATE:
                reg = fmt.Concat({op_reg, args.front()});
                break;
            case ExpressionOperator::NOT:
                reg = fmt.Concat({op_reg, fmt.Text(" "), args.front()});
                break;
            case ExpressionOperator::IS_NULL:
            case ExpressionOperator::NOT_NULL:
            case ExpressionOperator::IS_TRUE:
            case ExpressionOperator::IS_FALSE:
            case ExpressionOperator::IS_UNKNOWN:
            case ExpressionOperator::IS_NOT_TRUE:
            case ExpressionOperator::IS_NOT_FALSE:
            case ExpressionOperator::IS_NOT_UNKNOWN:
                reg = fmt.Concat({args.front(), fmt.Text(" "), op_reg});
                break;
            default:
                reg = fmt.Concat({op_reg, fmt.Text(" "), args.front()});
                break;
        }
    } else if (args.size() == 3 && known_operator && (op == ExpressionOperator::BETWEEN_ASYMMETRIC ||
                                     op == ExpressionOperator::NOT_BETWEEN_ASYMMETRIC ||
                                     op == ExpressionOperator::BETWEEN_SYMMETRIC ||
                                     op == ExpressionOperator::NOT_BETWEEN_SYMMETRIC)) {
        reg = fmt.Concat({args[0], fmt.Text(" "), op_reg, fmt.Text(" "), args[1], fmt.Text(" and "), args[2]});
    } else if (args.size() == 2 && known_operator &&
               (op == ExpressionOperator::IN || op == ExpressionOperator::NOT_IN)) {
        auto rhs = args[1];
        auto& rhs_node = ast[args_node->children_begin_or_value() + 1];
        if (rhs_node.node_type() == NodeType::ARRAY) {
            auto list = FormatCommaList(rhs_node);
            rhs = fmt.Parenthesized(list);
        }
        reg = fmt.Concat({args[0], fmt.Text(" "), op_reg, fmt.Text(" "), rhs});
    } else if (args.size() == 2 && known_operator && (op == ExpressionOperator::IS_DISTINCT_FROM ||
                                     op == ExpressionOperator::IS_NOT_DISTINCT_FROM)) {
        reg = fmt.Concat({args[0], fmt.Text(" "), op_reg, fmt.Text(" "), args[1]});
    } else {
        bool is_boolean_chain = known_operator && (op == ExpressionOperator::AND || op == ExpressionOperator::OR);
        FmtReg inline_separator = fmt.Empty();
        FmtReg break_separator = fmt.Empty();
        switch (GetOperatorBreakPreference(op)) {
            case OperatorBreakPreference::BreakBefore:
                inline_separator = fmt.Concat({fmt.Text(" "), op_reg, fmt.Text(" ")});
                break_separator = fmt.Concat({fmt.Break(), op_reg, fmt.Text(" ")});
                break;
            case OperatorBreakPreference::BreakAfter:
                inline_separator = fmt.Concat({fmt.Text(" "), op_reg, fmt.Text(" ")});
                break_separator = fmt.Concat({fmt.Text(" "), op_reg, fmt.Break()});
                break;
        }
        reg = is_boolean_chain
                  ? fmt.Join(args, inline_separator, break_separator, std::nullopt, true)
                  : fmt.Join(args, inline_separator, break_separator, FormattingJoinPolicy::BreakOnOverflow, true);
    }

    if (state.needs_parentheses) {
        reg = fmt.Parenthesized(reg);
    }
    return reg;
}

FmtReg Formatter::FormatNode(size_t node_id) {
    const auto& node = ast[node_id];
    switch (node.node_type()) {
        case NodeType::ARRAY:
            return FormatArray(node);
        case NodeType::OBJECT_SQL_SELECT:
            return FormatSelect(node_id);
        case NodeType::OBJECT_SQL_INSERT:
            return FormatInsert(node);
        case NodeType::OBJECT_SQL_DELETE:
            return FormatDelete(node);
        case NodeType::OBJECT_SQL_CREATE:
            return FormatCreate(node_id);
        case NodeType::OBJECT_SQL_CREATE_AS:
            return FormatCreateAs(node);
        case NodeType::OBJECT_SQL_VIEW:
            return FormatView(node);
        case NodeType::OBJECT_SQL_CREATE_FUNCTION:
            return FormatCreateFunction(node);
        case NodeType::OBJECT_SQL_DROP_TABLE:
            return FormatDrop(node, true);
        case NodeType::OBJECT_SQL_DROP_VIEW:
            return FormatDrop(node, false);
        case NodeType::OBJECT_SQL_ATTACH_DATABASE:
            return FormatAttachDatabase(node);
        case NodeType::OBJECT_SQL_ATTACH_DATABASE_OPTION:
            return FormatAttachDatabaseOption(node);
        case NodeType::OBJECT_SQL_FUNCTION_PARAM:
            return FormatFunctionParam(node);
        case NodeType::OBJECT_EXT_SET:
            return FormatSet(node);
        case NodeType::OBJECT_EXT_VARARG_FIELD:
            return FormatVarargField(node);
        case NodeType::OBJECT_EXT_EXPLAIN:
            return FormatExplain(node_id);
        case NodeType::OBJECT_EXT_EXPLAIN_EXPRESSIONS:
            return FormatExplainExpressions(node);
        case NodeType::OBJECT_SQL_TABLEREF:
            return FormatTableRef(node);
        case NodeType::OBJECT_SQL_JOINED_TABLE:
            return FormatJoinedTable(node);
        case NodeType::ENUM_SQL_JOIN_TYPE:
            return fmt.Empty();
        case NodeType::OBJECT_SQL_INTO:
            return FormatInto(node);
        case NodeType::OBJECT_SQL_WINDOW_DEF:
            return FormatWindowDef(node);
        case NodeType::OBJECT_SQL_ROW_LOCKING:
            return FormatRowLocking(node);
        case NodeType::ENUM_SQL_ROW_LOCKING_STRENGTH:
            return FormatRowLockingStrength(node);
        case NodeType::ENUM_SQL_ROW_LOCKING_BLOCK_BEHAVIOR:
            return FormatRowLockingBlockBehavior(node);
        case NodeType::OBJECT_SQL_SELECT_SAMPLE:
            return FormatSample(node, false);
        case NodeType::OBJECT_SQL_TABLEREF_SAMPLE:
            return FormatSample(node, true);
        case NodeType::ENUM_SQL_SAMPLE_UNIT_TYPE:
            return FormatSampleUnit(node);
        case NodeType::OBJECT_SQL_GROUP_BY_ITEM:
            return FormatGroupByItem(node);
        case NodeType::ENUM_SQL_GROUP_BY_ITEM_TYPE:
        case NodeType::ENUM_SQL_COMBINE_MODIFIER:
        case NodeType::ENUM_SQL_COMBINE_OPERATION:
            return fmt.Empty();
        case NodeType::OBJECT_SQL_ORDER:
            return FormatOrder(node);
        case NodeType::ENUM_SQL_ORDER_DIRECTION:
            return FormatOrderDirection(node);
        case NodeType::ENUM_SQL_ORDER_NULL_RULE:
            return FormatOrderNullRule(node);
        case NodeType::ENUM_SQL_TEMP_TYPE:
            return FormatTempType(node);
        case NodeType::ENUM_SQL_ON_COMMIT_OPTION:
            return FormatOnCommitOption(node);
        case NodeType::OBJECT_SQL_TYPENAME:
            return FormatTypeName(node);
        case NodeType::OBJECT_SQL_INTERVAL_TYPE:
            return FormatIntervalType(node);
        case NodeType::ENUM_SQL_INTERVAL_TYPE:
            return FormatIntervalTypeEnum(node);
        case NodeType::OBJECT_SQL_NUMERIC_TYPE:
            return FormatNumericType(node);
        case NodeType::ENUM_SQL_NUMERIC_TYPE:
            return FormatNumericTypeBase(node);
        case NodeType::OBJECT_SQL_CHARACTER_TYPE:
            return FormatCharacterType(node);
        case NodeType::ENUM_SQL_CHARACTER_TYPE:
            return FormatCharacterTypeBase(node);
        case NodeType::OBJECT_SQL_GENERIC_TYPE:
            return FormatGenericType(node);
        case NodeType::OBJECT_SQL_TIMESTAMP_TYPE:
        case NodeType::OBJECT_SQL_TIME_TYPE:
            return FormatTimestampType(node);
        case NodeType::OBJECT_SQL_COLUMN_REF:
            return FormatColumnRef(node);
        case NodeType::OBJECT_SQL_PARAMETER_REF:
            return FormatParameterRef(node);
        case NodeType::OBJECT_SQL_RELATION_EXPR:
            return FormatRelationExpression(node);
        case NodeType::OBJECT_SQL_DESCRIPTOR:
            return FormatDescriptor(node);
        case NodeType::OBJECT_SQL_INDIRECTION:
            return FormatIndirection(node);
        case NodeType::OBJECT_SQL_ROW_TYPE:
            return FormatRowType(node);
        case NodeType::OBJECT_SQL_ROW_EXPRESSION:
            return FormatRowExpression(node);
        case NodeType::OBJECT_SQL_SELECT_EXPRESSION:
            return FormatSelectExpression(node);
        case NodeType::OBJECT_SQL_RESULT_TARGET:
            return FormatResultTarget(node);
        case NodeType::OBJECT_SQL_COLUMN_DEF:
            return FormatColumnDef(node);
        case NodeType::ENUM_SQL_TABLE_CONSTRAINT:
            return FormatTableConstraintType(node);
        case NodeType::OBJECT_SQL_TABLE_CONSTRAINT:
            return FormatTableConstraint(node);
        case NodeType::ENUM_SQL_KEY_MATCH:
            return FormatKeyMatch(node);
        case NodeType::ENUM_SQL_KEY_ACTION_COMMAND:
            return FormatKeyActionCommand(node);
        case NodeType::ENUM_SQL_KEY_ACTION_TRIGGER:
            return FormatKeyActionTrigger(node);
        case NodeType::OBJECT_SQL_KEY_ACTION:
            return FormatKeyAction(node);
        case NodeType::ENUM_SQL_COLUMN_CONSTRAINT:
            return FormatColumnConstraintType(node);
        case NodeType::OBJECT_SQL_COLUMN_CONSTRAINT:
            return FormatColumnConstraint(node);
        case NodeType::ENUM_SQL_CONSTRAINT_ATTRIBUTE:
            return FormatConstraintAttribute(node);
        case NodeType::ENUM_SQL_EXTRACT_TARGET:
            return FormatExtractTarget(node);
        case NodeType::ENUM_SQL_TRIM_TARGET:
            return FormatTrimDirection(node);
        case NodeType::OBJECT_SQL_GENERIC_OPTION:
            return FormatGenericOption(node);
        case NodeType::OBJECT_SQL_ALIAS:
            return FormatAlias(node);
        case NodeType::OBJECT_SQL_TYPECAST_EXPRESSION:
            return FormatTypecastExpression(node);
        case NodeType::OBJECT_SQL_CASE:
            return FormatCase(node);
        case NodeType::OBJECT_SQL_CASE_CLAUSE:
            return FormatCaseClause(node);
        case NodeType::OBJECT_SQL_EXISTS_EXPRESSION:
            return FormatExistsExpression(node);
        case NodeType::OBJECT_SQL_CTE:
            return FormatCTE(node);
        case NodeType::OBJECT_SQL_PROPERTY_GRAPH:
            return FormatPropertyGraph(node);
        case NodeType::OBJECT_SQL_GRAPH_ELEMENT_TABLE:
            return FormatGraphElementTable(node);
        case NodeType::OBJECT_SQL_GRAPH_VERTEX_REFERENCE:
            return FormatGraphVertexReference(node);
        case NodeType::OBJECT_SQL_GRAPH_LABEL:
            return FormatGraphLabel(node);
        case NodeType::OBJECT_SQL_GRAPH_PROPERTIES:
            return FormatGraphProperties(node);
        case NodeType::OBJECT_SQL_GRAPH_PROPERTY:
            return FormatGraphProperty(node);
        case NodeType::OBJECT_SQL_GRAPH_TABLE:
            return FormatGraphTable(node);
        case NodeType::OBJECT_SQL_GRAPH_MATCH:
            return FormatGraphMatch(node);
        case NodeType::OBJECT_SQL_GRAPH_PATH_ELEMENT:
            return FormatGraphPathElement(node);
        case NodeType::OBJECT_SQL_GRAPH_QUANTIFIER:
            return FormatGraphQuantifier(node);
        case NodeType::OBJECT_SQL_GRAPH_LABEL_EXPRESSION:
            return FormatGraphLabelExpression(node);
        case NodeType::OBJECT_SQL_GRAPH_ROWS:
            return FormatGraphRows(node);
        case NodeType::OBJECT_SQL_FUNCTION_EXPRESSION:
            return FormatFunctionExpression(node);
        case NodeType::OBJECT_SQL_FUNCTION_CAST_ARGS:
        case NodeType::OBJECT_SQL_FUNCTION_EXTRACT_ARGS:
        case NodeType::OBJECT_SQL_FUNCTION_OVERLAY_ARGS:
        case NodeType::OBJECT_SQL_FUNCTION_POSITION_ARGS:
        case NodeType::OBJECT_SQL_FUNCTION_SUBSTRING_ARGS:
        case NodeType::OBJECT_SQL_FUNCTION_TREAT_ARGS:
        case NodeType::OBJECT_SQL_FUNCTION_TRIM_ARGS:
            return fmt.Empty();
        case NodeType::ENUM_SQL_KNOWN_FUNCTION:
            return fmt.Empty();
        case NodeType::OBJECT_SQL_FUNCTION_TABLE:
            return FormatFunctionTable(node);
        case NodeType::OBJECT_SQL_WINDOW_FRAME:
            return FormatWindowFrame(node);
        case NodeType::OBJECT_SQL_WINDOW_BOUND:
            return FormatWindowBound(node);
        case NodeType::ENUM_SQL_WINDOW_BOUND_MODE:
            return FormatWindowBoundMode(node);
        case NodeType::ENUM_SQL_WINDOW_BOUND_DIRECTION:
            return FormatWindowBoundDirection(node);
        case NodeType::ENUM_SQL_WINDOW_RANGE_MODE:
            return FormatWindowRangeMode(node);
        case NodeType::OBJECT_SQL_FUNCTION_ARG:
            return FormatFunctionArg(node);
        case NodeType::OBJECT_SQL_CONST_TYPE_CAST:
            return FormatConstTypeCast(node);
        case NodeType::OBJECT_SQL_CONST_INTERVAL_CAST:
            return FormatConstIntervalCast(node);
        case NodeType::OBJECT_SQL_CONST_FUNCTION_CAST:
            return FormatConstFunctionCast(node);
        case NodeType::ENUM_SQL_EXPRESSION_OPERATOR:
            return FormatExpressionOperatorType(node);
        case NodeType::OBJECT_SQL_NARY_EXPRESSION:
            return FormatExpression(node_id);
        case NodeType::OBJECT_VIS_VISUALISE:
            return FormatVisualize(node_id);
        case NodeType::OBJECT_VIS_SPEC:
        case NodeType::OBJECT_VIS_UMAP_SPEC:
        case NodeType::OBJECT_VIS_MARKDOWN_SPEC:
        case NodeType::OBJECT_VIS_TABLE_SPEC:
        case NodeType::OBJECT_VIS_DASHBOARD_SPEC:
        case NodeType::OBJECT_VIS_MARK:
        case NodeType::OBJECT_VIS_ENCODING:
        case NodeType::OBJECT_VIS_FIELD_DEF:
        case NodeType::OBJECT_VIS_SCALE:
        case NodeType::OBJECT_VIS_AXIS:
        case NodeType::OBJECT_VIS_LEGEND:
            return FormatVisPropertyList(node);
        case NodeType::ENUM_VIS_MARK_TYPE:
        case NodeType::ENUM_VIS_FIELD_TYPE:
        case NodeType::ENUM_VIS_SCALE_TYPE:
        case NodeType::ENUM_VIS_ENCODING_CHANNEL:
            return FormatVisEnum(node);
        case NodeType::OBJECT_EXT_VARARG_ARRAY:
            return FormatVarargArray(node);
        case NodeType::LITERAL_NULL:
        case NodeType::LITERAL_INTEGER:
        case NodeType::LITERAL_FLOAT:
        case NodeType::LITERAL_STRING:
        case NodeType::LITERAL_INTERVAL:
        case NodeType::BOOL:
        case NodeType::OPERATOR:
        case NodeType::NAME:
            return FormatLeaf(node);
        default:
            return FormatUnimplemented(node);
    }
}

void Formatter::BuildDocs() {
    for (size_t node_id = 0; node_id < ast.size(); ++node_id) {
        node_states[node_id].reg = FormatNode(node_id);
    }
}

std::string Formatter::WriteOutput() const {
    FormattingRenderOptions options{
        .max_width = config.max_width,
        .indentation_width = config.indentation_width,
        .debug_mode = config.debug_mode,
        .mode = config.mode,
        .keyword_case = config.keyword_case,
    };

    std::string output;
    output.reserve(EstimateFormattedSize());

    if (config.debug_mode) {
        output += "/* indentation=";
        output += std::to_string(config.indentation_width);
        output += ", max_width=";
        output += std::to_string(config.max_width);
        output += " */\n";
    }

    if (config.mode == buffers::formatting::FormattingMode::INLINE) {
        for (size_t i = 0; i < parsed.statements.size(); ++i) {
            const auto& statement = parsed.statements[i];
            output += fmt.Render(node_states[statement.root].reg, options);
            output += ';';
            if (i + 1 < parsed.statements.size()) output += "\n\n";
        }
        return output;
    }

    auto input = scanned.GetInput();
    auto comments = std::span<const buffers::parser::TextSpan>{scanned.comments};
    auto descriptions = parsed.AssociateDescriptions();
    size_t comment_begin = 0;
    for (size_t i = 0; i < parsed.statements.size(); ++i) {
        if (i > 0) {
            if (!output.empty() && output.back() != '\n') output += '\n';
            output += '\n';
        }
        const auto& statement = parsed.statements[i];
        const auto& description = descriptions[i];
        auto root_span = scanned.ResolveTextSpan(ast[statement.root].symbol_span());
        size_t before_end = comment_begin;
        while (before_end < comments.size() && comments[before_end].offset() < root_span.offset()) ++before_end;
        if (description.description_count > 0 && description.description_begin >= comment_begin) {
            size_t leading_begin = description.description_begin;
            size_t leading_end = leading_begin + description.description_count;
            AppendComments(output, input, comments.subspan(comment_begin, leading_begin - comment_begin),
                           config.max_width, comments[leading_begin].offset());
            AppendComments(output, input, comments.subspan(leading_begin, leading_end - leading_begin),
                           config.max_width, root_span.offset());
        } else {
            AppendComments(output, input, comments.subspan(comment_begin, before_end - comment_begin),
                           config.max_width, root_span.offset());
        }

        if (!output.empty() && output.back() != '\n') output += '\n';
        output += fmt.Render(node_states[statement.root].reg, options);
        output += ';';

        size_t statement_end = description.source_span.offset() + description.source_span.length();
        size_t within_end = before_end;
        while (within_end < comments.size() && comments[within_end].offset() < statement_end) ++within_end;
        AppendComments(output, input, comments.subspan(before_end, within_end - before_end), config.max_width);
        comment_begin = within_end;
    }
    AppendComments(output, input, comments.subspan(comment_begin), config.max_width);
    return output;
}

std::string Formatter::Format(const buffers::formatting::FormattingConfigT& config) {
    this->config = config;
    fmt.Reset();
    fmt.SetConfig(config);
    node_states.assign(ast.size(), {});
    unformattable_nodes.clear();
    for (const auto& statement : parsed.statements) {
        if (statement.root < node_states.size()) {
            node_states[statement.root].is_statement_root = true;
            MarkExplainInnerStatementRoot(statement.root);
        }
    }

    PreparePrecedence();

    for (size_t i = 0; i < ast.size(); ++i) {
        IdentifyParentheses(ast.size() - 1 - i);
    }

    BuildDocs();

    return WriteOutput();
}

std::string Formatter::FormatNodeAt(size_t node_id, const buffers::formatting::FormattingConfigT& config) {
    if (node_id >= ast.size()) return {};
    this->config = config;
    fmt.Reset();
    fmt.SetConfig(config);
    node_states.assign(ast.size(), {});
    unformattable_nodes.clear();
    PreparePrecedence();
    for (size_t i = 0; i < ast.size(); ++i) {
        IdentifyParentheses(ast.size() - 1 - i);
    }
    BuildDocs();
    return Render(node_states[node_id].reg);
}

std::string Formatter::Render(FmtReg reg) const {
    FormattingRenderOptions options{
        .max_width = config.max_width,
        .indentation_width = config.indentation_width,
        .debug_mode = config.debug_mode,
        .mode = config.mode,
        .keyword_case = config.keyword_case,
    };
    return fmt.Render(reg, options);
}

bool Formatter::IsFullyFormatted() const { return unformattable_nodes.empty(); }

}  // namespace dashql
