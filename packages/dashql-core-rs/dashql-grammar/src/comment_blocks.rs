//! Grouping comments into blocks, a port of `packages/dashql-core/src/parser/comment_blocks.cc`.
//!
//! A block is either a single block comment or a run of line comments that start their own lines on
//! consecutive lines. A trailing line comment (`select 1; -- note`) is a block of its own. A run of
//! line comments is split around tagged regions that open with `-- @dashql:<tag>` and close with
//! `-- @dashql:end`. A block comment is tagged if its first text is `@dashql:<tag>`, the comment end
//! closes it. The content lines omit comment markers, block comment gutters (` * `), tag lines and
//! leading or trailing empty lines. Text following the opening tag on the same line is content. The
//! content of the first `@dashql:metadata` block must be a JSON object, further metadata blocks are
//! ignored.

use crate::span::TextSpan;
pub use dashql_buffers::parser::CommentBlockType;

/// The prefix of DashQL comment tags, e.g. `-- @dashql:description`
pub const COMMENT_TAG_PREFIX: &str = "@dashql:";
/// The tag that closes a tagged region of line comments
pub const COMMENT_TAG_END: &str = "end";

/// A block of comments
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CommentBlock {
    pub block_type: CommentBlockType,
    /// The whole block, including comment markers and tag lines
    pub text_span: TextSpan,
    /// The tag name (e.g. `description`), empty for ordinary comments
    pub tag_span: TextSpan,
    /// Slice of the comments of the script
    pub comments_begin: u32,
    pub comments_count: u32,
    /// Slice of [`CommentBlocks::lines`]
    pub lines_begin: u32,
    pub lines_count: u32,
}

/// The comments of a script grouped into blocks
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommentBlocks {
    /// The blocks in script order
    pub blocks: Vec<CommentBlock>,
    /// The content lines of all blocks
    pub lines: Vec<TextSpan>,
    /// Malformed comment tags
    pub warnings: Vec<(TextSpan, String)>,
    /// The `@dashql:metadata` block whose content is a valid JSON object, if any
    pub metadata_block: Option<u32>,
}

/// Group comments into blocks.
pub fn group_comments(text: &str, comments: &[TextSpan]) -> CommentBlocks {
    let mut grouper = Grouper {
        text: text.as_bytes(),
        comments,
        out: CommentBlocks::default(),
    };
    grouper.group();
    grouper.out
}

/// Whitespace within a line
fn is_horizontal_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\r' | b'\x0c' | b'\x0b')
}

/// A byte range [begin, end) in the script text
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Range {
    begin: usize,
    end: usize,
}

impl Range {
    fn new(begin: usize, end: usize) -> Self {
        Self { begin, end }
    }
    fn is_empty(&self) -> bool {
        self.begin >= self.end
    }
    fn span(&self) -> TextSpan {
        TextSpan::new(self.begin as u32, self.end.saturating_sub(self.begin) as u32)
    }
}

/// A comment tag at the start of a line
struct Tag {
    /// The tag name
    name: Range,
    /// The text following the tag on the same line
    rest: Range,
}

struct Grouper<'a> {
    text: &'a [u8],
    comments: &'a [TextSpan],
    out: CommentBlocks,
}

