//! The parts of utf8proc 2.4.0 (Unicode 12.1.0, `packages/dashql-core/vendor/utf8proc`) that the
//! shell uses: grapheme cluster boundaries and render widths.
//!
//! The properties are generated from `utf8proc.data` by `tools/gen_utf8proc_tables.py`. Grapheme
//! breaks follow `grapheme_break_extended` and `utf8proc_next_grapheme`, including their emoji and
//! regional indicator bookkeeping, not the current Unicode rules.

use super::unicode_tables::{INVALID, RUNS};

const BOUNDCLASS_START: u8 = 0;
const BOUNDCLASS_OTHER: u8 = 1;
const BOUNDCLASS_CR: u8 = 2;
const BOUNDCLASS_LF: u8 = 3;
const BOUNDCLASS_CONTROL: u8 = 4;
const BOUNDCLASS_EXTEND: u8 = 5;
const BOUNDCLASS_L: u8 = 6;
const BOUNDCLASS_V: u8 = 7;
const BOUNDCLASS_T: u8 = 8;
const BOUNDCLASS_LV: u8 = 9;
const BOUNDCLASS_LVT: u8 = 10;
const BOUNDCLASS_REGIONAL_INDICATOR: u8 = 11;
const BOUNDCLASS_SPACINGMARK: u8 = 12;
const BOUNDCLASS_PREPEND: u8 = 13;
const BOUNDCLASS_ZWJ: u8 = 14;
const BOUNDCLASS_EXTENDED_PICTOGRAPHIC: u8 = 19;
const BOUNDCLASS_E_ZWG: u8 = 20;

/// The packed properties of a code point (`utf8proc_get_property`)
#[inline]
fn property(cp: i32) -> u8 {
    if !(0..0x110000).contains(&cp) {
        return INVALID;
    }
    let cp = cp as u32;
    let run = RUNS.partition_point(|&(start, _)| start <= cp) - 1;
    RUNS[run].1
}

#[inline]
fn boundclass(cp: i32) -> u8 {
    property(cp) >> 2
}

/// The render width of a code point (`utf8proc_charwidth`)
#[inline]
pub fn charwidth(cp: i32) -> usize {
    (property(cp) & 3) as usize
}

/// Decode the code point at `pos` like `utf8proc_codepoint`. Returns the code point and its size; the size of the
/// surrogate escape (which the C++ code leaves unset) is reported as 3. Bytes past the end read as 0.
fn decode(s: &[u8], pos: usize) -> (i32, usize) {
    let at = |i: usize| -> i32 { s.get(pos + i).copied().unwrap_or(0) as i32 };
    let u0 = at(0);
    if u0 <= 127 {
        return (u0, 1);
    }
    let u1 = at(1);
    if (192..=223).contains(&u0) {
        return ((u0 - 192) * 64 + (u1 - 128), 2);
    }
    if u0 == 0xed && (u1 & 0xa0) == 0xa0 {
        return (-1, 3);
    }
    let u2 = at(2);
    if (224..=239).contains(&u0) {
        return ((u0 - 224) * 4096 + (u1 - 128) * 64 + (u2 - 128), 3);
    }
    let u3 = at(3);
    if (240..=247).contains(&u0) {
        return ((u0 - 240) * 262144 + (u1 - 128) * 4096 + (u2 - 128) * 64 + (u3 - 128), 4);
    }
    (-1, 1)
}

/// `grapheme_break_simple`
fn grapheme_break_simple(lbc: u8, tbc: u8) -> bool {
    if lbc == BOUNDCLASS_START {
        return true;
    }
    if lbc == BOUNDCLASS_CR && tbc == BOUNDCLASS_LF {
        return false;
    }
    if (BOUNDCLASS_CR..=BOUNDCLASS_CONTROL).contains(&lbc) || (BOUNDCLASS_CR..=BOUNDCLASS_CONTROL).contains(&tbc) {
        return true;
    }
    if lbc == BOUNDCLASS_L && matches!(tbc, BOUNDCLASS_L | BOUNDCLASS_V | BOUNDCLASS_LV | BOUNDCLASS_LVT) {
        return false;
    }
    if matches!(lbc, BOUNDCLASS_LV | BOUNDCLASS_V) && matches!(tbc, BOUNDCLASS_V | BOUNDCLASS_T) {
        return false;
    }
    if matches!(lbc, BOUNDCLASS_LVT | BOUNDCLASS_T) && tbc == BOUNDCLASS_T {
        return false;
    }
    if matches!(tbc, BOUNDCLASS_EXTEND | BOUNDCLASS_ZWJ | BOUNDCLASS_SPACINGMARK) || lbc == BOUNDCLASS_PREPEND {
        return false;
    }
    if lbc == BOUNDCLASS_E_ZWG && tbc == BOUNDCLASS_EXTENDED_PICTOGRAPHIC {
        return false;
    }
    if lbc == BOUNDCLASS_REGIONAL_INDICATOR && tbc == BOUNDCLASS_REGIONAL_INDICATOR {
        return false;
    }
    true
}

