//! Comment output of the formatter (the comment helpers of `formatter/formatter.cc`).
//!
//! Comments work on bytes like the C++ code: wrapping splits long words at byte offsets, which can
//! split UTF-8 sequences.

use dashql_grammar::span::TextSpan;

/// `std::isspace` in the C locale
pub(super) fn is_space(ch: u8) -> bool {
    matches!(ch, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r')
}

fn is_whitespace(text: &[u8]) -> bool {
    text.iter().all(|&ch| is_space(ch))
}

fn trim_whitespace(mut text: &[u8]) -> &[u8] {
    while let [first, rest @ ..] = text {
        if !is_space(*first) {
            break;
        }
        text = rest;
    }
    while let [rest @ .., last] = text {
        if !is_space(*last) {
            break;
        }
        text = rest;
    }
    text
}

/// `std::string_view::substr`, clamped to the text
fn substr(text: &[u8], offset: usize, length: usize) -> &[u8] {
    let begin = offset.min(text.len());
    let end = begin + length.min(text.len() - begin);
    &text[begin..end]
}

fn comment_text<'a>(input: &'a [u8], comment: &TextSpan) -> &'a [u8] {
    substr(input, comment.offset as usize, comment.length as usize)
}

/// `find_first_of`
fn find_first_of(text: &[u8], chars: &[u8]) -> Option<usize> {
    text.iter().position(|ch| chars.contains(ch))
}

fn count_line_breaks(text: &[u8]) -> usize {
    text.iter().filter(|&&ch| ch == b'\n').count()
}

fn ends_with_line_break(output: &[u8]) -> bool {
    output.last() == Some(&b'\n')
}

fn append_comment_line(output: &mut Vec<u8>, text: &[u8], max_width: usize) {
    if !output.is_empty() && !ends_with_line_break(output) {
        output.push(b'\n');
    }
    output.extend_from_slice(b"--");
    if text.is_empty() {
        return;
    }
    if max_width >= 4 {
        output.push(b' ');
    }
    output.extend_from_slice(text);
}

fn append_wrapped_comment_paragraph(output: &mut Vec<u8>, words: &[&[u8]], max_width: usize) {
    if words.is_empty() {
        append_comment_line(output, &[], max_width);
        return;
    }

    let prefix_width = if max_width >= 4 { 3 } else { 2 };
    let content_width = if max_width > prefix_width { max_width - prefix_width } else { 1 };
    let mut line: Vec<u8> = Vec::new();
    for word in words {
        let mut offset = 0;
        while offset < word.len() {
            let remaining = word.len() - offset;
            if !line.is_empty() && line.len() + 1 + remaining > content_width {
                append_comment_line(output, &line, max_width);
                line.clear();
                continue;
            }

            let separator = if line.is_empty() { 0 } else { 1 };
            if remaining <= content_width - line.len() - separator {
                if !line.is_empty() {
                    line.push(b' ');
                }
                line.extend_from_slice(&word[offset..]);
                offset = word.len();
            } else {
                let available = content_width - line.len() - separator;
                if !line.is_empty() {
                    line.push(b' ');
                }
                line.extend_from_slice(&word[offset..offset + available]);
                offset += available;
                append_comment_line(output, &line, max_width);
                line.clear();
            }
        }
    }
    if !line.is_empty() {
        append_comment_line(output, &line, max_width);
    }
}

