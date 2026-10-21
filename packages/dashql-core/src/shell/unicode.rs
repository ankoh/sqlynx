//! Text measurement of the shell: extended grapheme clusters (`unicode-segmentation`) and terminal column widths
//! (`unicode-width`).
//!
//! Cursors move by grapheme clusters, and a cluster occupies the columns of `unicode-width`. A cluster that starts
//! with a control character (like `"\r\n"`) does not advance the cursor and has width 0. Texts that are not valid
//! UTF-8 are measured byte by byte: every byte is a cluster of width 1.

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

/// Is the text valid UTF-8?
#[inline]
pub fn is_valid(text: &[u8]) -> bool {
    std::str::from_utf8(text).is_ok()
}

/// The terminal columns of one grapheme cluster
fn cluster_width(cluster: &str) -> usize {
    if cluster.starts_with(char::is_control) {
        0
    } else {
        cluster.width()
    }
}

/// The terminal columns of a text: the sum of its cluster widths, or its byte length if it is not valid UTF-8
pub fn display_width(text: &[u8]) -> usize {
    match std::str::from_utf8(text) {
        Ok(text) => text.graphemes(true).map(cluster_width).sum(),
        Err(_) => text.len(),
    }
}

/// The grapheme clusters of a text as (begin, end) byte ranges, one byte per cluster if it is not valid UTF-8
pub fn graphemes(text: &[u8]) -> Vec<(usize, usize)> {
    match std::str::from_utf8(text) {
        Ok(text) => text.grapheme_indices(true).map(|(begin, cluster)| (begin, begin + cluster.len())).collect(),
        Err(_) => (0..text.len()).map(|begin| (begin, begin + 1)).collect(),
    }
}

/// The end of the grapheme cluster that starts at the byte offset `offset`, the text length at the end
pub fn next_grapheme(text: &str, offset: usize) -> usize {
    offset + text[offset..].graphemes(true).next().map_or(0, str::len)
}

/// The begin of the grapheme cluster that ends at the byte offset `offset`, 0 at the begin
pub fn previous_grapheme(text: &str, offset: usize) -> usize {
    offset - text[..offset].graphemes(true).next_back().map_or(0, str::len)
}

/// The begin offsets of the grapheme clusters of a text, followed by the text length
pub fn grapheme_boundaries(text: &str) -> Vec<usize> {
    text.grapheme_indices(true).map(|(begin, _)| begin).chain(std::iter::once(text.len())).collect()
}