impl<'a> Grouper<'a> {
    fn slice(&self, r: Range) -> &'a [u8] {
        &self.text[r.begin..r.end.max(r.begin)]
    }

    fn string(&self, r: Range) -> String {
        String::from_utf8_lossy(self.slice(r)).into_owned()
    }

    /// Trim horizontal whitespace on both sides
    fn trim(&self, mut r: Range) -> Range {
        while r.begin < r.end && is_horizontal_space(self.text[r.begin]) {
            r.begin += 1;
        }
        while r.end > r.begin && is_horizontal_space(self.text[r.end - 1]) {
            r.end -= 1;
        }
        r
    }

    /// Read a tag from trimmed line content
    fn read_tag(&self, line: Range) -> Option<Tag> {
        if !self.slice(line).starts_with(COMMENT_TAG_PREFIX.as_bytes()) {
            return None;
        }
        let name_begin = line.begin + COMMENT_TAG_PREFIX.len();
        let mut name_end = name_begin;
        while name_end < line.end {
            let c = self.text[name_end];
            if !(c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
                break;
            }
            name_end += 1;
        }
        // The tag name must be followed by whitespace or the end of the line
        if name_end == name_begin || (name_end < line.end && !is_horizontal_space(self.text[name_end])) {
            return None;
        }
        Some(Tag {
            name: Range::new(name_begin, name_end),
            rest: self.trim(Range::new(name_end, line.end)),
        })
    }

    /// Is a comment the first text on its line?
    fn starts_line(&self, mut offset: usize) -> bool {
        while offset > 0 && is_horizontal_space(self.text[offset - 1]) {
            offset -= 1;
        }
        offset == 0 || self.text[offset - 1] == b'\n'
    }

    /// Is the gap between two line comments only whitespace with a single line break?
    fn is_contiguous_gap(&self, begin: usize, end: usize) -> bool {
        let mut line_breaks = 0;
        for &c in &self.text[begin..end] {
            if c == b'\n' {
                line_breaks += 1;
            } else if !is_horizontal_space(c) {
                return false;
            }
        }
        line_breaks <= 1
    }

    fn is_line_comment(&self, comment: TextSpan) -> bool {
        comment.length >= 2 && self.text[comment.offset as usize..].starts_with(b"--")
    }

    /// The content of a line comment: everything after the dashes and a single space
    fn line_comment_content(&self, comment: TextSpan) -> Range {
        let mut begin = comment.offset as usize;
        let mut end = comment.end() as usize;
        while begin < end && self.text[begin] == b'-' {
            begin += 1;
        }
        if begin < end && self.text[begin] == b' ' {
            begin += 1;
        }
        while end > begin && is_horizontal_space(self.text[end - 1]) {
            end -= 1;
        }
        Range::new(begin, end)
    }

    /// The content lines of a block comment without delimiters and gutters
    fn block_comment_lines(&self, comment: TextSpan) -> Vec<Range> {
        let mut begin = comment.offset as usize;
        let mut end = comment.end() as usize;
        // Strip `*/`, the scanner reports unterminated block comments as errors
        if comment.length >= 4 && &self.text[end - 2..end] == b"*/" {
            end -= 2;
        }
        // Strip `/*` and additional stars, as in `/**`
        begin = (begin + 2).min(end);
        while begin < end && self.text[begin] == b'*' {
            begin += 1;
        }
        while end > begin && self.text[end - 1] == b'*' {
            end -= 1;
        }
        let mut lines = Vec::new();
        let mut line_begin = begin;
        for i in begin..=end {
            if i < end && self.text[i] != b'\n' {
                continue;
            }
            let mut line = self.trim(Range::new(line_begin, i));
            // Strip a ` * ` gutter
            if !line.is_empty() && self.text[line.begin] == b'*' {
                line = self.trim(Range::new(line.begin + 1, line.end));
            }
            lines.push(line);
            line_begin = i + 1;
        }
        lines
    }

    fn tag_type(&self, name: &[u8]) -> CommentBlockType {
        match name {
            b"description" => CommentBlockType::DASHQL_DESCRIPTION,
            b"metadata" => CommentBlockType::DASHQL_METADATA,
            _ => CommentBlockType::DASHQL_UNKNOWN_TAG,
        }
    }

    fn warn(&mut self, span: TextSpan, message: String) {
        self.out.warnings.push((span, message));
    }

    /// Emit a block, leading and trailing empty lines are dropped
    fn emit(&mut self, block_type: CommentBlockType, comments_begin: usize, comments_end: usize, tag: Range, mut lines: &[Range]) {
        while lines.first().is_some_and(Range::is_empty) {
            lines = &lines[1..];
        }
        while lines.last().is_some_and(Range::is_empty) {
            lines = &lines[..lines.len() - 1];
        }
        let first = self.comments[comments_begin];
        let last = self.comments[comments_end - 1];
        self.out.blocks.push(CommentBlock {
            block_type,
            text_span: TextSpan::new(first.offset, last.end() - first.offset),
            tag_span: tag.span(),
            comments_begin: comments_begin as u32,
            comments_count: (comments_end - comments_begin) as u32,
            lines_begin: self.out.lines.len() as u32,
            lines_count: lines.len() as u32,
        });
        self.out.lines.extend(lines.iter().map(Range::span));
    }

    fn group_block_comment(&mut self, comment_id: usize) {
        let comment = self.comments[comment_id];
        let mut lines = self.block_comment_lines(comment);
        // A tag must be the first text of the comment
        let first = lines.iter().position(|l| !l.is_empty()).unwrap_or(lines.len());
        let tag = lines.get(first).and_then(|&line| self.read_tag(line));
        let Some(tag) = tag else {
            self.emit(CommentBlockType::COMMENT, comment_id, comment_id + 1, Range::default(), &lines);
            return;
        };
        let name = self.slice(tag.name);
        if name == COMMENT_TAG_END.as_bytes() {
            self.warn(comment, "@dashql:end without an opening tag".to_string());
            self.emit(CommentBlockType::COMMENT, comment_id, comment_id + 1, Range::default(), &lines);
            return;
        }
        let block_type = self.tag_type(name);
        if block_type == CommentBlockType::DASHQL_UNKNOWN_TAG {
            self.warn(comment, format!("unknown comment tag @dashql:{}", self.string(tag.name)));
        }
        lines[first] = tag.rest;
        self.emit(block_type, comment_id, comment_id + 1, tag.name, &lines[first..]);
    }

    fn group_line_comments(&mut self, run_begin: usize, run_end: usize) {
        let lines: Vec<Range> = (run_begin..run_end).map(|i| self.line_comment_content(self.comments[i])).collect();
        let line = |i: usize| lines[i - run_begin];
        // The comments of the run that are not yet emitted
        let mut pending = run_begin;
        let mut i = run_begin;
        while i < run_end {
            let Some(tag) = self.read_tag(self.trim(line(i))) else {
                i += 1;
                continue;
            };
            let name = self.slice(tag.name);
            if name == COMMENT_TAG_END.as_bytes() {
                self.warn(self.comments[i], "@dashql:end without an opening tag".to_string());
                i += 1;
                continue;
            }
            // Find the end of the region
            let mut close = i + 1;
            while close < run_end {
                let end_tag = self.read_tag(self.trim(line(close)));
                if end_tag.is_some_and(|t| t.rest.is_empty() && self.slice(t.name) == COMMENT_TAG_END.as_bytes()) {
                    break;
                }
                close += 1;
            }
            if close == run_end {
                // An unterminated region stays an ordinary comment
                let message = format!("@dashql:{} is not closed by a -- @dashql:end line", self.string(tag.name));
                self.warn(self.comments[i], message);
                i += 1;
                continue;
            }
            let block_type = self.tag_type(name);
            if block_type == CommentBlockType::DASHQL_UNKNOWN_TAG {
                self.warn(self.comments[i], format!("unknown comment tag @dashql:{}", self.string(tag.name)));
            }
            if pending < i {
                self.emit(CommentBlockType::COMMENT, pending, i, Range::default(), &lines[pending - run_begin..i - run_begin]);
            }
            let mut content = Vec::with_capacity(close - i);
            content.push(tag.rest);
            content.extend((i + 1..close).map(line));
            self.emit(block_type, i, close + 1, tag.name, &content);
            pending = close + 1;
            i = close + 1;
        }
        if pending < run_end {
            self.emit(CommentBlockType::COMMENT, pending, run_end, Range::default(), &lines[pending - run_begin..]);
        }
    }

    /// Check the metadata blocks, the first one must contain a JSON object
    fn validate_metadata(&mut self) {
        let mut seen = false;
        for i in 0..self.out.blocks.len() {
            let block = self.out.blocks[i];
            if block.block_type != CommentBlockType::DASHQL_METADATA {
                continue;
            }
            if seen {
                self.warn(block.text_span, "@dashql:metadata is ignored, a script has a single metadata block".to_string());
                continue;
            }
            seen = true;
            let mut json = Vec::new();
            for j in 0..block.lines_count {
                let line = self.out.lines[(block.lines_begin + j) as usize];
                if j > 0 {
                    json.push(b'\n');
                }
                json.extend_from_slice(&self.text[line.offset as usize..line.end() as usize]);
            }
            match serde_json::from_slice::<serde_json::Value>(&json) {
                Err(_) => self.warn(block.text_span, "@dashql:metadata is not valid JSON".to_string()),
                Ok(value) if !value.is_object() => {
                    self.warn(block.text_span, "@dashql:metadata must be a JSON object".to_string())
                }
                Ok(_) => self.out.metadata_block = Some(i as u32),
            }
        }
    }

    fn group(&mut self) {
        let mut i = 0;
        while i < self.comments.len() {
            let comment = self.comments[i];
            if !self.is_line_comment(comment) {
                self.group_block_comment(i);
                i += 1;
                continue;
            }
            // A trailing line comment is a block of its own
            let mut run_end = i + 1;
            if self.starts_line(comment.offset as usize) {
                while run_end < self.comments.len() {
                    let prev = self.comments[run_end - 1];
                    let next = self.comments[run_end];
                    if !self.is_line_comment(next)
                        || !self.is_contiguous_gap(prev.end() as usize, next.offset as usize)
                        || !self.starts_line(next.offset as usize)
                    {
                        break;
                    }
                    run_end += 1;
                }
            }
            self.group_line_comments(i, run_end);
            i = run_end;
        }
        self.validate_metadata();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::scan;

    fn group(text: &str) -> CommentBlocks {
        let scanned = scan(text, 0, 0);
        group_comments(text, &scanned.comments)
    }

    fn line_texts(text: &str, blocks: &CommentBlocks, block: usize) -> Vec<String> {
        let b = blocks.blocks[block];
        blocks.lines[b.lines_begin as usize..(b.lines_begin + b.lines_count) as usize]
            .iter()
            .map(|l| text[l.offset as usize..l.end() as usize].to_string())
            .collect()
    }

    #[test]
    fn groups_line_comments() {
        let text = "-- a\n-- b\nselect 1; -- trailing\n\n-- c";
        let blocks = group(text);
        assert_eq!(blocks.blocks.len(), 3);
        assert_eq!(line_texts(text, &blocks, 0), vec!["a", "b"]);
        assert_eq!(line_texts(text, &blocks, 1), vec!["trailing"]);
        assert_eq!(line_texts(text, &blocks, 2), vec!["c"]);
    }

    #[test]
    fn reads_tagged_regions() {
        let text = "-- @dashql:description Sales\n-- per region\n-- @dashql:end\n/* @dashql:metadata {\"a\": 1} */";
        let blocks = group(text);
        assert_eq!(blocks.blocks[0].block_type, CommentBlockType::DASHQL_DESCRIPTION);
        assert_eq!(line_texts(text, &blocks, 0), vec!["Sales", "per region"]);
        assert_eq!(blocks.blocks[1].block_type, CommentBlockType::DASHQL_METADATA);
        assert_eq!(blocks.metadata_block, Some(1));
        assert!(blocks.warnings.is_empty());
    }

    #[test]
    fn warns_about_malformed_tags() {
        let blocks = group("-- @dashql:description\n-- x\n/* @dashql:metadata [1] */\n/* @dashql:foo */");
        let warnings: Vec<&str> = blocks.warnings.iter().map(|w| w.1.as_str()).collect();
        assert_eq!(
            warnings,
            vec![
                "@dashql:description is not closed by a -- @dashql:end line",
                "unknown comment tag @dashql:foo",
                "@dashql:metadata must be a JSON object",
            ]
        );
    }
}
