//! Offset conversions of the script rope (`Rope::ResolveByteBoundary`, `Rope::ResolveUtf16Boundary`
//! and `Rope::TextPosition` in `src/utils/rope.cc`).
//!
//! The C++ positions also carry a grapheme count, which the boundary lookups never compute (they
//! return the grapheme count of the leaf prefix). Nothing reads it, so it is left out here.

use ropey::Rope;

/// A position in the text in all offset units (`Rope::TextPosition`)
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TextPosition {
    /// The UTF-8 byte offset
    pub text_bytes: usize,
    /// The code point offset
    pub utf8_codepoints: usize,
    /// The UTF-16 code unit offset
    pub utf16_code_units: usize,
}

/// Resolve a UTF-8 byte offset that lies on a code point boundary (`ResolveByteBoundary`)
pub fn resolve_byte_boundary(text: &Rope, byte_idx: usize) -> Option<TextPosition> {
    if byte_idx > text.len_bytes() {
        return None;
    }
    let char_idx = text.byte_to_char(byte_idx);
    if text.char_to_byte(char_idx) != byte_idx {
        return None;
    }
    Some(TextPosition {
        text_bytes: byte_idx,
        utf8_codepoints: char_idx,
        utf16_code_units: text.char_to_utf16_cu(char_idx),
    })
}

/// Resolve a UTF-16 code unit offset that does not split a surrogate pair (`ResolveUtf16Boundary`)
pub fn resolve_utf16_boundary(text: &Rope, utf16_idx: usize) -> Option<TextPosition> {
    if utf16_idx > text.len_utf16_cu() {
        return None;
    }
    let char_idx = text.utf16_cu_to_char(utf16_idx);
    if text.char_to_utf16_cu(char_idx) != utf16_idx {
        return None;
    }
    Some(TextPosition {
        text_bytes: text.char_to_byte(char_idx),
        utf8_codepoints: char_idx,
        utf16_code_units: utf16_idx,
    })
}

/// Converts UTF-8 byte offsets of a text to UTF-16 code units.
///
/// Projections convert many offsets that mostly ascend (tokens, comments, references). The
/// converter remembers the last position and walks forward from it over a short distance, and looks
/// the offset up in the rope otherwise, so that converting all spans of a script stays linear.
pub struct Utf16Projector<'a> {
    /// The text of the rope, if it is at hand
    text: Option<&'a str>,
    /// The rope to look offsets up in
    rope: &'a Rope,
    /// The byte offset of the last projection
    last_byte: usize,
    /// The UTF-16 offset of the last projection
    last_utf16: usize,
}

/// The longest distance that is walked instead of looked up
const MAX_WALK: usize = 256;

impl<'a> Utf16Projector<'a> {
    /// Create a converter. `text` must be the text of `rope`, without it every offset is looked up.
    pub fn new(text: Option<&'a str>, rope: &'a Rope) -> Self {
        debug_assert!(text.is_none_or(|t| t.len() == rope.len_bytes()));
        Self { text, rope, last_byte: 0, last_utf16: 0 }
    }

    /// The UTF-16 offset of a byte offset, None if it is past the end or not on a code point boundary
    pub fn project(&mut self, byte_idx: usize) -> Option<usize> {
        let Some(text) = self.text else {
            return resolve_byte_boundary(self.rope, byte_idx).map(|p| p.utf16_code_units);
        };
        if byte_idx > text.len() || !text.is_char_boundary(byte_idx) {
            return None;
        }
        if byte_idx >= self.last_byte && byte_idx - self.last_byte <= MAX_WALK {
            let units: usize = text[self.last_byte..byte_idx].chars().map(char::len_utf16).sum();
            self.last_utf16 += units;
        } else {
            self.last_utf16 = self.rope.char_to_utf16_cu(self.rope.byte_to_char(byte_idx));
        }
        self.last_byte = byte_idx;
        Some(self.last_utf16)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_boundaries() {
        // a, é (2 bytes), 😀 (4 bytes, a surrogate pair), z
        let rope = Rope::from_str("a\u{e9}\u{1F600}z");
        assert_eq!(resolve_byte_boundary(&rope, 0).unwrap().utf16_code_units, 0);
        assert_eq!(resolve_byte_boundary(&rope, 1).unwrap().utf16_code_units, 1);
        assert!(resolve_byte_boundary(&rope, 2).is_none());
        assert_eq!(resolve_byte_boundary(&rope, 3).unwrap().utf16_code_units, 2);
        assert!(resolve_byte_boundary(&rope, 4).is_none());
        let end = resolve_byte_boundary(&rope, 7).unwrap();
        assert_eq!((end.utf8_codepoints, end.utf16_code_units), (3, 4));
        assert_eq!(resolve_byte_boundary(&rope, 8).unwrap().utf16_code_units, 5);
        assert!(resolve_byte_boundary(&rope, 9).is_none());

        assert_eq!(resolve_utf16_boundary(&rope, 2).unwrap().text_bytes, 3);
        assert!(resolve_utf16_boundary(&rope, 3).is_none());
        assert_eq!(resolve_utf16_boundary(&rope, 4).unwrap().text_bytes, 7);
        assert_eq!(resolve_utf16_boundary(&rope, 5).unwrap().text_bytes, 8);
        assert!(resolve_utf16_boundary(&rope, 6).is_none());
    }

    #[test]
    fn projects_like_lookups() {
        let text = "x\u{1F600}y\u{e9}".repeat(200);
        let rope = Rope::from_str(&text);
        let mut projector = Utf16Projector::new(Some(&text), &rope);
        let mut lookups = Utf16Projector::new(None, &rope);
        for offset in (0..=text.len() + 1).chain((0..=text.len()).rev()).chain([3, 900, 5, 1200, 0]) {
            let expected = resolve_byte_boundary(&rope, offset).map(|p| p.utf16_code_units);
            assert_eq!(projector.project(offset), expected, "{offset}");
            assert_eq!(lookups.project(offset), expected, "{offset}");
        }
    }
}