fn append_wrapped_line_comments(output: &mut Vec<u8>, input: &[u8], comments: &[TextSpan], max_width: usize) {
    let mut normalized_lines: Vec<&[u8]> = Vec::new();
    for comment in comments {
        let mut text = comment_text(input, comment);
        if text.starts_with(b"--") {
            text = &text[2..];
        }
        loop {
            let line_end = find_first_of(text, b"\r\n");
            let line = trim_whitespace(&text[..line_end.unwrap_or(text.len())]);
            normalized_lines.push(line);

            let Some(line_end) = line_end else { break };
            let mut next = line_end + 1;
            if text[line_end] == b'\r' && next < text.len() && text[next] == b'\n' {
                next += 1;
            }
            text = &text[next..];
        }
    }

    let first = normalized_lines.iter().position(|l| !l.is_empty()).unwrap_or(normalized_lines.len());
    normalized_lines.drain(..first);
    while normalized_lines.last().is_some_and(|l| l.is_empty()) {
        normalized_lines.pop();
    }

    if normalized_lines.is_empty() {
        append_comment_line(output, &[], max_width);
        return;
    }

    let mut words: Vec<&[u8]> = Vec::new();
    for line in normalized_lines {
        if line.is_empty() {
            if !words.is_empty() {
                append_wrapped_comment_paragraph(output, &words, max_width);
                words.clear();
            }
            append_comment_line(output, &[], max_width);
            continue;
        }

        let mut remaining = line;
        while !remaining.is_empty() {
            let word_end = find_first_of(remaining, b" \t\r\n\x0c");
            let word = &remaining[..word_end.unwrap_or(remaining.len())];
            if !word.is_empty() {
                words.push(word);
            }
            let Some(word_end) = word_end else { break };
            remaining = trim_whitespace(&remaining[word_end + 1..]);
        }
    }
    if !words.is_empty() {
        append_wrapped_comment_paragraph(output, &words, max_width);
    }
}

/// The tag name of a `-- @dashql:<tag>` line comment and whether the tag is alone on its line
struct CommentTag<'a> {
    name: &'a [u8],
    alone: bool,
}

fn read_comment_tag<'a>(input: &'a [u8], comment: &TextSpan) -> Option<CommentTag<'a>> {
    let text = comment_text(input, comment);
    let text = trim_whitespace(text.strip_prefix(b"--")?);
    let text = text.strip_prefix(b"@dashql:")?;
    let name_end = find_first_of(text, b" \t\r\n\x0c");
    let name = &text[..name_end.unwrap_or(text.len())];
    if name.is_empty() {
        return None;
    }
    let alone = match name_end {
        None => true,
        Some(end) => trim_whitespace(&text[end..]).is_empty(),
    };
    Some(CommentTag { name, alone })
}

/// Format a run of line comments. Regions from `-- @dashql:<tag>` to `-- @dashql:end` are kept as
/// written, since their content is structured (e.g. JSON) and rewrapping it would break it. Other
/// comments are rewrapped. A blank line that follows a region is kept, `following` is the offset of
/// the text after the comment block.
fn append_line_comment_block(
    output: &mut Vec<u8>,
    input: &[u8],
    comments: &[TextSpan],
    max_width: usize,
    following: Option<usize>,
) {
    let mut pending = 0;
    let mut i = 0;
    while i < comments.len() {
        match read_comment_tag(input, &comments[i]) {
            Some(tag) if tag.name != b"end" => {}
            _ => {
                i += 1;
                continue;
            }
        }
        let mut close = i + 1;
        while close < comments.len() {
            if let Some(end_tag) = read_comment_tag(input, &comments[close]) {
                if end_tag.alone && end_tag.name == b"end" {
                    break;
                }
            }
            close += 1;
        }
        // An unterminated region is an ordinary comment
        if close == comments.len() {
            i += 1;
            continue;
        }
        if pending < i {
            append_wrapped_line_comments(output, input, &comments[pending..i], max_width);
        }
        for comment in &comments[i..=close] {
            if !output.is_empty() && !ends_with_line_break(output) {
                output.push(b'\n');
            }
            let mut text = comment_text(input, comment);
            while let [rest @ .., last] = text {
                if !is_space(*last) {
                    break;
                }
                text = rest;
            }
            output.extend_from_slice(text);
        }
        let region_end = comments[close].end() as usize;
        let next = if close + 1 < comments.len() { Some(comments[close + 1].offset as usize) } else { following };
        if let Some(next) = next {
            if next >= region_end {
                let gap = substr(input, region_end, next - region_end);
                if count_line_breaks(gap) > 1 {
                    output.extend_from_slice(b"\n\n");
                }
            }
        }
        pending = close + 1;
        i = close + 1;
    }
    if pending < comments.len() {
        append_wrapped_line_comments(output, input, &comments[pending..], max_width);
    }
}

