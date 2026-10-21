//! Byte spans in the script text.

/// A span of bytes in the script text.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct TextSpan {
    /// The byte offset of the start
    pub offset: u32,
    /// The length in bytes
    pub length: u32,
}

impl TextSpan {
    pub const fn new(offset: u32, length: u32) -> Self {
        Self { offset, length }
    }

    /// The end offset (exclusive)
    pub const fn end(&self) -> u32 {
        self.offset + self.length
    }

    /// The smallest span that covers both spans (the C++ `Loc({a, b})`)
    pub fn cover(self, other: TextSpan) -> TextSpan {
        let begin = self.offset.min(other.offset);
        let end = self.end().max(other.end());
        TextSpan::new(begin, end - begin)
    }
}

impl From<TextSpan> for dashql_buffers::parser::TextSpan {
    fn from(span: TextSpan) -> Self {
        dashql_buffers::parser::TextSpan::new(span.offset, span.length)
    }
}
