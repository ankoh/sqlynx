#pragma once

#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "dashql/buffers/index_generated.h"

namespace dashql {
namespace parser {

/// The prefix of DashQL comment tags, e.g. `-- @dashql:description`
constexpr std::string_view COMMENT_TAG_PREFIX = "@dashql:";
/// The tag that closes a tagged region of line comments
constexpr std::string_view COMMENT_TAG_END = "end";

/// The comments of a script grouped into blocks
struct CommentBlocks {
    /// The blocks in script order
    std::vector<buffers::parser::CommentBlock> blocks;
    /// The content lines of all blocks, referenced by CommentBlock::lines_begin
    std::vector<buffers::parser::TextSpan> lines;
    /// Malformed comment tags
    std::vector<std::pair<buffers::parser::TextSpan, std::string>> warnings;
};

/// Group comments into blocks.
///
/// A block is either a single block comment or a run of line comments that start their own lines on consecutive
/// lines. A trailing line comment (`select 1; -- note`) is a block of its own.
/// A run of line comments is split around tagged regions that open with `-- @dashql:<tag>` and close with
/// `-- @dashql:end`. A block comment is tagged if its first text is `@dashql:<tag>`, the comment end closes it.
/// The content lines omit comment markers, block comment gutters (` * `), tag lines and leading or trailing empty
/// lines. Text following the opening tag on the same line is content.
CommentBlocks GroupComments(std::string_view text, std::span<const buffers::parser::TextSpan> comments);

}  // namespace parser
}  // namespace dashql