/// Append comments: block comments verbatim, runs of line comments rewrapped
pub(super) fn append_comments(
    output: &mut Vec<u8>,
    input: &[u8],
    comments: &[TextSpan],
    max_width: usize,
    following: Option<usize>,
) {
    let mut block_begin = 0;
    for i in 0..=comments.len() {
        let mut end_block = i == comments.len();
        let mut is_block_comment = false;
        if !end_block {
            is_block_comment = comment_text(input, &comments[i]).starts_with(b"/*");
            end_block = is_block_comment;
        }
        if !end_block && !is_block_comment && i > block_begin {
            let previous_end = comments[i - 1].end() as usize;
            let gap = substr(input, previous_end, (comments[i].offset as usize).wrapping_sub(previous_end));
            end_block = !is_whitespace(gap) || count_line_breaks(gap) > 1;
        }
        if end_block {
            if i > block_begin {
                let next = if i < comments.len() { Some(comments[i].offset as usize) } else { following };
                append_line_comment_block(output, input, &comments[block_begin..i], max_width, next);
            }
            block_begin = i;
        }
        if is_block_comment {
            if !output.is_empty() && !ends_with_line_break(output) {
                output.push(b'\n');
            }
            output.extend_from_slice(comment_text(input, &comments[i]));
            block_begin = i + 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spans(input: &str, comments: &[&str]) -> Vec<TextSpan> {
        let mut from = 0;
        comments
            .iter()
            .map(|c| {
                let offset = from + input[from..].find(c).unwrap();
                from = offset + c.len();
                TextSpan::new(offset as u32, c.len() as u32)
            })
            .collect()
    }

    fn format(input: &str, comments: &[&str], max_width: usize) -> String {
        let mut out = Vec::new();
        append_comments(&mut out, input.as_bytes(), &spans(input, comments), max_width, None);
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn rewraps_line_comments() {
        let input = "-- aaa bbb\n-- ccc";
        assert_eq!(format(input, &["-- aaa bbb", "-- ccc"], 120), "-- aaa bbb ccc");
        assert_eq!(format(input, &["-- aaa bbb", "-- ccc"], 10), "-- aaa bbb\n-- ccc");
        assert_eq!(format(input, &["-- aaa bbb", "-- ccc"], 9), "-- aaa\n-- bbb\n-- ccc");
        // Words longer than the line are split
        assert_eq!(format("--abcdefgh", &["--abcdefgh"], 6), "-- abc\n-- def\n-- gh");
    }

    #[test]
    fn keeps_blank_lines_and_block_comments() {
        let input = "-- a\n\n-- b\n/* c */";
        assert_eq!(format(input, &["-- a", "-- b", "/* c */"], 120), "-- a\n-- b\n/* c */");
        let input = "-- a\n--\n-- b";
        assert_eq!(format(input, &["-- a", "--", "-- b"], 120), "-- a\n--\n-- b");
    }

    #[test]
    fn keeps_tagged_regions() {
        let input = "-- @dashql:meta\n-- {\"a\":   1}\n-- @dashql:end\n\n-- x   y";
        let out = format(input, &["-- @dashql:meta", "-- {\"a\":   1}", "-- @dashql:end", "-- x   y"], 120);
        assert_eq!(out, "-- @dashql:meta\n-- {\"a\":   1}\n-- @dashql:end\n\n-- x y");
    }

    #[test]
    fn trims_like_isspace() {
        assert_eq!(trim_whitespace(b"\x0b a \x0c"), b"a");
        assert!(is_whitespace(b" \t\r\n"));
        assert_eq!(substr(b"abc", 5, 2), b"");
        assert_eq!(substr(b"abc", 1, 10), b"bc");
    }
}