/// `grapheme_break_extended` with a state
fn grapheme_break_extended(lbc: u8, tbc: u8, state: &mut u8) -> bool {
    let lbc_override = if *state != BOUNDCLASS_START { *state } else { lbc };
    let break_permitted = grapheme_break_simple(lbc_override, tbc);
    if *state == tbc && tbc == BOUNDCLASS_REGIONAL_INDICATOR {
        *state = BOUNDCLASS_OTHER;
    } else if *state == BOUNDCLASS_EXTENDED_PICTOGRAPHIC {
        if tbc == BOUNDCLASS_EXTEND {
            *state = BOUNDCLASS_EXTENDED_PICTOGRAPHIC;
        } else if tbc == BOUNDCLASS_ZWJ {
            *state = BOUNDCLASS_E_ZWG;
        } else {
            *state = tbc;
        }
    } else {
        *state = tbc;
    }
    break_permitted
}

/// The byte offset of the next grapheme cluster after `pos` (`Utf8Proc::NextGraphemeCluster`)
pub fn next_grapheme(s: &[u8], mut pos: usize) -> usize {
    let mut state = BOUNDCLASS_START;
    let (cp, mut size) = decode(s, pos);
    grapheme_break_extended(BOUNDCLASS_START, boundclass(cp), &mut state);
    loop {
        pos += size;
        if pos >= s.len() {
            return pos;
        }
        let (cp, next_size) = decode(s, pos);
        size = next_size;
        if grapheme_break_extended(state, boundclass(cp), &mut state) {
            return pos;
        }
    }
}

/// The byte offset of the grapheme cluster before `pos` (`Utf8Proc::PreviousGraphemeCluster`)
pub fn previous_grapheme(s: &[u8], pos: usize) -> usize {
    if !is_valid(s) {
        return pos.wrapping_sub(1);
    }
    let mut current = 0;
    loop {
        let next = next_grapheme(s, current);
        if next <= current || next >= pos {
            return current;
        }
        current = next;
    }
}

/// Is the text valid UTF-8 (`Utf8Proc::IsValid`)?
#[inline]
pub fn is_valid(s: &[u8]) -> bool {
    std::str::from_utf8(s).is_ok()
}

/// The render width of the code point at `pos` (`Utf8Proc::RenderWidth(s, pos)`)
#[inline]
pub fn render_width_at(s: &[u8], pos: usize) -> usize {
    charwidth(decode(s, pos).0)
}

/// The summed render width of all code points (`Utf8Proc::RenderWidth(str)`)
pub fn render_width(s: &[u8]) -> usize {
    let mut width = 0;
    let mut pos = 0;
    while pos < s.len() {
        let (cp, size) = decode(s, pos);
        width += charwidth(cp);
        pos += size;
    }
    width
}

/// The display width of a text: the width of the first code point of every grapheme cluster, or the byte length
/// of invalid UTF-8 (`DisplayWidth` of the shell)
pub fn display_width(s: &[u8]) -> usize {
    if !is_valid(s) {
        return s.len();
    }
    let mut width = 0;
    let mut offset = 0;
    while offset < s.len() {
        width += render_width_at(s, offset);
        let next = next_grapheme(s, offset);
        offset = if next > offset { next } else { offset + 1 };
    }
    width
}

/// The grapheme clusters of a text as (begin, end) byte ranges, one byte per cluster for invalid UTF-8
pub fn graphemes(s: &[u8]) -> Vec<(usize, usize)> {
    let valid = is_valid(s);
    let mut out = Vec::new();
    let mut offset = 0;
    while offset < s.len() {
        let mut next = offset + 1;
        if valid {
            next = next_grapheme(s, offset);
            if next <= offset {
                next = offset + 1;
            }
        }
        out.push((offset, next));
        offset = next;
    }
    out
}

/// The start offsets of the grapheme clusters of valid UTF-8 text, followed by the text length
pub fn grapheme_boundaries(s: &str) -> Vec<usize> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() + 1);
    let mut offset = 0;
    while offset < bytes.len() {
        out.push(offset);
        let next = next_grapheme(bytes, offset);
        offset = if next > offset { next } else { offset + 1 };
    }
    out.push(bytes.len());
    out
}
