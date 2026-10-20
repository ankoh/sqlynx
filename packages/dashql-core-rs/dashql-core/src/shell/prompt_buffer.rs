//! The editable prompt of the shell (`src/shell/prompt_buffer.cc`).
//!
//! The prompt is a script whose cursor moves by extended grapheme clusters. The C++ rope keeps
//! grapheme statistics in its nodes and splits leaves on grapheme boundaries, so its grapheme
//! offsets are those of the whole text; the Rust prompt segments the (short) text on demand.

use super::unicode::{grapheme_boundaries, is_valid, next_grapheme, previous_grapheme};
use crate::catalog::Catalog;
use crate::script::Script;

/// A grapheme position: the byte and code point offsets of a grapheme cluster boundary
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Position {
    bytes: usize,
    codepoints: usize,
    graphemes: usize,
}

/// The grapheme boundaries of a text (`Rope::ResolveGrapheme*`)
struct Positions {
    /// The byte offsets of the boundaries, including the end
    bytes: Vec<usize>,
    /// The code point offsets of the boundaries, including the end
    codepoints: Vec<usize>,
}

impl Positions {
    fn of(text: &str) -> Self {
        let bytes = grapheme_boundaries(text);
        let mut codepoints = Vec::with_capacity(bytes.len());
        let mut count = 0;
        let mut previous = 0;
        for &b in &bytes {
            count += text.as_bytes()[previous..b].iter().filter(|&&c| (c & 0xC0) != 0x80).count();
            codepoints.push(count);
            previous = b;
        }
        Self { bytes, codepoints }
    }

    fn count(&self) -> usize {
        self.bytes.len() - 1
    }

    fn position(&self, idx: usize) -> Position {
        Position { bytes: self.bytes[idx], codepoints: self.codepoints[idx], graphemes: idx }
    }

    /// `ResolveGrapheme`: the start of a grapheme cluster, the end for indexes past the end
    fn resolve(&self, idx: usize) -> Position {
        self.position(idx.min(self.count()))
    }

    /// `ResolveGraphemeBoundary`: the boundary at an exact byte offset
    fn boundary(&self, byte: usize) -> Option<Position> {
        self.bytes.binary_search(&byte).ok().map(|idx| self.position(idx))
    }

    /// `ResolveGraphemeBoundaryAtOrAfter`: the first boundary at or after a byte offset
    fn at_or_after(&self, byte: usize) -> Position {
        let byte = byte.min(*self.bytes.last().unwrap());
        self.position(self.bytes.partition_point(|&b| b < byte))
    }

    /// The boundary at a byte offset that C++ dereferences without a check. A line break inside a CR LF cluster
    /// has no boundary, which is undefined behavior in C++; take the boundary before it.
    fn unchecked_boundary(&self, byte: usize) -> Position {
        self.boundary(byte)
            .unwrap_or_else(|| self.position(self.bytes.partition_point(|&b| b <= byte).saturating_sub(1)))
    }
}

fn is_word_grapheme(grapheme: &[u8]) -> bool {
    let Some(&byte) = grapheme.first() else {
        return false;
    };
    byte >= 0x80 || byte.is_ascii_alphanumeric() || byte == b'_'
}

fn next_grapheme_at_least_one(text: &[u8], offset: usize) -> usize {
    let next = next_grapheme(text, offset);
    if next > offset {
        next
    } else {
        offset + 1
    }
}

/// The prompt of a shell (`PromptBuffer`)
pub struct PromptBuffer {
    script: Script,
    cursor_grapheme_offset: usize,
    revision: u64,
}

impl PromptBuffer {
    pub fn new(catalog: &Catalog) -> Self {
        Self { script: Script::new(catalog), cursor_grapheme_offset: 0, revision: 0 }
    }

    fn positions(&self) -> Positions {
        Positions::of(&self.script.to_text())
    }

    /// The script of the prompt
    pub fn script(&self) -> &Script {
        &self.script
    }

