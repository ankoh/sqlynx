#include "dashql/parser/comment_blocks.h"

#include <algorithm>
#include <optional>

#include "rapidjson/document.h"

namespace dashql {
namespace parser {

using CommentBlock = buffers::parser::CommentBlock;
using CommentBlockType = buffers::parser::CommentBlockType;
using TextSpan = buffers::parser::TextSpan;

namespace {

/// Whitespace within a line
bool IsHorizontalSpace(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\f' || c == '\v'; }

/// A byte range [begin, end) in the script text
struct Range {
    size_t begin;
    size_t end;

    bool empty() const { return begin >= end; }
    TextSpan Span() const {
        return TextSpan(static_cast<uint32_t>(begin), static_cast<uint32_t>(end > begin ? end - begin : 0));
    }
};

/// Trim horizontal whitespace on both sides
Range Trim(std::string_view text, Range r) {
    while (r.begin < r.end && IsHorizontalSpace(text[r.begin])) ++r.begin;
    while (r.end > r.begin && IsHorizontalSpace(text[r.end - 1])) --r.end;
    return r;
}

/// A comment tag at the start of a line
struct Tag {
    /// The tag name
    Range name;
    /// The text following the tag on the same line
    Range rest;
};

/// Read a tag from trimmed line content
std::optional<Tag> ReadTag(std::string_view text, Range line) {
    if (text.substr(line.begin, line.end - line.begin).substr(0, COMMENT_TAG_PREFIX.size()) != COMMENT_TAG_PREFIX) {
        return std::nullopt;
    }
    size_t name_begin = line.begin + COMMENT_TAG_PREFIX.size();
    size_t name_end = name_begin;
    while (name_end < line.end) {
        char c = text[name_end];
        bool name_char = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
        if (!name_char) break;
        ++name_end;
    }
    // The tag name must be followed by whitespace or the end of the line
    if (name_end == name_begin || (name_end < line.end && !IsHorizontalSpace(text[name_end]))) {
        return std::nullopt;
    }
    return Tag{.name = {name_begin, name_end}, .rest = Trim(text, {name_end, line.end})};
}

/// Resolve the block type of a tag
CommentBlockType ResolveTagType(std::string_view name) {
    if (name == "description") return CommentBlockType::DASHQL_DESCRIPTION;
    if (name == "metadata") return CommentBlockType::DASHQL_METADATA;
    return CommentBlockType::DASHQL_UNKNOWN_TAG;
}

/// Is a comment the first text on its line?
bool StartsLine(std::string_view text, size_t offset) {
    while (offset > 0 && IsHorizontalSpace(text[offset - 1])) --offset;
    return offset == 0 || text[offset - 1] == '\n';
}

/// Is the gap between two line comments only whitespace with a single line break?
bool IsContiguousGap(std::string_view text, size_t begin, size_t end) {
    size_t line_breaks = 0;
    for (size_t i = begin; i < end; ++i) {
        if (text[i] == '\n') {
            ++line_breaks;
        } else if (!IsHorizontalSpace(text[i])) {
            return false;
        }
    }
    return line_breaks <= 1;
}

/// Get the content of a line comment: everything after the dashes and a single space
Range LineCommentContent(std::string_view text, const TextSpan& comment) {
    size_t begin = comment.offset();
    size_t end = comment.offset() + comment.length();
    while (begin < end && text[begin] == '-') ++begin;
    if (begin < end && text[begin] == ' ') ++begin;
    while (end > begin && IsHorizontalSpace(text[end - 1])) --end;
    return {begin, end};
}

/// Get the content lines of a block comment without delimiters and gutters
std::vector<Range> BlockCommentLines(std::string_view text, const TextSpan& comment) {
    size_t begin = comment.offset();
    size_t end = comment.offset() + comment.length();
    // Strip `*/`, the scanner reports unterminated block comments as errors
    if (comment.length() >= 4 && text.substr(end - 2, 2) == "*/") end -= 2;
    // Strip `/*` and additional stars, as in `/**`
    begin = std::min(begin + 2, end);
    while (begin < end && text[begin] == '*') ++begin;
    while (end > begin && text[end - 1] == '*') --end;
    std::vector<Range> lines;
    size_t line_begin = begin;
    for (size_t i = begin; i <= end; ++i) {
        if (i < end && text[i] != '\n') continue;
        auto line = Trim(text, {line_begin, i});
        // Strip a ` * ` gutter
        if (!line.empty() && text[line.begin] == '*') {
            line = Trim(text, {line.begin + 1, line.end});
        }
        lines.push_back(line);
        line_begin = i + 1;
    }
    return lines;
}

class CommentGrouper {
    std::string_view text;
    std::span<const TextSpan> comments;
    CommentBlocks out;

   public:
    CommentGrouper(std::string_view text, std::span<const TextSpan> comments) : text(text), comments(comments) {}

    /// Emit a block, leading and trailing empty lines are dropped
    void Emit(CommentBlockType type, size_t comments_begin, size_t comments_end, Range tag,
              std::span<const Range> lines) {
        while (!lines.empty() && lines.front().empty()) lines = lines.subspan(1);
        while (!lines.empty() && lines.back().empty()) lines = lines.subspan(0, lines.size() - 1);
        auto& first = comments[comments_begin];
        auto& last = comments[comments_end - 1];
        auto block_begin = first.offset();
        auto block_end = last.offset() + last.length();
        out.blocks.emplace_back(type, TextSpan(block_begin, block_end - block_begin), tag.Span(),
                                static_cast<uint32_t>(comments_begin),
                                static_cast<uint32_t>(comments_end - comments_begin),
                                static_cast<uint32_t>(out.lines.size()), static_cast<uint32_t>(lines.size()));
        for (auto& line : lines) {
            out.lines.push_back(line.Span());
        }
    }

    /// Group a block comment
    void GroupBlockComment(size_t comment_id) {
        auto lines = BlockCommentLines(text, comments[comment_id]);
        // A tag must be the first text of the comment
        size_t first = 0;
        while (first < lines.size() && lines[first].empty()) ++first;
        std::optional<Tag> tag;
        if (first < lines.size()) {
            tag = ReadTag(text, lines[first]);
        }
        if (!tag.has_value()) {
            Emit(CommentBlockType::COMMENT, comment_id, comment_id + 1, {0, 0}, lines);
            return;
        }
        auto name = text.substr(tag->name.begin, tag->name.end - tag->name.begin);
        if (name == COMMENT_TAG_END) {
            out.warnings.emplace_back(comments[comment_id], "@dashql:end without an opening tag");
            Emit(CommentBlockType::COMMENT, comment_id, comment_id + 1, {0, 0}, lines);
            return;
        }
        auto type = ResolveTagType(name);
        if (type == CommentBlockType::DASHQL_UNKNOWN_TAG) {
            out.warnings.emplace_back(comments[comment_id], "unknown comment tag @dashql:" + std::string{name});
        }
        lines[first] = tag->rest;
        Emit(type, comment_id, comment_id + 1, tag->name, std::span<const Range>{lines}.subspan(first));
    }

    /// Group a run of line comments
    void GroupLineComments(size_t run_begin, size_t run_end) {
        std::vector<Range> lines;
        lines.reserve(run_end - run_begin);
        for (size_t i = run_begin; i < run_end; ++i) {
            lines.push_back(LineCommentContent(text, comments[i]));
        }
        // The comments of the run that are not yet emitted
        size_t pending = run_begin;
        size_t i = run_begin;
        while (i < run_end) {
            auto tag = ReadTag(text, Trim(text, lines[i - run_begin]));
            if (!tag.has_value()) {
                ++i;
                continue;
            }
            auto name = text.substr(tag->name.begin, tag->name.end - tag->name.begin);
            if (name == COMMENT_TAG_END) {
                out.warnings.emplace_back(comments[i], "@dashql:end without an opening tag");
                ++i;
                continue;
            }
            // Find the end of the region
            size_t close = i + 1;
            for (; close < run_end; ++close) {
                auto line = Trim(text, lines[close - run_begin]);
                auto end_tag = ReadTag(text, line);
                if (end_tag.has_value() && end_tag->rest.empty() &&
                    text.substr(end_tag->name.begin, end_tag->name.end - end_tag->name.begin) == COMMENT_TAG_END) {
                    break;
                }
            }
            if (close == run_end) {
                // An unterminated region stays an ordinary comment
                out.warnings.emplace_back(comments[i], "@dashql:" + std::string{name} +
                                                           " is not closed by a -- @dashql:end line");
                ++i;
                continue;
            }
            auto type = ResolveTagType(name);
            if (type == CommentBlockType::DASHQL_UNKNOWN_TAG) {
                out.warnings.emplace_back(comments[i], "unknown comment tag @dashql:" + std::string{name});
            }
            if (pending < i) {
                Emit(CommentBlockType::COMMENT, pending, i, {0, 0},
                     std::span<const Range>{lines}.subspan(pending - run_begin, i - pending));
            }
            std::vector<Range> content;
            content.reserve(close - i);
            content.push_back(tag->rest);
            for (size_t j = i + 1; j < close; ++j) {
                content.push_back(lines[j - run_begin]);
            }
            Emit(type, i, close + 1, tag->name, content);
            pending = close + 1;
            i = close + 1;
        }
        if (pending < run_end) {
            Emit(CommentBlockType::COMMENT, pending, run_end, {0, 0},
                 std::span<const Range>{lines}.subspan(pending - run_begin));
        }
    }

    /// Check the metadata blocks, the first one must contain a JSON object
    void ValidateMetadata() {
        bool seen = false;
        for (size_t i = 0; i < out.blocks.size(); ++i) {
            auto& block = out.blocks[i];
            if (block.block_type() != CommentBlockType::DASHQL_METADATA) continue;
            if (seen) {
                out.warnings.emplace_back(block.text_span(),
                                          "@dashql:metadata is ignored, a script has a single metadata block");
                continue;
            }
            seen = true;
            std::string json;
            for (uint32_t j = 0; j < block.lines_count(); ++j) {
                auto& line = out.lines[block.lines_begin() + j];
                if (j > 0) json += '\n';
                json += text.substr(line.offset(), line.length());
            }
            rapidjson::Document doc;
            doc.Parse(json.data(), json.size());
            if (doc.HasParseError()) {
                out.warnings.emplace_back(block.text_span(), "@dashql:metadata is not valid JSON");
            } else if (!doc.IsObject()) {
                out.warnings.emplace_back(block.text_span(), "@dashql:metadata must be a JSON object");
            } else {
                out.metadata_block = static_cast<uint32_t>(i);
            }
        }
    }

    /// Group all comments
    CommentBlocks Group() && {
        size_t i = 0;
        while (i < comments.size()) {
            auto& comment = comments[i];
            bool is_line = comment.length() >= 2 && text.substr(comment.offset(), 2) == "--";
            if (!is_line) {
                GroupBlockComment(i++);
                continue;
            }
            // A trailing line comment is a block of its own
            size_t run_end = i + 1;
            if (StartsLine(text, comment.offset())) {
                while (run_end < comments.size()) {
                    auto& prev = comments[run_end - 1];
                    auto& next = comments[run_end];
                    bool next_is_line = next.length() >= 2 && text.substr(next.offset(), 2) == "--";
                    if (!next_is_line || !IsContiguousGap(text, prev.offset() + prev.length(), next.offset()) ||
                        !StartsLine(text, next.offset())) {
                        break;
                    }
                    ++run_end;
                }
            }
            GroupLineComments(i, run_end);
            i = run_end;
        }
        ValidateMetadata();
        return std::move(out);
    }
};

}  // namespace

CommentBlocks GroupComments(std::string_view text, std::span<const TextSpan> comments) {
    return CommentGrouper{text, comments}.Group();
}

}  // namespace parser
}  // namespace dashql