    pub fn script_mut(&mut self) -> &mut Script {
        &mut self.script
    }

    /// The prompt text (`Text`)
    pub fn text(&self) -> String {
        self.script.to_text()
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// The number of grapheme clusters
    pub fn grapheme_count(&self) -> usize {
        self.positions().count()
    }

    pub fn cursor_byte_offset(&self) -> usize {
        self.positions().resolve(self.cursor_grapheme_offset).bytes
    }

    pub fn cursor_codepoint_offset(&self) -> usize {
        self.positions().resolve(self.cursor_grapheme_offset).codepoints
    }

    /// Replace the text and move the cursor to the end (`SetText`)
    pub fn set_text(&mut self, text: &[u8]) -> bool {
        let Ok(text) = std::str::from_utf8(text) else {
            return false;
        };
        if text != self.script.to_text() {
            self.script.replace_text(text);
            self.revision += 1;
        }
        self.cursor_grapheme_offset = self.grapheme_count();
        true
    }

    /// Insert text at the cursor (`Insert`)
    pub fn insert(&mut self, text: &[u8]) -> bool {
        if text.is_empty() {
            return false;
        }
        let Ok(text) = std::str::from_utf8(text) else {
            return false;
        };
        let cursor = self.positions().resolve(self.cursor_grapheme_offset);
        let desired_byte_offset = cursor.bytes + text.len();
        self.script.insert_text_at(cursor.codepoints, text);
        self.revision += 1;
        self.cursor_grapheme_offset = self.positions().at_or_after(desired_byte_offset).graphemes;
        true
    }

    pub fn move_left(&mut self) -> bool {
        if self.cursor_grapheme_offset == 0 {
            return false;
        }
        self.cursor_grapheme_offset -= 1;
        true
    }

    pub fn move_right(&mut self) -> bool {
        if self.cursor_grapheme_offset >= self.grapheme_count() {
            return false;
        }
        self.cursor_grapheme_offset += 1;
        true
    }

    pub fn move_to_start(&mut self) -> bool {
        if self.cursor_grapheme_offset == 0 {
            return false;
        }
        self.cursor_grapheme_offset = 0;
        true
    }

    pub fn move_to_end(&mut self) -> bool {
        let end = self.grapheme_count();
        if self.cursor_grapheme_offset == end {
            return false;
        }
        self.cursor_grapheme_offset = end;
        true
    }

    pub fn move_to_line_start(&mut self) -> bool {
        let text = self.text();
        let cursor = self.cursor_byte_offset();
        let begin = text.as_bytes()[..cursor].iter().rposition(|&c| c == b'\n').map_or(0, |i| i + 1);
        self.move_to_byte_offset(begin)
    }

    pub fn move_to_line_end(&mut self) -> bool {
        let text = self.text();
        let cursor = self.cursor_byte_offset();
        let end = find_from(text.as_bytes(), b'\n', cursor).unwrap_or(text.len());
        self.move_to_byte_offset(end)
    }

    /// The byte offset of the word start left of the cursor
    fn word_left(&self, text: &[u8], mut cursor: usize) -> usize {
        while cursor > 0 {
            let previous = previous_grapheme(text, cursor);
            if is_word_grapheme(&text[previous..cursor]) {
                break;
            }
            cursor = previous;
        }
        while cursor > 0 {
            let previous = previous_grapheme(text, cursor);
            if !is_word_grapheme(&text[previous..cursor]) {
                break;
            }
            cursor = previous;
        }
        cursor
    }

    pub fn move_word_left(&mut self) -> bool {
        let text = self.text();
        let original = self.cursor_byte_offset();
        let cursor = self.word_left(text.as_bytes(), original);
        cursor != original && self.move_to_byte_offset(cursor)
    }

    pub fn move_word_right(&mut self) -> bool {
        let text = self.text();
        let text = text.as_bytes();
        let original = self.cursor_byte_offset();
        let mut cursor = original;
        while cursor < text.len() && !is_word_grapheme(&text[cursor..next_grapheme_at_least_one(text, cursor)]) {
            cursor = next_grapheme_at_least_one(text, cursor);
        }
        while cursor < text.len() && is_word_grapheme(&text[cursor..next_grapheme_at_least_one(text, cursor)]) {
            cursor = next_grapheme_at_least_one(text, cursor);
        }
        cursor != original && self.move_to_byte_offset(cursor)
    }

    pub fn move_up(&mut self) -> bool {
        let text = self.text();
        let bytes = text.as_bytes();
        let positions = Positions::of(&text);
        let cursor = positions.resolve(self.cursor_grapheme_offset).bytes;
        let Some(line_begin) = bytes[..cursor].iter().rposition(|&c| c == b'\n') else {
            return false;
        };
        let previous_line_end = line_begin;
        let previous_line_begin = bytes[..previous_line_end].iter().rposition(|&c| c == b'\n').map_or(0, |i| i + 1);
        let column = self.cursor_grapheme_offset - positions.unchecked_boundary(line_begin + 1).graphemes;
        let previous_line_column = positions.unchecked_boundary(previous_line_begin).graphemes;
        let previous_line_length = positions.unchecked_boundary(previous_line_end).graphemes - previous_line_column;
        self.cursor_grapheme_offset = previous_line_column + column.min(previous_line_length);
        true
    }

    pub fn move_down(&mut self) -> bool {
        let text = self.text();
        let bytes = text.as_bytes();
        let positions = Positions::of(&text);
        let cursor = positions.resolve(self.cursor_grapheme_offset).bytes;
        let Some(next_line_break) = find_from(bytes, b'\n', cursor) else {
            return false;
        };
        let line_begin = bytes[..cursor].iter().rposition(|&c| c == b'\n').map_or(0, |i| i + 1);
        let next_line_begin = next_line_break + 1;
        let next_line_end = find_from(bytes, b'\n', next_line_begin).unwrap_or(bytes.len());
        let column = self.cursor_grapheme_offset.wrapping_sub(positions.unchecked_boundary(line_begin).graphemes);
        let next_line_column = positions.unchecked_boundary(next_line_begin).graphemes;
        let next_line_length = positions.unchecked_boundary(next_line_end).graphemes - next_line_column;
        self.cursor_grapheme_offset = next_line_column + column.min(next_line_length);
        true
    }

    /// Move the cursor to a grapheme boundary (`MoveToByteOffset`)
    pub fn move_to_byte_offset(&mut self, byte_offset: usize) -> bool {
        match self.positions().boundary(byte_offset) {
            Some(position) => {
                self.cursor_grapheme_offset = position.graphemes;
                true
            }
            None => false,
        }
    }

    pub fn delete_backward(&mut self) -> bool {
        if self.cursor_grapheme_offset == 0 {
            return false;
        }
        let positions = self.positions();
        let begin = positions.resolve(self.cursor_grapheme_offset - 1);
        let end = positions.resolve(self.cursor_grapheme_offset);
        self.script.erase_text_range(begin.codepoints, end.codepoints - begin.codepoints);
        self.cursor_grapheme_offset -= 1;
        self.revision += 1;
        true
    }

    pub fn delete_forward(&mut self) -> bool {
        let positions = self.positions();
        if self.cursor_grapheme_offset >= positions.count() {
            return false;
        }
        let begin = positions.resolve(self.cursor_grapheme_offset);
        let end = positions.resolve(self.cursor_grapheme_offset + 1);
        self.script.erase_text_range(begin.codepoints, end.codepoints - begin.codepoints);
        self.revision += 1;
        true
    }

    pub fn delete_to_line_start(&mut self, deleted: Option<&mut String>) -> bool {
        let text = self.text();
        let end = self.cursor_byte_offset();
        let begin = text.as_bytes()[..end].iter().rposition(|&c| c == b'\n').map_or(0, |i| i + 1);
        if begin == end {
            return false;
        }
        if let Some(deleted) = deleted {
            *deleted = text[begin..end].to_string();
        }
        self.replace_byte_range(begin, end - begin, "")
    }

    pub fn delete_to_line_end(&mut self, deleted: Option<&mut String>) -> bool {
        let text = self.text();
        let begin = self.cursor_byte_offset();
        let end = match find_from(text.as_bytes(), b'\n', begin) {
            Some(line_break) if line_break == begin => line_break + 1,
            Some(line_break) => line_break,
            None => text.len(),
        };
        if begin == end {
            return false;
        }
        if let Some(deleted) = deleted {
            *deleted = text[begin..end].to_string();
        }
        self.replace_byte_range(begin, end - begin, "")
    }

    pub fn delete_word_backward(&mut self, deleted: Option<&mut String>) -> bool {
        let end = self.cursor_byte_offset();
        if !self.move_word_left() {
            return false;
        }
        let begin = self.cursor_byte_offset();
        if let Some(deleted) = deleted {
            *deleted = self.text()[begin..end].to_string();
        }
        self.replace_byte_range(begin, end - begin, "")
    }

    pub fn delete_word_forward(&mut self, deleted: Option<&mut String>) -> bool {
        let begin = self.cursor_byte_offset();
        if !self.move_word_right() {
            return false;
        }
        let end = self.cursor_byte_offset();
        if let Some(deleted) = deleted {
            *deleted = self.text()[begin..end].to_string();
        }
        self.replace_byte_range(begin, end - begin, "")
    }

    pub fn transpose_characters(&mut self) -> bool {
        let text = self.text();
        let positions = Positions::of(&text);
        let count = positions.count();
        if count < 2 || self.cursor_grapheme_offset == 0 {
            return false;
        }
        let left_index = if self.cursor_grapheme_offset == count { count - 2 } else { self.cursor_grapheme_offset - 1 };
        let right_index = left_index + 1;
        let begin = positions.resolve(left_index).bytes;
        let middle = positions.resolve(right_index).bytes;
        let end = positions.resolve(right_index + 1).bytes;
        let mut replacement = text[middle..end].to_string();
        replacement.push_str(&text[begin..middle]);
        self.replace_byte_range(begin, end - begin, &replacement)
    }

    /// Replace a byte range on grapheme boundaries and move the cursor behind the replacement (`ReplaceByteRange`)
    pub fn replace_byte_range(&mut self, byte_offset: usize, byte_length: usize, text: &str) -> bool {
        let positions = self.positions();
        let (Some(begin), Some(end)) =
            (positions.boundary(byte_offset), positions.boundary(byte_offset.saturating_add(byte_length)))
        else {
            return false;
        };
        let deleted = end.codepoints - begin.codepoints;
        if deleted != 0 {
            self.script.erase_text_range(begin.codepoints, deleted);
        }
        if !text.is_empty() {
            self.script.insert_text_at(begin.codepoints, text);
        }
        self.revision += 1;
        self.cursor_grapheme_offset = self.positions().at_or_after(byte_offset + text.len()).graphemes;
        true
    }

    /// Replace a byte range with bytes that must be valid UTF-8 (`ReplaceByteRange` of the C ABI)
    pub fn replace_byte_range_bytes(&mut self, byte_offset: usize, byte_length: usize, text: &[u8]) -> bool {
        if !is_valid(text) {
            return false;
        }
        self.replace_byte_range(byte_offset, byte_length, std::str::from_utf8(text).unwrap())
    }
}

/// Find a byte at or after an offset (`std::string::find(char, pos)`)
pub(super) fn find_from(text: &[u8], needle: u8, from: usize) -> Option<usize> {
    if from > text.len() {
        return None;
    }
    text[from..].iter().position(|&c| c == needle).map(|i| i + from)
}
