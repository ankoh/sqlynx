//! A port of the md4c 0.5.2 Markdown parser (`md4c.c`, MIT license, Copyright (c) 2016-2024 Martin Mitáš).
//!
//! Only the dialect that `markdown.cc` uses is ported: `MD_DIALECT_COMMONMARK` without extension flags (no tables,
//! strikethrough, task lists, permissive autolinks, LaTeX math, wiki links or underline) in the UTF-8 build. The
//! renderer callbacks never fail, so there is no abort path.
//!
//! The port keeps the structure and the arithmetic of the C code, including its quirks, because the shape of the
//! emitted events (where text is split, which blocks are tight) ends up in the compiled document:
//!
//! - Text is cut at every resolved mark (escapes, entities, NUL bytes, span delimiters).
//! - `char` is signed: invalid UTF-8 decodes into sign-extended code points.
//! - Blocks are stored as a byte stream in C. A check for an empty list item (`md_analyze_line`) reads the last 8
//!   bytes of that stream as a block header, which may be the last line of the previous leaf block. `top_block_type`
//!   reproduces that reinterpretation.
//! - The reference definition table is a hash table with sorted collision lists searched by `bsearch`. The label
//!   hash treats newlines as whitespace while the label comparison does not, so the table is reproduced as is.

use super::unicode::*;

pub(super) type Off = u32;

/// `MD_BLOCKTYPE`, with the C values
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum BlockType {
    Doc = 0,
    Quote = 1,
    Ul = 2,
    Ol = 3,
    Li = 4,
    Hr = 5,
    H = 6,
    Code = 7,
    Html = 8,
    P = 9,
}

/// `MD_SPANTYPE`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SpanType {
    Em,
    Strong,
    A,
    Img,
    Code,
}

/// `MD_TEXTTYPE`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TextType {
    Normal,
    NullChar,
    Br,
    SoftBr,
    Entity,
    Code,
    Html,
}

/// `MD_ATTRIBUTE`: a text made of substrings of different types. `substr_offsets` has one more entry than
/// `substr_types`, the size of the text.
#[derive(Clone, Debug, Default)]
pub(super) struct Attribute {
    pub text: Vec<u8>,
    pub substr_types: Vec<TextType>,
    pub substr_offsets: Vec<Off>,
}

/// The details of an entered block
pub(super) enum BlockDetail {
    None,
    Ul { is_tight: bool },
    Ol { start: u32, is_tight: bool },
    H { level: u32 },
    /// `lang` is `None` for indented code blocks
    Code { lang: Option<Attribute> },
}

/// `MD_SPAN_A_DETAIL` and `MD_SPAN_IMG_DETAIL`
pub(super) struct LinkDetail {
    pub href: Attribute,
    pub title: Attribute,
}

/// The callbacks of `MD_PARSER`
pub(super) trait Renderer {
    fn enter_block(&mut self, block_type: BlockType, detail: BlockDetail);
    fn leave_block(&mut self, block_type: BlockType);
    /// `detail` is set for links and images
    fn enter_span(&mut self, span_type: SpanType, detail: Option<LinkDetail>);
    fn leave_span(&mut self, span_type: SpanType);
    fn text(&mut self, text_type: TextType, text: &[u8]);
}

/// Parse a document (`md_parse` with `MD_DIALECT_COMMONMARK`)
pub(super) fn parse<R: Renderer>(text: &[u8], renderer: &mut R) {
    let mut ctx = Ctx {
        text,
        size: text.len() as Off,
        r: renderer,
        ref_defs: Vec::new(),
        ref_def_hashtable: Vec::new(),
        marks: Vec::new(),
        opener_stacks: [-1; 16],
        unresolved_link_head: -1,
        unresolved_link_tail: -1,
        html_comment_horizon: 0,
        html_proc_instr_horizon: 0,
        html_decl_horizon: 0,
        html_cdata_horizon: 0,
        blocks: Vec::new(),
        lines: Vec::new(),
        has_current_block: false,
        n_block_bytes: 0,
        containers: Vec::new(),
        code_indent_offset: 4,
        code_fence_length: 0,
        html_block_type: 0,
        last_line_has_list_loosening_effect: false,
        last_list_item_starts_with_two_blank_lines: false,
        titles: Vec::new(),
    };
    ctx.process_doc();
}

// ---------------------------------------------------------------------------
// Character classification (on the signed `char` of the C code)
// ---------------------------------------------------------------------------

/// `(unsigned) ch` of a signed char
fn sext(c: u8) -> u32 {
    c as i8 as i32 as u32
}

fn is_blank(c: u8) -> bool {
    c == b' ' || c == b'\t'
}

fn is_newline(c: u8) -> bool {
    c == b'\r' || c == b'\n'
}

fn is_whitespace(c: u8) -> bool {
    is_blank(c) || c == 0x0B || c == 0x0C
}

fn is_cntrl(c: u8) -> bool {
    c <= 31 || c == 127
}

fn is_punct(c: u8) -> bool {
    matches!(c, 33..=47 | 58..=64 | 91..=96 | 123..=126)
}

fn is_ascii(c: u8) -> bool {
    c <= 127
}

/// `ISANYOF_`: never true for NUL
fn is_any_of(c: u8, palette: &[u8]) -> bool {
    c != 0 && palette.contains(&c)
}

/// `ISWHITESPACE_` on a code point
fn is_whitespace_cp(cp: u32) -> bool {
    cp == b' ' as u32 || cp == b'\t' as u32 || cp == 0x0B || cp == 0x0C
}

/// `md_unicode_bsearch__`: the index of the entry (range minimum) or -1
fn unicode_bsearch(codepoint: u32, map: &[u32]) -> i32 {
    let mut beg: i32 = 0;
    let mut end: i32 = map.len() as i32 - 1;
    while beg <= end {
        let mut pivot_beg = (beg + end) / 2;
        let mut pivot_end = pivot_beg;
        if map[pivot_end as usize] & 0x4000_0000 != 0 {
            pivot_end += 1;
        }
        if map[pivot_beg as usize] & 0x8000_0000 != 0 {
            pivot_beg -= 1;
        }
        if codepoint < (map[pivot_beg as usize] & 0x00ff_ffff) {
            end = pivot_beg - 1;
        } else if codepoint > (map[pivot_end as usize] & 0x00ff_ffff) {
            beg = pivot_end + 1;
        } else {
            return pivot_beg;
        }
    }
    -1
}

/// `md_is_unicode_whitespace__`
fn is_unicode_whitespace(cp: u32) -> bool {
    if cp <= 0x7f {
        return is_whitespace_cp(cp);
    }
    unicode_bsearch(cp, WHITESPACE_MAP) >= 0
}

/// `md_is_unicode_punct__`
fn is_unicode_punct(cp: u32) -> bool {
    if cp <= 0x7f {
        return is_punct(cp as u8);
    }
    unicode_bsearch(cp, PUNCT_MAP) >= 0
}

/// `MD_UNICODE_FOLD_INFO`
#[derive(Clone, Copy, Default)]
struct FoldInfo {
    codepoints: [u32; 3],
    n_codepoints: u32,
}

/// `md_get_unicode_fold_info`
fn unicode_fold_info(codepoint: u32) -> FoldInfo {
    let mut info = FoldInfo::default();
    if codepoint <= 0x7f {
        info.codepoints[0] = codepoint;
        if (b'A' as u32..=b'Z' as u32).contains(&codepoint) {
            info.codepoints[0] += (b'a' - b'A') as u32;
        }
        info.n_codepoints = 1;
        return info;
    }
    let maps = [(FOLD_MAP_1, FOLD_MAP_1_DATA, 1), (FOLD_MAP_2, FOLD_MAP_2_DATA, 2), (FOLD_MAP_3, FOLD_MAP_3_DATA, 3)];
    for (map, data, n) in maps {
        let index = unicode_bsearch(codepoint, map);
        if index < 0 {
            continue;
        }
        let index = index as usize;
        info.codepoints[..n].copy_from_slice(&data[index * n..index * n + n]);
        info.n_codepoints = n as u32;
        if map[index] != codepoint {
            // The mapping covers a range of code points
            if (map[index] & 0x00ff_ffff) + 1 == info.codepoints[0] {
                // Alternating type of the range
                info.codepoints[0] = codepoint + if (codepoint & 0x1) == (map[index] & 0x1) { 1 } else { 0 };
            } else {
                // Range to range kind of mapping
                info.codepoints[0] = info.codepoints[0].wrapping_add(codepoint.wrapping_sub(map[index] & 0x00ff_ffff));
            }
        }
        return info;
    }
    info.codepoints[0] = codepoint;
    info.n_codepoints = 1;
    info
}

fn is_utf8_lead1(b: u8) -> bool {
    b <= 0x7f
}
fn is_utf8_lead2(b: u8) -> bool {
    b & 0xe0 == 0xc0
}
fn is_utf8_lead3(b: u8) -> bool {
    b & 0xf0 == 0xe0
}
fn is_utf8_lead4(b: u8) -> bool {
    b & 0xf8 == 0xf0
}
fn is_utf8_tail(b: u8) -> bool {
    b & 0xc0 == 0x80
}

/// `md_decode_utf8__` of `s[off..size]`: the code point and its size
fn decode_utf8(s: &[u8], off: Off, size: Off) -> (u32, Off) {
    let at = |i: Off| -> u8 { s.get((off + i) as usize).copied().unwrap_or(0) };
    let str_size = size - off;
    let b0 = at(0);
    if !is_utf8_lead1(b0) {
        if is_utf8_lead2(b0) {
            if 1 < str_size && is_utf8_tail(at(1)) {
                return (((b0 as u32 & 0x1f) << 6) | (at(1) as u32 & 0x3f), 2);
            }
        } else if is_utf8_lead3(b0) {
            if 2 < str_size && is_utf8_tail(at(1)) && is_utf8_tail(at(2)) {
                return (((b0 as u32 & 0x0f) << 12) | ((at(1) as u32 & 0x3f) << 6) | (at(2) as u32 & 0x3f), 3);
            }
        } else if is_utf8_lead4(b0)
            && 3 < str_size
            && is_utf8_tail(at(1))
            && is_utf8_tail(at(2))
            && is_utf8_tail(at(3))
        {
            return (
                ((b0 as u32 & 0x07) << 18)
                    | ((at(1) as u32 & 0x3f) << 12)
                    | ((at(2) as u32 & 0x3f) << 6)
                    | (at(3) as u32 & 0x3f),
                4,
            );
        }
    }
    (sext(b0), 1)
}

/// `md_skip_unicode_whitespace`
fn skip_unicode_whitespace(label: &[u8], mut off: Off, size: Off) -> Off {
    while off < size {
        let (codepoint, char_size) = decode_utf8(label, off, size);
        if !is_unicode_whitespace(codepoint) && !is_newline(label[off as usize]) {
            break;
        }
        off += char_size;
    }
    off
}

// ---------------------------------------------------------------------------
// Entities and attributes
// ---------------------------------------------------------------------------

/// `md_is_hex_entity_contents`
fn is_hex_entity_contents(text: &[u8], beg: Off, max_end: Off) -> Option<Off> {
    let mut off = beg;
    while off < max_end && text[off as usize].is_ascii_hexdigit() && off - beg <= 8 {
        off += 1;
    }
    (1..=6).contains(&(off - beg)).then_some(off)
}

/// `md_is_dec_entity_contents`
fn is_dec_entity_contents(text: &[u8], beg: Off, max_end: Off) -> Option<Off> {
    let mut off = beg;
    while off < max_end && text[off as usize].is_ascii_digit() && off - beg <= 8 {
        off += 1;
    }
    (1..=7).contains(&(off - beg)).then_some(off)
}

/// `md_is_named_entity_contents`
fn is_named_entity_contents(text: &[u8], beg: Off, max_end: Off) -> Option<Off> {
    let mut off = beg;
    if off < max_end && text[off as usize].is_ascii_alphabetic() {
        off += 1;
    } else {
        return None;
    }
    while off < max_end && text[off as usize].is_ascii_alphanumeric() && off - beg <= 48 {
        off += 1;
    }
    (2..=48).contains(&(off - beg)).then_some(off)
}

/// `md_is_entity_str`: the end of an entity starting with `&` at `beg`
fn is_entity_str(text: &[u8], beg: Off, max_end: Off) -> Option<Off> {
    let off = beg + 1;
    let at = |i: Off| text[i as usize];
    let contents = if off + 2 < max_end && at(off) == b'#' && (at(off + 1) == b'x' || at(off + 1) == b'X') {
        is_hex_entity_contents(text, off + 2, max_end)
    } else if off + 1 < max_end && at(off) == b'#' {
        is_dec_entity_contents(text, off + 1, max_end)
    } else {
        is_named_entity_contents(text, off, max_end)
    };
    match contents {
        Some(off) if off < max_end && at(off) == b';' => Some(off + 1),
        _ => None,
    }
}

/// `md_build_attribute`
fn build_attribute(raw: &[u8], no_escapes: bool) -> Attribute {
    let raw_size = raw.len() as Off;
    if !raw.iter().any(|&c| c == b'\\' || c == b'&' || c == 0) {
        return Attribute {
            text: raw.to_vec(),
            substr_types: vec![TextType::Normal],
            substr_offsets: vec![0, raw_size],
        };
    }
    let mut attr = Attribute { text: Vec::with_capacity(raw.len()), ..Default::default() };
    let mut raw_off: Off = 0;
    while raw_off < raw_size {
        let c = raw[raw_off as usize];
        if c == 0 {
            attr.substr_types.push(TextType::NullChar);
            attr.substr_offsets.push(attr.text.len() as Off);
            attr.text.push(0);
            raw_off += 1;
            continue;
        }
        if c == b'&' {
            if let Some(ent_end) = is_entity_str(raw, raw_off, raw_size) {
                attr.substr_types.push(TextType::Entity);
                attr.substr_offsets.push(attr.text.len() as Off);
                attr.text.extend_from_slice(&raw[raw_off as usize..ent_end as usize]);
                raw_off = ent_end;
                continue;
            }
        }
        if attr.substr_types.last() != Some(&TextType::Normal) {
            attr.substr_types.push(TextType::Normal);
            attr.substr_offsets.push(attr.text.len() as Off);
        }
        if !no_escapes
            && c == b'\\'
            && raw_off + 1 < raw_size
            && (is_punct(raw[raw_off as usize + 1]) || is_newline(raw[raw_off as usize + 1]))
        {
            raw_off += 1;
        }
        attr.text.push(raw[raw_off as usize]);
        raw_off += 1;
    }
    attr.substr_offsets.push(attr.text.len() as Off);
    attr
}

// ---------------------------------------------------------------------------
// Reference definitions
// ---------------------------------------------------------------------------

const FNV1A_BASE: u32 = 2_166_136_261;
const FNV1A_PRIME: u32 = 16_777_619;

/// `md_fnv1a` over the bytes of code points (`unsigned`, little endian)
fn fnv1a(mut hash: u32, codepoints: &[u32]) -> u32 {
    for cp in codepoints {
        for b in cp.to_le_bytes() {
            hash ^= b as u32;
            hash = hash.wrapping_mul(FNV1A_PRIME);
        }
    }
    hash
}

/// `md_link_label_hash`
fn link_label_hash(label: &[u8]) -> u32 {
    let size = label.len() as Off;
    let mut hash = FNV1A_BASE;
    let mut off = skip_unicode_whitespace(label, 0, size);
    while off < size {
        let (codepoint, char_size) = decode_utf8(label, off, size);
        let is_ws = is_unicode_whitespace(codepoint) || is_newline(label[off as usize]);
        if is_ws {
            hash = fnv1a(hash, &[b' ' as u32]);
            off = skip_unicode_whitespace(label, off, size);
        } else {
            let fold = unicode_fold_info(codepoint);
            hash = fnv1a(hash, &fold.codepoints[..fold.n_codepoints as usize]);
            off += char_size;
        }
    }
    hash
}

/// `md_link_label_cmp_load_fold_info`
fn link_label_cmp_load_fold_info(label: &[u8], mut off: Off, size: Off, fold: &mut FoldInfo) -> Off {
    if off < size {
        let (codepoint, char_size) = decode_utf8(label, off, size);
        off += char_size;
        if !is_unicode_whitespace(codepoint) {
            *fold = unicode_fold_info(codepoint);
            return off;
        }
    }
    // Treat all whitespace (and the end of a label) as equivalent
    fold.codepoints[0] = b' ' as u32;
    fold.n_codepoints = 1;
    skip_unicode_whitespace(label, off, size)
}

/// `md_link_label_cmp`: note the reversed sign and the unsigned difference
fn link_label_cmp(a: &[u8], b: &[u8]) -> i32 {
    let (a_size, b_size) = (a.len() as Off, b.len() as Off);
    let mut a_fi = FoldInfo::default();
    let mut b_fi = FoldInfo::default();
    let mut a_fi_off = 0;
    let mut b_fi_off = 0;
    let mut a_off = skip_unicode_whitespace(a, 0, a_size);
    let mut b_off = skip_unicode_whitespace(b, 0, b_size);
    while a_off < a_size || a_fi_off < a_fi.n_codepoints || b_off < b_size || b_fi_off < b_fi.n_codepoints {
        if a_fi_off >= a_fi.n_codepoints {
            a_fi_off = 0;
            a_off = link_label_cmp_load_fold_info(a, a_off, a_size, &mut a_fi);
        }
        if b_fi_off >= b_fi.n_codepoints {
            b_fi_off = 0;
            b_off = link_label_cmp_load_fold_info(b, b_off, b_size, &mut b_fi);
        }
        let cmp = b_fi.codepoints[b_fi_off as usize].wrapping_sub(a_fi.codepoints[a_fi_off as usize]) as i32;
        if cmp != 0 {
            return cmp;
        }
        a_fi_off += 1;
        b_fi_off += 1;
    }
    0
}

/// `MD_REF_DEF`
struct RefDef {
    label: Vec<u8>,
    title: Vec<u8>,
    hash: u32,
    dest_beg: Off,
    dest_end: Off,
}

/// A bucket of the reference definition table
enum Bucket {
    Empty,
    Single(usize),
    /// Sorted by `md_ref_def_cmp_for_sort`, duplicates point to the first one
    List(Vec<usize>),
}

/// `md_ref_def_cmp`
fn ref_def_cmp(a_hash: u32, a_label: &[u8], b: &RefDef) -> i32 {
    if a_hash < b.hash {
        -1
    } else if a_hash > b.hash {
        1
    } else {
        link_label_cmp(a_label, &b.label)
    }
}

// ---------------------------------------------------------------------------
// Blocks, lines and marks
// ---------------------------------------------------------------------------

/// `MD_LINE` and `MD_VERBATIMLINE`
#[derive(Clone, Copy, Debug, Default)]
struct Line {
    beg: Off,
    end: Off,
    indent: u32,
}

/// `MD_LINETYPE`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LineType {
    Blank,
    Hr,
    AtxHeader,
    SetextUnderline,
    IndentedCode,
    FencedCode,
    Html,
    Text,
}

/// `MD_LINE_ANALYSIS`
#[derive(Clone, Copy, Debug)]
struct LineAnalysis {
    line_type: LineType,
    data: u32,
    enforce_new_block: bool,
    beg: Off,
    end: Off,
    indent: u32,
}

/// `md_dummy_blank_line`
const DUMMY_BLANK_LINE: LineAnalysis =
    LineAnalysis { line_type: LineType::Blank, data: 0, enforce_new_block: false, beg: 0, end: 0, indent: 0 };

/// The pivot line of `md_process_doc`: the dummy blank line or one of the two line buffers
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pivot {
    Dummy,
    Buffer(usize),
}

const BLOCK_CONTAINER_OPENER: u8 = 0x01;
const BLOCK_CONTAINER_CLOSER: u8 = 0x02;
const BLOCK_CONTAINER: u8 = BLOCK_CONTAINER_OPENER | BLOCK_CONTAINER_CLOSER;
const BLOCK_LOOSE_LIST: u8 = 0x04;
const BLOCK_SETEXT_HEADER: u8 = 0x08;

/// The size of `MD_BLOCK`, `MD_LINE` and `MD_VERBATIMLINE` in the C block byte stream
const SIZEOF_BLOCK: usize = 8;
const SIZEOF_LINE: usize = 8;
const SIZEOF_VERBATIMLINE: usize = 12;

/// `MD_BLOCK`. The lines of leaf blocks are `lines[lines_begin..lines_begin + n_lines]`.
#[derive(Clone, Copy, Debug)]
struct Block {
    block_type: BlockType,
    flags: u8,
    /// A 16 bit field
    data: u32,
    /// Leaf blocks: the number of lines. MD_BLOCK_OL: the start number.
    n_lines: u32,
    lines_begin: usize,
}

impl Block {
    fn has_verbatim_lines(&self) -> bool {
        self.block_type == BlockType::Code || self.block_type == BlockType::Html
    }
}

/// `MD_CONTAINER`
#[derive(Clone, Copy, Debug, Default)]
struct Container {
    ch: u8,
    is_loose: bool,
    is_task: bool,
    start: u32,
    mark_indent: u32,
    contents_indent: u32,
    /// The block of the list opener (`block_byte_off`)
    block_index: usize,
    task_mark_off: Off,
}

/// `MD_MARK`
#[derive(Clone, Copy, Debug)]
struct Mark {
    beg: Off,
    end: Off,
    prev: i32,
    next: i32,
    ch: u8,
    flags: u8,
}

const MARK_POTENTIAL_OPENER: u8 = 0x01;
const MARK_POTENTIAL_CLOSER: u8 = 0x02;
const MARK_OPENER: u8 = 0x04;
const MARK_CLOSER: u8 = 0x08;
const MARK_RESOLVED: u8 = 0x10;
const MARK_EMPH_OC: u8 = 0x20;
const MARK_EMPH_MOD3_0: u8 = 0x40;
const MARK_EMPH_MOD3_1: u8 = 0x80;
const MARK_EMPH_MOD3_2: u8 = 0x40 | 0x80;
const MARK_EMPH_MOD3_MASK: u8 = 0x40 | 0x80;
const MARK_AUTOLINK: u8 = 0x20;
const MARK_AUTOLINK_MISSING_MAILTO: u8 = 0x40;
const MARK_VALIDPERMISSIVEAUTOLINK: u8 = 0x20;
const MARK_HASNESTEDBRACKETS: u8 = 0x20;

/// The opener stack of brackets (`BRACKET_OPENERS`)
const BRACKET_OPENERS: usize = 14;

const CODESPAN_MARK_MAXLEN: usize = 32;

/// `MD_LINK_ATTR`
#[derive(Default)]
struct LinkAttr {
    dest_beg: Off,
    dest_end: Off,
    title: Vec<u8>,
}

/// `IS_MARK_CHAR` for the CommonMark dialect
fn is_mark_char(c: u8) -> bool {
    matches!(c, b'\\' | b'*' | b'_' | b'`' | b'&' | b';' | b'<' | b'>' | b'[' | b'!' | b']' | 0)
}

/// `md_lookup_line`: the line containing `off`, or the following one if `off` is in a gap
fn lookup_line(off: Off, lines: &[Line]) -> Option<usize> {
    let mut lo: i64 = 0;
    let mut hi: i64 = lines.len() as i64 - 1;
    while lo <= hi {
        let pivot = (lo + hi) / 2;
        let line = lines[pivot as usize];
        if off < line.beg {
            if hi == 0 || lines[(hi - 1) as usize].end < off {
                return Some(pivot as usize);
            }
            hi = pivot - 1;
        } else if off > line.end {
            lo = pivot + 1;
        } else {
            return Some(pivot as usize);
        }
    }
    None
}

/// The tags of HTML blocks of type 1
const HTML_TAGS_1: &[&[u8]] = &[b"pre", b"script", b"style", b"textarea"];

/// The tags of HTML blocks of type 6, by first letter
fn html_tags_6(first: u8) -> &'static [&'static [u8]] {
    match first {
        b'a' => &[b"address", b"article", b"aside"],
        b'b' => &[b"base", b"basefont", b"blockquote", b"body"],
        b'c' => &[b"caption", b"center", b"col", b"colgroup"],
        b'd' => &[b"dd", b"details", b"dialog", b"dir", b"div", b"dl", b"dt"],
        b'f' => &[b"fieldset", b"figcaption", b"figure", b"footer", b"form", b"frame", b"frameset"],
        b'h' => &[b"h1", b"h2", b"h3", b"h4", b"h5", b"h6", b"head", b"header", b"hr", b"html"],
        b'i' => &[b"iframe"],
        b'l' => &[b"legend", b"li", b"link"],
        b'm' => &[b"main", b"menu", b"menuitem"],
        b'n' => &[b"nav", b"noframes"],
        b'o' => &[b"ol", b"optgroup", b"option"],
        b'p' => &[b"p", b"param"],
        b's' => &[b"search", b"section", b"summary"],
        b't' => &[b"table", b"tbody", b"td", b"tfoot", b"th", b"thead", b"title", b"tr", b"track"],
        b'u' => &[b"ul"],
        _ => &[],
    }
}

// ---------------------------------------------------------------------------
// The parser context
// ---------------------------------------------------------------------------

/// `MD_CTX`
struct Ctx<'t, 'r, R: Renderer> {
    text: &'t [u8],
    size: Off,
    r: &'r mut R,

    ref_defs: Vec<RefDef>,
    ref_def_hashtable: Vec<Bucket>,

    marks: Vec<Mark>,
    opener_stacks: [i32; 16],
    unresolved_link_head: i32,
    unresolved_link_tail: i32,

    html_comment_horizon: Off,
    html_proc_instr_horizon: Off,
    html_decl_horizon: Off,
    html_cdata_horizon: Off,

    /// The blocks and their lines (`block_bytes`)
    blocks: Vec<Block>,
    lines: Vec<Line>,
    /// Is the last block the current block?
    has_current_block: bool,
    /// The size of the C block byte stream
    n_block_bytes: usize,

    containers: Vec<Container>,
    code_indent_offset: u32,
    code_fence_length: Off,
    html_block_type: i32,
    last_line_has_list_loosening_effect: bool,
    last_list_item_starts_with_two_blank_lines: bool,

    /// The titles of resolved links. The C code stores a title pointer in the second dummy mark after the opener,
    /// here that mark stores the index of the title in `beg`.
    titles: Vec<Vec<u8>>,
}

impl<R: Renderer> Ctx<'_, '_, R> {
    /// `CH(off)`, the C string has a NUL terminator
    fn ch(&self, off: Off) -> u8 {
        self.text.get(off as usize).copied().unwrap_or(0)
    }

    fn str(&self, beg: Off, end: Off) -> &[u8] {
        &self.text[beg as usize..end as usize]
    }

    fn decode(&self, off: Off) -> (u32, Off) {
        decode_utf8(self.text, off, self.size)
    }

    /// `md_decode_utf8_before__`
    fn decode_before(&self, off: Off) -> u32 {
        let ch = |o: Off| self.ch(o);
        let b1 = ch(off - 1);
        if !is_utf8_lead1(b1) {
            if off > 1 && is_utf8_lead2(ch(off - 2)) && is_utf8_tail(b1) {
                return ((ch(off - 2) as u32 & 0x1f) << 6) | (b1 as u32 & 0x3f);
            }
            if off > 2 && is_utf8_lead3(ch(off - 3)) && is_utf8_tail(ch(off - 2)) && is_utf8_tail(b1) {
                return ((ch(off - 3) as u32 & 0x0f) << 12) | ((ch(off - 2) as u32 & 0x3f) << 6) | (b1 as u32 & 0x3f);
            }
            if off > 3
                && is_utf8_lead4(ch(off - 4))
                && is_utf8_tail(ch(off - 3))
                && is_utf8_tail(ch(off - 2))
                && is_utf8_tail(b1)
            {
                return ((ch(off - 4) as u32 & 0x07) << 18)
                    | ((ch(off - 3) as u32 & 0x3f) << 12)
                    | ((ch(off - 2) as u32 & 0x3f) << 6)
                    | (b1 as u32 & 0x3f);
            }
        }
        sext(b1)
    }

    fn is_unicode_whitespace_at(&self, off: Off) -> bool {
        is_unicode_whitespace(self.decode(off).0)
    }

    fn is_unicode_whitespace_before(&self, off: Off) -> bool {
        is_unicode_whitespace(self.decode_before(off))
    }

    fn is_unicode_punct_at(&self, off: Off) -> bool {
        is_unicode_punct(self.decode(off).0)
    }

    fn is_unicode_punct_before(&self, off: Off) -> bool {
        is_unicode_punct(self.decode_before(off))
    }

    fn text_cb(&mut self, text_type: TextType, beg: Off, end: Off) {
        if end > beg {
            let text = self.text;
            self.r.text(text_type, &text[beg as usize..end as usize]);
        }
    }

    /// `md_merge_lines`: the text from `beg` to `end` with line breaks replaced
    fn merge_lines(&self, beg: Off, end: Off, lines: &[Line], replacement: u8) -> Vec<u8> {
        let mut out = Vec::with_capacity((end - beg) as usize);
        let mut line_index = 0;
        let mut off = beg;
        loop {
            let line = lines[line_index];
            let line_end = line.end.min(end);
            if off < line_end {
                out.extend_from_slice(self.str(off, line_end));
                off = line_end;
            }
            if off >= end {
                return out;
            }
            out.push(replacement);
            line_index += 1;
            off = lines[line_index].beg;
        }
    }

    // -----------------------------------------------------------------------
    // Raw HTML
    // -----------------------------------------------------------------------

    /// `md_is_html_tag`. Without lines (block start), the tag must end on the line.
    fn is_html_tag(&self, lines: &[Line], beg: Off, max_end: Off) -> Option<Off> {
        let mut off = beg;
        let mut line_end = if lines.is_empty() { self.size } else { lines[0].end };
        let mut line_index = 0;

        if off + 1 >= line_end {
            return None;
        }
        off += 1;

        // -1: no attributes allowed, 0: attribute could follow after whitespace, 1: after whitespace, 2: after
        // attribute name, 3: after '=', 41/42/43: in an unquoted, single-quoted or double-quoted value
        let mut attr_state: i32 = 0;
        if self.ch(off) == b'/' {
            attr_state = -1;
            off += 1;
        }

        // Tag name
        if off >= line_end || !self.ch(off).is_ascii_alphabetic() {
            return None;
        }
        off += 1;
        while off < line_end && (self.ch(off).is_ascii_alphanumeric() || self.ch(off) == b'-') {
            off += 1;
        }

        loop {
            while off < line_end && !is_newline(self.ch(off)) {
                let c = self.ch(off);
                if attr_state > 40 {
                    if attr_state == 41 && (is_blank(c) || is_any_of(c, b"\"'=<>`")) {
                        attr_state = 0;
                        off -= 1; // Put the char back for re-inspection in the new state
                    } else if (attr_state == 42 && c == b'\'') || (attr_state == 43 && c == b'"') {
                        attr_state = 0;
                    }
                    off += 1;
                } else if is_whitespace(c) {
                    if attr_state == 0 {
                        attr_state = 1;
                    }
                    off += 1;
                } else if attr_state <= 2 && c == b'>' {
                    return (off < max_end).then_some(off + 1);
                } else if attr_state <= 2 && c == b'/' && off + 1 < line_end && self.ch(off + 1) == b'>' {
                    off += 1;
                    return (off < max_end).then_some(off + 1);
                } else if (attr_state == 1 || attr_state == 2) && (c.is_ascii_alphabetic() || c == b'_' || c == b':')
                {
                    off += 1;
                    while off < line_end && (self.ch(off).is_ascii_alphanumeric() || is_any_of(self.ch(off), b"_.:-")) {
                        off += 1;
                    }
                    attr_state = 2;
                } else if attr_state == 2 && c == b'=' {
                    off += 1;
                    attr_state = 3;
                } else if attr_state == 3 {
                    if c == b'"' {
                        attr_state = 43;
                    } else if c == b'\'' {
                        attr_state = 42;
                    } else if !is_any_of(c, b"\"'=<>`") && !is_newline(c) {
                        attr_state = 41;
                    } else {
                        return None;
                    }
                    off += 1;
                } else {
                    return None;
                }
            }

            // Block start conditions must be on a single line
            if lines.is_empty() {
                return None;
            }
            line_index += 1;
            if line_index >= lines.len() {
                return None;
            }
            off = lines[line_index].beg;
            line_end = lines[line_index].end;
            if attr_state == 0 || attr_state == 41 {
                attr_state = 1;
            }
            if off >= max_end {
                return None;
            }
        }
    }

    /// `md_scan_for_html_closer`
    fn scan_for_html_closer(
        &self,
        closer: &[u8],
        lines: &[Line],
        beg: Off,
        max_end: Off,
        horizon: &mut Off,
    ) -> Option<Off> {
        let len = closer.len() as Off;
        let mut off = beg;
        let mut line_index = 0;
        if off < *horizon && *horizon >= max_end.wrapping_sub(len) {
            // Already scanned up to max_end
            return None;
        }
        loop {
            while off + len <= lines[line_index].end && off + len <= max_end {
                if self.str(off, off + len) == closer {
                    return Some(off + len);
                }
                off += 1;
            }
            line_index += 1;
            if off >= max_end || line_index >= lines.len() {
                *horizon = off;
                return None;
            }
            off = lines[line_index].beg;
        }
    }

    /// `md_is_html_comment`
    fn is_html_comment(&mut self, lines: &[Line], beg: Off, max_end: Off) -> Option<Off> {
        if beg + 4 >= lines[0].end {
            return None;
        }
        if self.ch(beg + 1) != b'!' || self.ch(beg + 2) != b'-' || self.ch(beg + 3) != b'-' {
            return None;
        }
        // Skip only "<!" so that "<!-->" and "<!--->" are accepted
        let mut horizon = self.html_comment_horizon;
        let result = self.scan_for_html_closer(b"-->", lines, beg + 2, max_end, &mut horizon);
        self.html_comment_horizon = horizon;
        result
    }

    /// `md_is_html_processing_instruction`
    fn is_html_processing_instruction(&mut self, lines: &[Line], beg: Off, max_end: Off) -> Option<Off> {
        if beg + 2 >= lines[0].end || self.ch(beg + 1) != b'?' {
            return None;
        }
        let mut horizon = self.html_proc_instr_horizon;
        let result = self.scan_for_html_closer(b"?>", lines, beg + 2, max_end, &mut horizon);
        self.html_proc_instr_horizon = horizon;
        result
    }

    /// `md_is_html_declaration`
    fn is_html_declaration(&mut self, lines: &[Line], beg: Off, max_end: Off) -> Option<Off> {
        if beg + 2 >= lines[0].end || self.ch(beg + 1) != b'!' {
            return None;
        }
        let mut off = beg + 2;
        // Declaration name
        if off >= lines[0].end || !self.ch(off).is_ascii_alphabetic() {
            return None;
        }
        off += 1;
        while off < lines[0].end && self.ch(off).is_ascii_alphabetic() {
            off += 1;
        }
        let mut horizon = self.html_decl_horizon;
        let result = self.scan_for_html_closer(b">", lines, off, max_end, &mut horizon);
        self.html_decl_horizon = horizon;
        result
    }

    /// `md_is_html_cdata`
    fn is_html_cdata(&mut self, lines: &[Line], beg: Off, max_end: Off) -> Option<Off> {
        const OPEN: &[u8] = b"<![CDATA[";
        let open_size = OPEN.len() as Off;
        if beg + open_size >= lines[0].end || self.str(beg, beg + open_size) != OPEN {
            return None;
        }
        let mut horizon = self.html_cdata_horizon;
        let result = self.scan_for_html_closer(b"]]>", lines, beg + open_size, max_end, &mut horizon);
        self.html_cdata_horizon = horizon;
        result
    }

    /// `md_is_html_any`
    fn is_html_any(&mut self, lines: &[Line], beg: Off, max_end: Off) -> Option<Off> {
        if let Some(end) = self.is_html_tag(lines, beg, max_end) {
            return Some(end);
        }
        if let Some(end) = self.is_html_comment(lines, beg, max_end) {
            return Some(end);
        }
        if let Some(end) = self.is_html_processing_instruction(lines, beg, max_end) {
            return Some(end);
        }
        if let Some(end) = self.is_html_declaration(lines, beg, max_end) {
            return Some(end);
        }
        self.is_html_cdata(lines, beg, max_end)
    }

    // -----------------------------------------------------------------------
    // Links and reference definitions
    // -----------------------------------------------------------------------

    /// `md_is_link_label`: (end, contents line index, end line index, contents begin, contents end)
    fn is_link_label(&self, lines: &[Line], beg: Off) -> Option<(Off, usize, usize, Off, Off)> {
        let mut off = beg;
        let mut contents_beg = 0;
        let mut contents_end = 0;
        let mut beg_line_index = 0;
        let mut line_index = 0;
        let mut len = 0;

        if self.ch(off) != b'[' {
            return None;
        }
        off += 1;

        loop {
            let line_end = lines[line_index].end;
            while off < line_end {
                let c = self.ch(off);
                if c == b'\\' && off + 1 < self.size && (is_punct(self.ch(off + 1)) || is_newline(self.ch(off + 1))) {
                    if contents_end == 0 {
                        contents_beg = off;
                        beg_line_index = line_index;
                    }
                    contents_end = off + 2;
                    off += 2;
                } else if c == b'[' {
                    return None;
                } else if c == b']' {
                    if contents_beg < contents_end {
                        return Some((off + 1, beg_line_index, line_index, contents_beg, contents_end));
                    }
                    // A link label must have some non-whitespace contents
                    return None;
                } else {
                    let (codepoint, char_size) = self.decode(off);
                    if !is_unicode_whitespace(codepoint) {
                        if contents_end == 0 {
                            contents_beg = off;
                            beg_line_index = line_index;
                        }
                        contents_end = off + char_size;
                    }
                    off += char_size;
                }
                len += 1;
                if len > 999 {
                    return None;
                }
            }
            line_index += 1;
            len += 1;
            if line_index < lines.len() {
                off = lines[line_index].beg;
            } else {
                return None;
            }
        }
    }

    /// `md_is_link_destination_A`: `<...>`
    fn is_link_destination_a(&self, beg: Off, max_end: Off) -> Option<(Off, Off, Off)> {
        let mut off = beg;
        if off >= max_end || self.ch(off) != b'<' {
            return None;
        }
        off += 1;
        while off < max_end {
            if self.ch(off) == b'\\' && off + 1 < max_end && is_punct(self.ch(off + 1)) {
                off += 2;
                continue;
            }
            if is_newline(self.ch(off)) || self.ch(off) == b'<' {
                return None;
            }
            if self.ch(off) == b'>' {
                return Some((off + 1, beg + 1, off));
            }
            off += 1;
        }
        None
    }

    /// `md_is_link_destination_B`: balanced parentheses, no whitespace
    fn is_link_destination_b(&self, beg: Off, max_end: Off) -> Option<(Off, Off, Off)> {
        let mut off = beg;
        let mut parenthesis_level = 0;
        while off < max_end {
            if self.ch(off) == b'\\' && off + 1 < max_end && is_punct(self.ch(off + 1)) {
                off += 2;
                continue;
            }
            if is_whitespace(self.ch(off)) || is_cntrl(self.ch(off)) {
                break;
            }
            if self.ch(off) == b'(' {
                parenthesis_level += 1;
                if parenthesis_level > 32 {
                    return None;
                }
            } else if self.ch(off) == b')' {
                if parenthesis_level == 0 {
                    break;
                }
                parenthesis_level -= 1;
            }
            off += 1;
        }
        if parenthesis_level != 0 || off == beg {
            return None;
        }
        Some((off, beg, off))
    }

    /// `md_is_link_destination`: (end, contents begin, contents end)
    fn is_link_destination(&self, beg: Off, max_end: Off) -> Option<(Off, Off, Off)> {
        if self.ch(beg) == b'<' {
            self.is_link_destination_a(beg, max_end)
        } else {
            self.is_link_destination_b(beg, max_end)
        }
    }

    /// `md_is_link_title`: (end, contents line index, end line index, contents begin, contents end)
    fn is_link_title(&self, lines: &[Line], beg: Off) -> Option<(Off, usize, usize, Off, Off)> {
        let mut off = beg;
        let mut line_index = 0;

        // White space with up to one line break
        while off < lines[line_index].end && is_whitespace(self.ch(off)) {
            off += 1;
        }
        if off >= lines[line_index].end {
            line_index += 1;
            if line_index >= lines.len() {
                return None;
            }
            off = lines[line_index].beg;
        }
        if off == beg {
            return None;
        }
        let beg_line_index = line_index;

        // The first char determines how to detect the end
        let closer = match self.ch(off) {
            b'"' => b'"',
            b'\'' => b'\'',
            b'(' => b')',
            _ => return None,
        };
        off += 1;
        let contents_beg = off;

        // Note that `off` is not moved to the start of the next line
        while line_index < lines.len() {
            let line_end = lines[line_index].end;
            while off < line_end {
                let c = self.ch(off);
                if c == b'\\' && off + 1 < self.size && (is_punct(self.ch(off + 1)) || is_newline(self.ch(off + 1))) {
                    off += 1;
                } else if c == closer {
                    return Some((off + 1, beg_line_index, line_index, contents_beg, off));
                } else if closer == b')' && c == b'(' {
                    // A ()-style title cannot contain an unescaped '('
                    return None;
                }
                off += 1;
            }
            line_index += 1;
        }
        None
    }

    /// `md_is_link_reference_definition`: the number of lines of a definition at the start of `lines`, 0 if there
    /// is none
    fn is_link_reference_definition(&mut self, lines: &[Line]) -> usize {
        // Link label
        let Some((mut off, label_line_index, mut line_index, label_beg, label_end)) =
            self.is_link_label(lines, lines[0].beg)
        else {
            return 0;
        };
        let label_is_multiline = label_line_index != line_index;

        // Colon
        if off >= lines[line_index].end || self.ch(off) != b':' {
            return 0;
        }
        off += 1;

        // Optional white space with up to one line break
        while off < lines[line_index].end && is_whitespace(self.ch(off)) {
            off += 1;
        }
        if off >= lines[line_index].end {
            line_index += 1;
            if line_index >= lines.len() {
                return 0;
            }
            off = lines[line_index].beg;
        }

        // Link destination
        let Some((end, dest_beg, dest_end)) = self.is_link_destination(off, lines[line_index].end) else {
            return 0;
        };
        off = end;

        // An optional title, only if nothing more follows on its last line. The end of a title is taken over even
        // if something follows.
        let title_is_multiline;
        let (title_beg, title_end, title_line_index);
        match self.is_link_title(&lines[line_index..], off) {
            Some((end, beg_line, end_line, contents_beg, contents_end)) => {
                off = end;
                if off >= lines[line_index + end_line].end {
                    title_is_multiline = end_line != beg_line;
                    title_line_index = beg_line + line_index;
                    line_index += end_line;
                    (title_beg, title_end) = (contents_beg, contents_end);
                } else {
                    title_is_multiline = false;
                    (title_beg, title_end, title_line_index) = (off, off, 0);
                }
            }
            None => {
                title_is_multiline = false;
                (title_beg, title_end, title_line_index) = (off, off, 0);
            }
        }

        // Nothing more can follow on the last line
        if off < lines[line_index].end {
            return 0;
        }

        let label = if label_is_multiline {
            self.merge_lines(label_beg, label_end, &lines[label_line_index..], b' ')
        } else {
            self.str(label_beg, label_end).to_vec()
        };
        let title = if title_is_multiline {
            self.merge_lines(title_beg, title_end, &lines[title_line_index..], b'\n')
        } else {
            self.str(title_beg, title_end).to_vec()
        };
        self.ref_defs.push(RefDef { label, title, hash: 0, dest_beg, dest_end });
        line_index + 1
    }

    /// `md_build_ref_def_hashtable`
    fn build_ref_def_hashtable(&mut self) {
        let n = self.ref_defs.len();
        if n == 0 {
            return;
        }
        let size = n * 5 / 4;
        let mut table: Vec<Bucket> = (0..size).map(|_| Bucket::Empty).collect();
        for i in 0..n {
            let hash = link_label_hash(&self.ref_defs[i].label);
            self.ref_defs[i].hash = hash;
            let bucket = &mut table[hash as usize % size];
            match bucket {
                Bucket::Empty => *bucket = Bucket::Single(i),
                Bucket::Single(old) => {
                    // A duplicate label is ignored, a different one makes the bucket a list
                    if link_label_cmp(&self.ref_defs[i].label, &self.ref_defs[*old].label) != 0 {
                        *bucket = Bucket::List(vec![*old, i]);
                    }
                }
                // Duplicates in lists are handled after sorting
                Bucket::List(list) => list.push(i),
            }
        }
        // Sort the lists for the binary search and point duplicates to the first definition
        let defs = &self.ref_defs;
        for bucket in &mut table {
            let Bucket::List(list) = bucket else {
                continue;
            };
            list.sort_by(|&a, &b| {
                let cmp = ref_def_cmp(defs[a].hash, &defs[a].label, &defs[b]);
                if cmp != 0 {
                    return cmp.cmp(&0);
                }
                a.cmp(&b)
            });
            for j in 1..list.len() {
                if ref_def_cmp(defs[list[j - 1]].hash, &defs[list[j - 1]].label, &defs[list[j]]) == 0 {
                    list[j] = list[j - 1];
                }
            }
        }
        self.ref_def_hashtable = table;
    }

    /// `md_lookup_ref_def`
    fn lookup_ref_def(&self, label: &[u8]) -> Option<&RefDef> {
        let size = self.ref_def_hashtable.len();
        if size == 0 {
            return None;
        }
        let hash = link_label_hash(label);
        match &self.ref_def_hashtable[hash as usize % size] {
            Bucket::Empty => None,
            Bucket::Single(def) => {
                let def = &self.ref_defs[*def];
                (link_label_cmp(&def.label, label) == 0).then_some(def)
            }
            Bucket::List(list) => {
                // glibc bsearch
                let (mut l, mut u) = (0, list.len());
                while l < u {
                    let idx = (l + u) / 2;
                    let cmp = ref_def_cmp(hash, label, &self.ref_defs[list[idx]]);
                    if cmp < 0 {
                        u = idx;
                    } else if cmp > 0 {
                        l = idx + 1;
                    } else {
                        return Some(&self.ref_defs[list[idx]]);
                    }
                }
                None
            }
        }
    }

    /// `md_is_link_reference`: resolve `[label]` (or `![label]`) between `beg` and `end`
    fn is_link_reference(&self, lines: &[Line], mut beg: Off, mut end: Off, attr: &mut LinkAttr) -> bool {
        beg += if self.ch(beg) == b'!' { 2 } else { 1 };
        end -= 1;

        let Some(beg_line) = lookup_line(beg, lines) else {
            return false;
        };
        let is_multiline = end > lines[beg_line].end;
        let merged;
        let label = if is_multiline {
            merged = self.merge_lines(beg, end, &lines[beg_line..], b' ');
            &merged[..]
        } else {
            self.str(beg, end)
        };
        match self.lookup_ref_def(label) {
            Some(def) => {
                attr.dest_beg = def.dest_beg;
                attr.dest_end = def.dest_end;
                attr.title = def.title.clone();
                true
            }
            None => false,
        }
    }

    /// `md_is_inline_link_spec`: `(destination "title")` at `beg`
    fn is_inline_link_spec(&self, lines: &[Line], beg: Off, attr: &mut LinkAttr) -> Option<Off> {
        let mut line_index = 0;
        let mut off = beg;
        while off >= lines[line_index].end {
            line_index += 1;
        }
        off += 1; // '('

        // Optional white space with up to one line break
        while off < lines[line_index].end && is_whitespace(self.ch(off)) {
            off += 1;
        }
        if off >= lines[line_index].end && (off >= self.size || is_newline(self.ch(off))) {
            line_index += 1;
            if line_index >= lines.len() {
                return None;
            }
            off = lines[line_index].beg;
        }

        // The destination may be omitted, but only without a title
        if off < self.size && self.ch(off) == b')' {
            attr.dest_beg = off;
            attr.dest_end = off;
            attr.title.clear();
            return Some(off + 1);
        }

        // Link destination
        let (end, dest_beg, dest_end) = self.is_link_destination(off, lines[line_index].end)?;
        off = end;
        attr.dest_beg = dest_beg;
        attr.dest_end = dest_end;

        // Optional title
        let (title_beg, title_end, title_line_index, title_is_multiline) =
            match self.is_link_title(&lines[line_index..], off) {
                Some((end, beg_line, end_line, contents_beg, contents_end)) => {
                    off = end;
                    let title_line_index = beg_line + line_index;
                    let multiline = end_line != beg_line;
                    line_index += end_line;
                    (contents_beg, contents_end, title_line_index, multiline)
                }
                None => (off, off, 0, false),
            };

        // Optional whitespace followed by the final ')'
        while off < lines[line_index].end && is_whitespace(self.ch(off)) {
            off += 1;
        }
        if off >= lines[line_index].end {
            line_index += 1;
            if line_index >= lines.len() {
                return None;
            }
            off = lines[line_index].beg;
        }
        if self.ch(off) != b')' {
            return None;
        }
        off += 1;

        attr.title = if title_beg >= title_end {
            Vec::new()
        } else if !title_is_multiline {
            self.str(title_beg, title_end).to_vec()
        } else {
            self.merge_lines(title_beg, title_end, &lines[title_line_index..], b'\n')
        };
        Some(off)
    }

    // -----------------------------------------------------------------------
    // Inline marks
    // -----------------------------------------------------------------------

    fn add_mark(&mut self, ch: u8, beg: Off, end: Off, flags: u8) {
        self.marks.push(Mark { beg, end, prev: -1, next: -1, ch, flags });
    }

    /// `md_emph_stack`
    fn emph_stack(ch: u8, flags: u8) -> usize {
        let mut stack = if ch == b'*' { 0 } else { 6 };
        if flags & MARK_EMPH_OC != 0 {
            stack += 3;
        }
        stack
            + match flags & MARK_EMPH_MOD3_MASK {
                MARK_EMPH_MOD3_0 => 0,
                MARK_EMPH_MOD3_1 => 1,
                _ => 2,
            }
    }

    /// `md_opener_stack`
    fn opener_stack(&self, mark_index: usize) -> usize {
        let mark = self.marks[mark_index];
        match mark.ch {
            b'*' | b'_' => Self::emph_stack(mark.ch, mark.flags),
            _ => BRACKET_OPENERS,
        }
    }

    fn mark_stack_push(&mut self, stack: usize, mark_index: usize) {
        self.marks[mark_index].next = self.opener_stacks[stack];
        self.opener_stacks[stack] = mark_index as i32;
    }

    fn mark_stack_pop(&mut self, stack: usize) -> i32 {
        let top = self.opener_stacks[stack];
        if top >= 0 {
            self.opener_stacks[stack] = self.marks[top as usize].next;
        }
        top
    }

    /// `md_resolve_range`
    fn resolve_range(&mut self, opener_index: usize, closer_index: usize) {
        self.marks[opener_index].next = closer_index as i32;
        self.marks[closer_index].prev = opener_index as i32;
        self.marks[opener_index].flags |= MARK_OPENER | MARK_RESOLVED;
        self.marks[closer_index].flags |= MARK_CLOSER | MARK_RESOLVED;
    }

    /// `md_rollback` with `MD_ROLLBACK_CROSSING`: discard pending openers from `opener_index` on
    fn rollback_crossing(&mut self, opener_index: usize) {
        for stack in 0..self.opener_stacks.len() {
            while self.opener_stacks[stack] >= opener_index as i32 {
                self.mark_stack_pop(stack);
            }
        }
    }

    /// `md_is_code_span`: (is code span, opener, closer). The end of the opener is set even on failure.
    fn is_code_span(
        &self,
        lines: &[Line],
        beg: Off,
        last_potential_closers: &mut [Off; CODESPAN_MARK_MAXLEN],
        reached_paragraph_end: &mut bool,
    ) -> (bool, Mark, Mark) {
        let mut opener = Mark { beg, end: beg, prev: -1, next: -1, ch: b'`', flags: 0 };
        let mut closer = opener;
        let opener_beg = beg;
        let mut line_end = lines[0].end;
        let mut opener_end = opener_beg;
        while opener_end < line_end && self.ch(opener_end) == b'`' {
            opener_end += 1;
        }
        let has_space_after_opener = opener_end < line_end && self.ch(opener_end) == b' ';
        let has_eol_after_opener = opener_end == line_end;

        // The caller needs to know the end of the opening mark even if we fail
        opener.end = opener_end;

        let mark_len = (opener_end - opener_beg) as usize;
        if mark_len > CODESPAN_MARK_MAXLEN {
            return (false, opener, closer);
        }

        // There is no closer of this length, rescanning makes no sense (md4c issue #59)
        if last_potential_closers[mark_len - 1] >= lines[lines.len() - 1].end
            || (*reached_paragraph_end && last_potential_closers[mark_len - 1] < opener_end)
        {
            return (false, opener, closer);
        }

        let mut closer_beg = opener_end;
        let mut closer_end;
        let mut has_only_space = true;
        let mut line_index = 0;
        let has_space_before_closer;
        let has_eol_before_closer;

        // Find the closer mark
        loop {
            while closer_beg < line_end && self.ch(closer_beg) != b'`' {
                if self.ch(closer_beg) != b' ' {
                    has_only_space = false;
                }
                closer_beg += 1;
            }
            closer_end = closer_beg;
            while closer_end < line_end && self.ch(closer_end) == b'`' {
                closer_end += 1;
            }

            if (closer_end - closer_beg) as usize == mark_len {
                has_space_before_closer = closer_beg > lines[line_index].beg && self.ch(closer_beg - 1) == b' ';
                has_eol_before_closer = closer_beg == lines[line_index].beg;
                break;
            }

            if closer_end > closer_beg {
                // A backtick sequence that is not the closer. Remember it as potential closer of its own length.
                has_only_space = false;
                let len = (closer_end - closer_beg) as usize;
                if len < CODESPAN_MARK_MAXLEN && closer_beg > last_potential_closers[len - 1] {
                    last_potential_closers[len - 1] = closer_beg;
                }
            }

            if closer_end >= line_end {
                line_index += 1;
                if line_index >= lines.len() {
                    *reached_paragraph_end = true;
                    return (false, opener, closer);
                }
                line_end = lines[line_index].end;
                closer_beg = lines[line_index].beg;
            } else {
                closer_beg = closer_end;
            }
        }

        // With a space or a line break both after the opener and before the closer (and unless the code span is
        // made of spaces only), one leading and one trailing space belong to the marks
        if !has_only_space
            && (has_space_after_opener || has_eol_after_opener)
            && (has_space_before_closer || has_eol_before_closer)
        {
            if has_space_after_opener {
                opener_end += 1;
            } else {
                opener_end = lines[1].beg;
            }
            if has_space_before_closer {
                closer_beg -= 1;
            } else {
                // Go back to the end of the previous line, but restore any trailing whitespace
                closer_beg = lines[line_index - 1].end;
                while closer_beg < self.size && is_blank(self.ch(closer_beg)) {
                    closer_beg += 1;
                }
            }
        }

        opener.beg = opener_beg;
        opener.end = opener_end;
        opener.flags = MARK_POTENTIAL_OPENER;
        closer.beg = closer_beg;
        closer.end = closer_end;
        closer.flags = MARK_POTENTIAL_CLOSER;
        (true, opener, closer)
    }

    /// `md_is_autolink_uri`
    fn is_autolink_uri(&self, beg: Off, max_end: Off) -> Option<Off> {
        let mut off = beg + 1;
        // Scheme
        if off >= max_end || !is_ascii(self.ch(off)) {
            return None;
        }
        off += 1;
        loop {
            if off >= max_end || off - beg > 32 {
                return None;
            }
            let c = self.ch(off);
            if c == b':' && off - beg >= 3 {
                break;
            }
            if !c.is_ascii_alphanumeric() && c != b'+' && c != b'-' && c != b'.' {
                return None;
            }
            off += 1;
        }
        // Path after the scheme
        while off < max_end && self.ch(off) != b'>' {
            let c = self.ch(off);
            if is_whitespace(c) || is_cntrl(c) || c == b'<' {
                return None;
            }
            off += 1;
        }
        if off >= max_end {
            return None;
        }
        Some(off + 1)
    }

    /// `md_is_autolink_email`
    fn is_autolink_email(&self, beg: Off, max_end: Off) -> Option<Off> {
        let mut off = beg + 1;
        // Username (before '@')
        let is_username = |c: u8| c.is_ascii_alphanumeric() || is_any_of(c, b".!#$%&'*+/=?^_`{|}~-");
        while off < max_end && is_username(self.ch(off)) {
            off += 1;
        }
        if off <= beg + 1 {
            return None;
        }
        // '@'
        if off >= max_end || self.ch(off) != b'@' {
            return None;
        }
        off += 1;
        // Labels delimited with '.' of 1-63 alphanumerics or '-', but '-' is not allowed first or last
        let mut label_len = 0;
        while off < max_end {
            let c = self.ch(off);
            if c.is_ascii_alphanumeric() {
                label_len += 1;
            } else if c == b'-' && label_len > 0 {
                label_len += 1;
            } else if c == b'.' && label_len > 0 && self.ch(off - 1) != b'-' {
                label_len = 0;
            } else {
                break;
            }
            if label_len > 63 {
                return None;
            }
            off += 1;
        }
        if label_len <= 0 || off >= max_end || self.ch(off) != b'>' || self.ch(off - 1) == b'-' {
            return None;
        }
        Some(off + 1)
    }

    /// `md_is_autolink`: (end, missing mailto)
    fn is_autolink(&self, beg: Off, max_end: Off) -> Option<(Off, bool)> {
        if let Some(end) = self.is_autolink_uri(beg, max_end) {
            return Some((end, false));
        }
        self.is_autolink_email(beg, max_end).map(|end| (end, true))
    }

    /// `md_collect_marks`
    fn collect_marks(&mut self, lines: &[Line]) {
        let mut codespan_last_potential_closers = [0 as Off; CODESPAN_MARK_MAXLEN];
        let mut codespan_scanned_till_paragraph_end = false;
        let n_lines = lines.len();

        let mut line_index = 0;
        while line_index < n_lines {
            let mut line = lines[line_index];
            let mut off = line.beg;
            loop {
                while off < line.end && !is_mark_char(self.ch(off)) {
                    off += 1;
                }
                if off >= line.end {
                    break;
                }
                let ch = self.ch(off);

                // A backslash escape. It can go beyond the line end, an escaped line break is a hard break.
                if ch == b'\\' && off + 1 < self.size && (is_punct(self.ch(off + 1)) || is_newline(self.ch(off + 1)))
                {
                    // A hard break cannot be on the last line of the block
                    if !is_newline(self.ch(off + 1)) || line_index + 1 < n_lines {
                        self.add_mark(ch, off, off + 2, MARK_RESOLVED);
                    }
                    off += 2;
                    continue;
                }

                // A potential (strong) emphasis start or end
                if ch == b'*' || ch == b'_' {
                    let mut tmp = off + 1;
                    while tmp < line.end && self.ch(tmp) == ch {
                        tmp += 1;
                    }
                    // What precedes and what follows: 0 = whitespace, 1 = punctuation, 2 = other
                    let mut left_level = if off == line.beg || self.is_unicode_whitespace_before(off) {
                        0
                    } else if self.is_unicode_punct_before(off) {
                        1
                    } else {
                        2
                    };
                    let mut right_level = if tmp == line.end || self.is_unicode_whitespace_at(tmp) {
                        0
                    } else if self.is_unicode_punct_at(tmp) {
                        1
                    } else {
                        2
                    };
                    // An intra-word underscore has no special meaning
                    if ch == b'_' && left_level == 2 && right_level == 2 {
                        left_level = 0;
                        right_level = 0;
                    }
                    if left_level != 0 || right_level != 0 {
                        let mut flags = 0;
                        if left_level > 0 && left_level >= right_level {
                            flags |= MARK_POTENTIAL_CLOSER;
                        }
                        if right_level > 0 && right_level >= left_level {
                            flags |= MARK_POTENTIAL_OPENER;
                        }
                        if flags == (MARK_POTENTIAL_OPENER | MARK_POTENTIAL_CLOSER) {
                            flags |= MARK_EMPH_OC;
                        }
                        // The rule of three needs the original size of the mark modulo three
                        flags |= match (tmp - off) % 3 {
                            0 => MARK_EMPH_MOD3_0,
                            1 => MARK_EMPH_MOD3_1,
                            _ => MARK_EMPH_MOD3_2,
                        };
                        self.add_mark(ch, off, tmp, flags);
                        // Dummy marks reserve space for splitting the mark when resolving
                        off += 1;
                        while off < tmp {
                            self.add_mark(b'D', off, off, 0);
                            off += 1;
                        }
                        continue;
                    }
                    off = tmp;
                    continue;
                }

                // A potential code span start or end
                if ch == b'`' {
                    let (is_code_span, opener, closer) = self.is_code_span(
                        &lines[line_index..],
                        off,
                        &mut codespan_last_potential_closers,
                        &mut codespan_scanned_till_paragraph_end,
                    );
                    if is_code_span {
                        self.add_mark(opener.ch, opener.beg, opener.end, opener.flags);
                        self.add_mark(closer.ch, closer.beg, closer.end, closer.flags);
                        let n = self.marks.len();
                        self.resolve_range(n - 2, n - 1);
                        off = closer.end;
                        // Advance the current line accordingly
                        if off > line.end {
                            line_index = lookup_line(off, lines).expect("code span ends in the block");
                            line = lines[line_index];
                        }
                        continue;
                    }
                    off = opener.end;
                    continue;
                }

                // A potential entity start
                if ch == b'&' {
                    self.add_mark(ch, off, off + 1, MARK_POTENTIAL_OPENER);
                    off += 1;
                    continue;
                }

                // A potential entity end, only right after an entity start
                if ch == b';' {
                    if self.marks.last().is_some_and(|m| m.ch == b'&') {
                        self.add_mark(ch, off, off + 1, MARK_POTENTIAL_CLOSER);
                    }
                    off += 1;
                    continue;
                }

                // A potential autolink or raw HTML start or end
                if ch == b'<' {
                    let max_end = lines[n_lines - 1].end;
                    if let Some(html_end) = self.is_html_any(&lines[line_index..], off, max_end) {
                        self.add_mark(b'<', off, off, MARK_OPENER | MARK_RESOLVED);
                        self.add_mark(b'>', html_end, html_end, MARK_CLOSER | MARK_RESOLVED);
                        let n = self.marks.len();
                        self.marks[n - 2].next = (n - 1) as i32;
                        self.marks[n - 1].prev = (n - 2) as i32;
                        off = html_end;
                        // Advance the current line accordingly
                        if off > line.end {
                            line_index = lookup_line(off, lines).expect("raw HTML ends in the block");
                            line = lines[line_index];
                        }
                        continue;
                    }
                    if let Some((autolink_end, missing_mailto)) = self.is_autolink(off, max_end) {
                        let mut flags = MARK_RESOLVED | MARK_AUTOLINK;
                        if missing_mailto {
                            flags |= MARK_AUTOLINK_MISSING_MAILTO;
                        }
                        self.add_mark(b'<', off, off + 1, MARK_OPENER | flags);
                        self.add_mark(b'>', autolink_end - 1, autolink_end, MARK_CLOSER | flags);
                        let n = self.marks.len();
                        self.marks[n - 2].next = (n - 1) as i32;
                        self.marks[n - 1].prev = (n - 2) as i32;
                        off = autolink_end;
                        continue;
                    }
                    off += 1;
                    continue;
                }

                // A potential link or a part of it
                if ch == b'[' || (ch == b'!' && off + 1 < line.end && self.ch(off + 1) == b'[') {
                    let tmp = if ch == b'[' { off + 1 } else { off + 2 };
                    self.add_mark(ch, off, tmp, MARK_POTENTIAL_OPENER);
                    off = tmp;
                    // Two dummies to make space for the data of a link
                    self.add_mark(b'D', off, off, 0);
                    self.add_mark(b'D', off, off, 0);
                    continue;
                }
                if ch == b']' {
                    self.add_mark(ch, off, off + 1, MARK_POTENTIAL_CLOSER);
                    off += 1;
                    continue;
                }

                // A NUL character
                if ch == 0 {
                    self.add_mark(ch, off, off + 1, MARK_RESOLVED);
                    off += 1;
                    continue;
                }

                off += 1;
            }
            line_index += 1;
        }

        // A dummy mark at the end simplifies `process_inlines`
        self.add_mark(127, self.size, self.size, MARK_RESOLVED);
    }

    /// `md_analyze_bracket`: pairs of brackets ordered by the position of the closer, resolved by `resolve_links`
    fn analyze_bracket(&mut self, mark_index: usize) {
        if self.marks[mark_index].flags & MARK_POTENTIAL_OPENER != 0 {
            let top = self.opener_stacks[BRACKET_OPENERS];
            if top >= 0 {
                self.marks[top as usize].flags |= MARK_HASNESTEDBRACKETS;
            }
            self.mark_stack_push(BRACKET_OPENERS, mark_index);
            return;
        }
        if self.opener_stacks[BRACKET_OPENERS] >= 0 {
            let opener_index = self.mark_stack_pop(BRACKET_OPENERS) as usize;
            // Interconnect the opener and the closer
            self.marks[opener_index].next = mark_index as i32;
            self.marks[mark_index].prev = opener_index as i32;
            // Add the pair to the list of potential links, the opener's `prev` links the list
            if self.unresolved_link_tail >= 0 {
                self.marks[self.unresolved_link_tail as usize].prev = opener_index as i32;
            } else {
                self.unresolved_link_head = opener_index as i32;
            }
            self.unresolved_link_tail = opener_index as i32;
            self.marks[opener_index].prev = -1;
        }
    }

    /// `md_resolve_links`
    fn resolve_links(&mut self, lines: &[Line]) {
        let mut opener_index = self.unresolved_link_head;
        let mut last_link_beg = 0;
        let mut last_link_end = 0;
        let mut last_img_beg = 0;
        let mut last_img_end = 0;

        while opener_index >= 0 {
            let oi = opener_index as usize;
            let opener = self.marks[oi];
            let ci = opener.next as usize;
            let closer = self.marks[ci];
            let mut next_index = opener.prev;
            let next = (next_index >= 0).then(|| {
                let next_opener = self.marks[next_index as usize];
                (next_opener, self.marks[next_opener.next as usize])
            });

            // With nested brackets, the outer one must not end inside the (...) of the inner one, and cannot be a
            // link if the inner one is a link
            if (opener.beg < last_link_beg && closer.end < last_link_end)
                || (opener.beg < last_img_beg && closer.end < last_img_end)
                || (opener.beg < last_link_end && opener.ch == b'[')
            {
                opener_index = next_index;
                continue;
            }

            let mut attr = LinkAttr::default();
            let mut is_link = false;
            match next {
                Some((next_opener, next_closer)) if next_opener.beg == closer.end => {
                    if next_closer.beg > closer.end + 1 {
                        // A full reference link
                        if next_opener.flags & MARK_HASNESTEDBRACKETS == 0 {
                            is_link = self.is_link_reference(lines, next_opener.beg, next_closer.end, &mut attr);
                        }
                    } else if opener.flags & MARK_HASNESTEDBRACKETS == 0 {
                        // A shortcut reference link
                        is_link = self.is_link_reference(lines, opener.beg, closer.end, &mut attr);
                    }
                    if is_link {
                        // Eat the second [...] and do not analyze it as a standalone link
                        self.marks[ci].end = next_closer.end;
                        next_index = self.marks[next_index as usize].prev;
                    }
                }
                _ => {
                    if closer.end < self.size && self.ch(closer.end) == b'(' {
                        // An inline link
                        if let Some(inline_link_end) = self.is_inline_link_spec(lines, closer.end, &mut attr) {
                            is_link = true;
                            // The closing ')' must not be inside an already resolved range, e.g. a code span
                            let mut i = ci + 1;
                            while i < self.marks.len() {
                                let mark = self.marks[i];
                                if mark.beg >= inline_link_end {
                                    break;
                                }
                                if mark.flags & (MARK_OPENER | MARK_RESOLVED) == (MARK_OPENER | MARK_RESOLVED) {
                                    if self.marks[mark.next as usize].beg >= inline_link_end {
                                        is_link = false;
                                        break;
                                    }
                                    i = mark.next as usize + 1;
                                } else {
                                    i += 1;
                                }
                            }
                            if is_link {
                                self.marks[ci].end = inline_link_end;
                            }
                        }
                    }
                    if !is_link && opener.flags & MARK_HASNESTEDBRACKETS == 0 {
                        // A collapsed reference link
                        is_link = self.is_link_reference(lines, opener.beg, self.marks[ci].end, &mut attr);
                    }
                }
            }

            if is_link {
                self.marks[oi].flags |= MARK_OPENER | MARK_RESOLVED;
                self.marks[ci].flags |= MARK_CLOSER | MARK_RESOLVED;
                // The destination and the title go to the two dummy marks after the opener
                self.marks[oi + 1].beg = attr.dest_beg;
                self.marks[oi + 1].end = attr.dest_end;
                self.marks[oi + 2].prev = attr.title.len() as i32;
                self.marks[oi + 2].beg = self.titles.len() as Off;
                self.titles.push(attr.title);
                if opener.ch == b'[' {
                    last_link_beg = opener.beg;
                    last_link_end = self.marks[ci].end;
                } else {
                    last_img_beg = opener.beg;
                    last_img_end = self.marks[ci].end;
                }
                self.analyze_link_contents(lines, oi + 1, ci);
            }
            opener_index = next_index;
        }
    }

    /// `md_analyze_entity`: does the `&` start an entity that ends with the `;` of the next mark?
    fn analyze_entity(&mut self, mark_index: usize) {
        if mark_index + 1 >= self.marks.len() {
            return;
        }
        let closer = self.marks[mark_index + 1];
        if closer.ch != b';' {
            return;
        }
        if is_entity_str(self.text, self.marks[mark_index].beg, closer.end).is_some() {
            self.resolve_range(mark_index, mark_index + 1);
            self.marks[mark_index].end = closer.end;
        }
    }

    /// `md_split_emph_mark`: the new mark takes the last `n` characters
    fn split_emph_mark(&mut self, mark_index: usize, n: Off) -> usize {
        let mark = self.marks[mark_index];
        let new_mark_index = mark_index + (mark.end - mark.beg - n) as usize;
        let mut dummy = mark;
        self.marks[mark_index].end -= n;
        dummy.beg = self.marks[mark_index].end;
        self.marks[new_mark_index] = dummy;
        new_mark_index
    }

    /// `md_analyze_emph`
    fn analyze_emph(&mut self, mark_index: usize) {
        let mark = self.marks[mark_index];

        // If we can be a closer, try to resolve with the preceding opener
        if mark.flags & MARK_POTENTIAL_CLOSER != 0 {
            let flags = mark.flags;
            let mod3 = flags & MARK_EMPH_MOD3_MASK;
            let mut stacks = [0usize; 6];
            let mut n_stacks = 0;
            // The rule of three
            let mut push = |stack: usize| {
                stacks[n_stacks] = stack;
                n_stacks += 1;
            };
            push(Self::emph_stack(mark.ch, MARK_EMPH_MOD3_0 | MARK_EMPH_OC));
            if mod3 != MARK_EMPH_MOD3_2 {
                push(Self::emph_stack(mark.ch, MARK_EMPH_MOD3_1 | MARK_EMPH_OC));
            }
            if mod3 != MARK_EMPH_MOD3_1 {
                push(Self::emph_stack(mark.ch, MARK_EMPH_MOD3_2 | MARK_EMPH_OC));
            }
            push(Self::emph_stack(mark.ch, MARK_EMPH_MOD3_0));
            if flags & MARK_EMPH_OC == 0 || mod3 != MARK_EMPH_MOD3_2 {
                push(Self::emph_stack(mark.ch, MARK_EMPH_MOD3_1));
            }
            if flags & MARK_EMPH_OC == 0 || mod3 != MARK_EMPH_MOD3_1 {
                push(Self::emph_stack(mark.ch, MARK_EMPH_MOD3_2));
            }

            // The opener is the most recent mark of the allowed stacks
            let mut opener: Option<usize> = None;
            for &stack in &stacks[..n_stacks] {
                let top = self.opener_stacks[stack];
                if top >= 0 {
                    let m = self.marks[top as usize];
                    if opener.is_none_or(|o| m.end > self.marks[o].end) {
                        opener = Some(top as usize);
                    }
                }
            }

            if let Some(mut opener_index) = opener {
                let opener_mark = self.marks[opener_index];
                let opener_size = opener_mark.end - opener_mark.beg;
                let closer_size = mark.end - mark.beg;
                let stack = self.opener_stack(opener_index);
                if opener_size > closer_size {
                    opener_index = self.split_emph_mark(opener_index, closer_size);
                    self.mark_stack_push(stack, opener_index);
                } else if opener_size < closer_size {
                    self.split_emph_mark(mark_index, closer_size - opener_size);
                }
                // Above we were only peeking
                self.mark_stack_pop(stack);
                self.rollback_crossing(opener_index);
                self.resolve_range(opener_index, mark_index);
                return;
            }
        }

        // If we could not resolve as closer, we may be yet be an opener
        if mark.flags & MARK_POTENTIAL_OPENER != 0 {
            self.mark_stack_push(Self::emph_stack(mark.ch, mark.flags), mark_index);
        }
    }

    /// `md_analyze_marks` of the marks in `mark_chars`, skipping resolved ranges
    fn analyze_marks(&mut self, lines: &[Line], mark_beg: usize, mark_end: usize, mark_chars: &[u8]) {
        let mut i = mark_beg;
        let mut last_end = lines[0].beg;
        while i < mark_end {
            let mark = self.marks[i];
            // Skip resolved spans
            if mark.flags & MARK_RESOLVED != 0 {
                if mark.flags & MARK_OPENER != 0 {
                    i = mark.next as usize + 1;
                } else {
                    i += 1;
                }
                continue;
            }
            // Skip marks we do not want to deal with
            if !is_any_of(mark.ch, mark_chars) {
                i += 1;
                continue;
            }
            // The resolving in a previous step could have expanded a mark
            if mark.beg < last_end {
                i += 1;
                continue;
            }
            match mark.ch {
                b'[' | b'!' | b']' => self.analyze_bracket(i),
                b'&' => self.analyze_entity(i),
                b'_' | b'*' => self.analyze_emph(i),
                _ => {}
            }
            let mark = self.marks[i];
            if mark.flags & MARK_RESOLVED != 0 {
                if mark.flags & MARK_OPENER != 0 {
                    last_end = self.marks[mark.next as usize].end;
                } else {
                    last_end = mark.end;
                }
            }
            i += 1;
        }
    }

    /// `md_analyze_link_contents`
    fn analyze_link_contents(&mut self, lines: &[Line], mark_beg: usize, mark_end: usize) {
        self.analyze_marks(lines, mark_beg, mark_end, b"&");
        self.analyze_marks(lines, mark_beg, mark_end, b"*_~$");
        self.opener_stacks = [-1; 16];
    }

    /// `md_analyze_inlines`
    fn analyze_inlines(&mut self, lines: &[Line]) {
        self.marks.clear();
        self.collect_marks(lines);

        // Links
        let n = self.marks.len();
        self.analyze_marks(lines, 0, n, b"[]!");
        self.resolve_links(lines);
        self.opener_stacks[BRACKET_OPENERS] = -1;
        self.unresolved_link_head = -1;
        self.unresolved_link_tail = -1;

        // Emphasis and strong emphasis
        let n = self.marks.len();
        self.analyze_link_contents(lines, 0, n);
    }

    /// `md_enter_leave_span_a`
    fn enter_leave_span_a(&mut self, enter: bool, span_type: SpanType, dest: &[u8], is_autolink: bool, title: &[u8]) {
        if enter {
            let detail = LinkDetail { href: build_attribute(dest, is_autolink), title: build_attribute(title, false) };
            self.r.enter_span(span_type, Some(detail));
        } else {
            self.r.leave_span(span_type);
        }
    }

    /// `md_process_inlines`: render the block contents according to the analyzed marks
    fn process_inlines(&mut self, lines: &[Line]) {
        let mut text_type = TextType::Normal;
        let mut line_index = 0;
        let mut line = lines[0];
        let mut off = lines[0].beg;
        let end = lines[lines.len() - 1].end;
        let mut enforce_hardbreak = false;

        // The first resolved mark. There always is one, the dummy mark at the end.
        let mut mi = 0;
        while self.marks[mi].flags & MARK_RESOLVED == 0 {
            mi += 1;
        }

        loop {
            let mark = self.marks[mi];

            // The text up to the next mark or the end of the line
            let tmp = line.end.min(mark.beg);
            if tmp > off {
                self.text_cb(text_type, off, tmp);
                off = tmp;
            }

            // At the mark, process it and move to the next one
            if off >= mark.beg {
                match mark.ch {
                    b'\\' => {
                        if is_newline(self.ch(mark.beg + 1)) {
                            enforce_hardbreak = true;
                        } else {
                            self.text_cb(text_type, mark.beg + 1, mark.beg + 2);
                        }
                    }
                    b'`' => {
                        if mark.flags & MARK_OPENER != 0 {
                            self.r.enter_span(SpanType::Code, None);
                            text_type = TextType::Code;
                        } else {
                            self.r.leave_span(SpanType::Code);
                            text_type = TextType::Normal;
                        }
                    }
                    b'_' | b'*' => {
                        if mark.flags & MARK_OPENER != 0 {
                            if (mark.end - off) % 2 != 0 {
                                self.r.enter_span(SpanType::Em, None);
                                off += 1;
                            }
                            while off + 1 < mark.end {
                                self.r.enter_span(SpanType::Strong, None);
                                off += 2;
                            }
                        } else {
                            while off + 1 < mark.end {
                                self.r.leave_span(SpanType::Strong);
                                off += 2;
                            }
                            if (mark.end - off) % 2 != 0 {
                                self.r.leave_span(SpanType::Em);
                            }
                        }
                    }
                    b'[' | b'!' | b']' => {
                        let oi = if mark.ch != b']' { mi } else { mark.prev as usize };
                        let opener = self.marks[oi];
                        let dest = self.marks[oi + 1];
                        let title_mark = self.marks[oi + 2];
                        let span_type = if opener.ch == b'!' { SpanType::Img } else { SpanType::A };
                        let title = std::mem::take(&mut self.titles[title_mark.beg as usize]);
                        let text = self.text;
                        self.enter_leave_span_a(
                            mark.ch != b']',
                            span_type,
                            &text[dest.beg as usize..dest.end as usize],
                            false,
                            &title,
                        );
                        self.titles[title_mark.beg as usize] = title;
                        // A link or image closer may span multiple lines
                        if mark.ch == b']' {
                            while mark.end > line.end {
                                line_index += 1;
                                line = lines[line_index];
                            }
                        }
                    }
                    b'<' | b'>' => {
                        if mark.flags & MARK_AUTOLINK == 0 {
                            // Raw HTML
                            text_type = if mark.flags & MARK_OPENER != 0 { TextType::Html } else { TextType::Normal };
                        } else {
                            let oi = if mark.flags & MARK_OPENER != 0 { mi } else { mark.prev as usize };
                            let opener = self.marks[oi];
                            let ci = opener.next as usize;
                            let mut dest = Vec::new();
                            if opener.flags & MARK_AUTOLINK_MISSING_MAILTO != 0 {
                                dest.extend_from_slice(b"mailto:");
                            }
                            dest.extend_from_slice(self.str(opener.end, self.marks[ci].beg));
                            // The closer is output only if the opener was (`MD_MARK_VALIDPERMISSIVEAUTOLINK` is
                            // the bit of `MD_MARK_AUTOLINK`)
                            if mark.flags & MARK_OPENER != 0 {
                                self.marks[ci].flags |= MARK_VALIDPERMISSIVEAUTOLINK;
                            }
                            if self.marks[ci].flags & MARK_VALIDPERMISSIVEAUTOLINK != 0 {
                                self.enter_leave_span_a(mark.flags & MARK_OPENER != 0, SpanType::A, &dest, true, b"");
                            }
                        }
                    }
                    b'&' => self.text_cb(TextType::Entity, mark.beg, mark.end),
                    0 => self.r.text(TextType::NullChar, b"\0"),
                    127 => return,
                    _ => {}
                }

                off = mark.end;

                // Move to the next resolved mark
                mi += 1;
                while self.marks[mi].flags & MARK_RESOLVED == 0 || self.marks[mi].beg < off {
                    mi += 1;
                }
            }

            // At the end of the line, move to the next one
            if off >= line.end {
                // At the end of the last line, we are done
                if off >= end {
                    break;
                }
                if text_type == TextType::Code {
                    // Inside a code span, trailing line whitespace is output
                    let tmp = off;
                    while off < self.size && is_blank(self.ch(off)) {
                        off += 1;
                    }
                    if off > tmp {
                        self.text_cb(text_type, tmp, off);
                    }
                    // and line breaks become single spaces
                    if off == line.end {
                        self.r.text(text_type, b" ");
                    }
                } else if text_type == TextType::Html {
                    // Inside raw HTML, the line break is output verbatim, including trailing spaces
                    let mut tmp = off;
                    while tmp < end && is_blank(self.ch(tmp)) {
                        tmp += 1;
                    }
                    if tmp > off {
                        self.text_cb(TextType::Html, off, tmp);
                    }
                    self.r.text(TextType::Html, b"\n");
                } else {
                    // A soft or hard line break
                    let break_type = if text_type == TextType::Normal
                        && (enforce_hardbreak || (self.ch(line.end) == b' ' && self.ch(line.end + 1) == b' '))
                    {
                        TextType::Br
                    } else {
                        TextType::SoftBr
                    };
                    self.r.text(break_type, b"\n");
                }

                line_index += 1;
                line = lines[line_index];
                off = line.beg;
                enforce_hardbreak = false;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Leaf blocks
    // -----------------------------------------------------------------------

    /// `md_process_normal_block_contents`
    fn process_normal_block_contents(&mut self, lines: &[Line]) {
        self.analyze_inlines(lines);
        self.process_inlines(lines);
        self.titles.clear();
    }

    /// `md_text_with_null_replacement`: NUL bytes become `MD_TEXT_NULLCHAR`. After a NUL, the C code does not advance
    /// the string, so the NUL byte is also the first byte of the following text.
    fn text_insecure(&mut self, text_type: TextType, beg: Off, end: Off) {
        let text = self.text;
        let mut s = &text[beg as usize..end as usize];
        let mut off = 0;
        loop {
            while off < s.len() && s[off] != 0 {
                off += 1;
            }
            if off > 0 {
                self.r.text(text_type, &s[..off]);
                s = &s[off..];
                off = 0;
            }
            if off >= s.len() {
                return;
            }
            self.r.text(TextType::NullChar, b"\0");
            off += 1;
        }
    }

    /// `md_process_verbatim_block_contents`
    fn process_verbatim_block_contents(&mut self, text_type: TextType, lines: &[Line]) {
        const INDENT_CHUNK: &[u8] = b"                ";
        for line in lines {
            // Code indentation
            let mut indent = line.indent as usize;
            while indent > INDENT_CHUNK.len() {
                self.r.text(text_type, INDENT_CHUNK);
                indent -= INDENT_CHUNK.len();
            }
            if indent > 0 {
                self.r.text(text_type, &INDENT_CHUNK[..indent]);
            }
            // The code line itself
            if line.end > line.beg {
                self.text_insecure(text_type, line.beg, line.end);
            }
            // Enforce the end of the line
            self.r.text(text_type, b"\n");
        }
    }

    /// `md_process_code_block_contents`
    fn process_code_block_contents(&mut self, is_fenced: bool, mut lines: &[Line]) {
        if is_fenced {
            // Skip the opening fence
            lines = &lines[1..];
        } else {
            // Ignore blank lines at the start and the end of an indented code block
            while !lines.is_empty() && lines[0].beg == lines[0].end {
                lines = &lines[1..];
            }
            while !lines.is_empty() && lines[lines.len() - 1].beg == lines[lines.len() - 1].end {
                lines = &lines[..lines.len() - 1];
            }
        }
        if lines.is_empty() {
            return;
        }
        self.process_verbatim_block_contents(TextType::Code, lines);
    }

    /// `md_setup_fenced_code_detail`: the language of the info string
    fn fenced_code_lang(&self, fence_line: Line) -> Attribute {
        let mut beg = fence_line.beg;
        let mut end = fence_line.end;
        let fence_ch = self.ch(fence_line.beg);
        // Skip the fence itself
        while beg < self.size && self.ch(beg) == fence_ch {
            beg += 1;
        }
        // Trim initial spaces
        while beg < self.size && self.ch(beg) == b' ' {
            beg += 1;
        }
        // Trim trailing spaces
        while end > beg && self.ch(end - 1) == b' ' {
            end -= 1;
        }
        let mut lang_end = beg;
        while lang_end < end && !is_whitespace(self.ch(lang_end)) {
            lang_end += 1;
        }
        build_attribute(&self.text[beg as usize..lang_end.max(beg) as usize], false)
    }

    /// `md_process_leaf_block`
    fn process_leaf_block(&mut self, block: Block, lines: &[Line], loose_stack: &[bool]) {
        let is_in_tight_list = loose_stack.last().is_some_and(|is_loose| !is_loose);
        let detail = match block.block_type {
            BlockType::H => BlockDetail::H { level: block.data },
            BlockType::Code if block.data != 0 => BlockDetail::Code { lang: Some(self.fenced_code_lang(lines[0])) },
            BlockType::Code => BlockDetail::Code { lang: None },
            _ => BlockDetail::None,
        };
        let has_block_events = !is_in_tight_list || block.block_type != BlockType::P;
        if has_block_events {
            self.r.enter_block(block.block_type, detail);
        }
        match block.block_type {
            BlockType::Hr => {}
            BlockType::Code => self.process_code_block_contents(block.data != 0, lines),
            BlockType::Html => self.process_verbatim_block_contents(TextType::Html, lines),
            _ => self.process_normal_block_contents(lines),
        }
        if has_block_events {
            self.r.leave_block(block.block_type);
        }
    }

    /// `md_process_all_blocks`
    fn process_all_blocks(&mut self) {
        let blocks = std::mem::take(&mut self.blocks);
        let lines = std::mem::take(&mut self.lines);
        // Whether the enclosing lists are loose (the C code reuses `containers`)
        let mut loose_stack: Vec<bool> = Vec::new();
        for block in &blocks {
            if block.flags & BLOCK_CONTAINER != 0 {
                if block.flags & BLOCK_CONTAINER_CLOSER != 0 {
                    self.r.leave_block(block.block_type);
                    if matches!(block.block_type, BlockType::Ul | BlockType::Ol | BlockType::Quote) {
                        loose_stack.pop();
                    }
                }
                if block.flags & BLOCK_CONTAINER_OPENER != 0 {
                    let is_tight = block.flags & BLOCK_LOOSE_LIST == 0;
                    let detail = match block.block_type {
                        BlockType::Ul => BlockDetail::Ul { is_tight },
                        BlockType::Ol => BlockDetail::Ol { start: block.n_lines, is_tight },
                        _ => BlockDetail::None,
                    };
                    self.r.enter_block(block.block_type, detail);
                    match block.block_type {
                        BlockType::Ul | BlockType::Ol => loose_stack.push(!is_tight),
                        // Text in a block quote is always wrapped in paragraphs, even in a tight list item
                        BlockType::Quote => loose_stack.push(true),
                        _ => {}
                    }
                }
            } else {
                let block_lines = &lines[block.lines_begin..block.lines_begin + block.n_lines as usize];
                self.process_leaf_block(*block, block_lines, &loose_stack);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Grouping lines into blocks
    // -----------------------------------------------------------------------

    fn current_block(&mut self) -> Option<&mut Block> {
        if self.has_current_block {
            self.blocks.last_mut()
        } else {
            None
        }
    }

    /// The type field of the last `sizeof(MD_BLOCK)` bytes of the C block byte stream. That is the last block if
    /// it has no lines, else the start of its last line.
    fn top_block_type(&self) -> u32 {
        let block = self.blocks.last().expect("block bytes");
        if block.flags & BLOCK_CONTAINER == 0 && block.n_lines > 0 {
            let line = self.lines.last().expect("block lines");
            // MD_LINE is {beg, end}, MD_VERBATIMLINE is {beg, end, indent}
            if block.has_verbatim_lines() {
                line.end & 0xff
            } else {
                line.beg & 0xff
            }
        } else {
            block.block_type as u32
        }
    }

    /// `md_start_new_block`
    fn start_new_block(&mut self, line: &LineAnalysis) {
        let block_type = match line.line_type {
            LineType::Hr => BlockType::Hr,
            LineType::AtxHeader => BlockType::H,
            LineType::FencedCode | LineType::IndentedCode => BlockType::Code,
            LineType::Text => BlockType::P,
            LineType::Html => BlockType::Html,
            LineType::Blank | LineType::SetextUnderline => unreachable!("no block starts with {:?}", line.line_type),
        };
        self.blocks.push(Block {
            block_type,
            flags: 0,
            data: line.data & 0xffff,
            n_lines: 0,
            lines_begin: self.lines.len(),
        });
        self.n_block_bytes += SIZEOF_BLOCK;
        self.has_current_block = true;
    }

    /// `md_consume_link_reference_definitions`: eat reference definitions from the start of the current block
    fn consume_link_reference_definitions(&mut self) {
        let block = *self.blocks.last().unwrap();
        let lines = self.lines[block.lines_begin..].to_vec();
        let n_lines = lines.len();
        let mut n = 0;
        while n < n_lines {
            let n_link_ref_lines = self.is_link_reference_definition(&lines[n..]);
            if n_link_ref_lines == 0 {
                break;
            }
            n += n_link_ref_lines;
        }
        if n == 0 {
            return;
        }
        if n == n_lines {
            // Remove the complete block
            self.n_block_bytes -= n * SIZEOF_LINE + SIZEOF_BLOCK;
            self.lines.truncate(block.lines_begin);
            self.blocks.pop();
            self.has_current_block = false;
        } else {
            // Remove just some initial lines from the block
            self.lines.drain(block.lines_begin..block.lines_begin + n);
            self.blocks.last_mut().unwrap().n_lines -= n as u32;
            self.n_block_bytes -= n * SIZEOF_LINE;
        }
    }

    /// `md_end_current_block`
    fn end_current_block(&mut self) {
        let Some(block) = self.current_block().copied() else {
            return;
        };

        // Check for reference definitions here, they may take multiple lines
        if block.block_type == BlockType::P
            || (block.block_type == BlockType::H && block.flags & BLOCK_SETEXT_HEADER != 0)
        {
            let first = self.lines[block.lines_begin];
            if first.beg < self.size && self.ch(first.beg) == b'[' {
                self.consume_link_reference_definitions();
                if !self.has_current_block {
                    return;
                }
            }
        }

        let block = self.blocks.last_mut().unwrap();
        if block.block_type == BlockType::H && block.flags & BLOCK_SETEXT_HEADER != 0 {
            if block.n_lines > 1 {
                // Get rid of the underline
                block.n_lines -= 1;
                self.lines.pop();
                self.n_block_bytes -= SIZEOF_LINE;
            } else {
                // Only the underline is left after eating the reference definitions. Keep the line as the start of
                // a new paragraph.
                block.block_type = BlockType::P;
                return;
            }
        }

        self.has_current_block = false;
    }

    /// `md_add_line_into_current_block`
    fn add_line_into_current_block(&mut self, analysis: &LineAnalysis) {
        let block = self.blocks.last_mut().expect("current block");
        self.n_block_bytes += if block.has_verbatim_lines() { SIZEOF_VERBATIMLINE } else { SIZEOF_LINE };
        block.n_lines += 1;
        self.lines.push(Line { beg: analysis.beg, end: analysis.end, indent: analysis.indent });
    }

    /// `md_push_container_bytes`
    fn push_container_bytes(&mut self, block_type: BlockType, start: u32, data: u32, flags: u8) {
        self.end_current_block();
        let lines_begin = self.lines.len();
        self.blocks.push(Block { block_type, flags, data: data & 0xffff, n_lines: start, lines_begin });
        self.n_block_bytes += SIZEOF_BLOCK;
    }

    // -----------------------------------------------------------------------
    // Line analysis
    // -----------------------------------------------------------------------

    /// `md_is_hr_line`: Ok(end) or Err(killer)
    fn is_hr_line(&self, beg: Off) -> Result<Off, Off> {
        let mut off = beg + 1;
        let mut n = 1;
        while off < self.size && (self.ch(off) == self.ch(beg) || self.ch(off) == b' ' || self.ch(off) == b'\t') {
            if self.ch(off) == self.ch(beg) {
                n += 1;
            }
            off += 1;
        }
        if n < 3 {
            return Err(off);
        }
        // Nothing else can be present on the line
        if off < self.size && !is_newline(self.ch(off)) {
            return Err(off);
        }
        Ok(off)
    }

    /// `md_is_atxheader_line`: (beg, end, level)
    fn is_atxheader_line(&self, beg: Off) -> Option<(Off, Off, u32)> {
        let mut off = beg + 1;
        while off < self.size && self.ch(off) == b'#' && off - beg < 7 {
            off += 1;
        }
        let n = off - beg;
        if n > 6 {
            return None;
        }
        if off < self.size && self.ch(off) != b' ' && self.ch(off) != b'\t' && !is_newline(self.ch(off)) {
            return None;
        }
        while off < self.size && self.ch(off) == b' ' {
            off += 1;
        }
        Some((off, off, n))
    }

    /// `md_is_setext_underline`: (end, level)
    fn is_setext_underline(&self, beg: Off) -> Option<(Off, u32)> {
        let mut off = beg + 1;
        while off < self.size && self.ch(off) == self.ch(beg) {
            off += 1;
        }
        // Optionally, spaces or tabs can follow
        while off < self.size && is_blank(self.ch(off)) {
            off += 1;
        }
        // But nothing more is allowed on the line
        if off < self.size && !is_newline(self.ch(off)) {
            return None;
        }
        Some((off, if self.ch(beg) == b'=' { 1 } else { 2 }))
    }

    /// `md_is_opening_code_fence`. Sets the fence length once three fence characters are seen, even on failure.
    fn is_opening_code_fence(&mut self, beg: Off) -> Option<Off> {
        let mut off = beg;
        while off < self.size && self.ch(off) == self.ch(beg) {
            off += 1;
        }
        // A fence must have at least three characters
        if off - beg < 3 {
            return None;
        }
        self.code_fence_length = off - beg;
        // Optionally, spaces can follow
        while off < self.size && self.ch(off) == b' ' {
            off += 1;
        }
        // Optionally, an info string can follow
        while off < self.size && !is_newline(self.ch(off)) {
            // A backtick fence must not contain '`' in the info string
            if self.ch(beg) == b'`' && self.ch(off) == b'`' {
                return None;
            }
            off += 1;
        }
        Some(off)
    }

    /// `md_is_closing_code_fence`: (is closing fence, end). The end is set even on failure.
    fn is_closing_code_fence(&self, ch: u8, beg: Off) -> (bool, Off) {
        let mut off = beg;
        // At least the length and the character of the opening fence
        while off < self.size && self.ch(off) == ch {
            off += 1;
        }
        if off - beg < self.code_fence_length {
            return (false, off);
        }
        // Optionally, spaces can follow
        while off < self.size && self.ch(off) == b' ' {
            off += 1;
        }
        // But nothing more is allowed on the line
        if off < self.size && !is_newline(self.ch(off)) {
            return (false, off);
        }
        (true, off)
    }

    /// `md_ascii_case_eq` of the text at `off` with a lower-case name
    fn ascii_case_eq(&self, off: Off, name: &[u8]) -> bool {
        let text = self.str(off, off + name.len() as Off);
        text.iter().zip(name).all(|(a, b)| a.to_ascii_uppercase() == b.to_ascii_uppercase())
    }

    /// `md_is_html_block_start_condition`: the type of an HTML block starting at `beg`, 0 if none
    fn is_html_block_start_condition(&self, beg: Off) -> i32 {
        let mut off = beg + 1;

        // Type 1: <script, <pre, <style or <textarea
        for tag in HTML_TAGS_1 {
            if off + tag.len() as Off <= self.size && self.ascii_case_eq(off, tag) {
                return 1;
            }
        }

        // Type 2: <!--
        if off + 3 < self.size && self.ch(off) == b'!' && self.ch(off + 1) == b'-' && self.ch(off + 2) == b'-' {
            return 2;
        }

        // Type 3: <?
        if off < self.size && self.ch(off) == b'?' {
            return 3;
        }

        // Type 4 or 5: <!
        if off < self.size && self.ch(off) == b'!' {
            // Type 4: <! followed by any ASCII character
            if off + 1 < self.size && is_ascii(self.ch(off + 1)) {
                return 4;
            }
            // Type 5: <![CDATA[
            if off + 8 < self.size && self.str(off, off + 8) == b"![CDATA[" {
                return 5;
            }
        }

        // Type 6: many possible starting tags
        if off + 1 < self.size
            && (self.ch(off).is_ascii_alphabetic() || (self.ch(off) == b'/' && self.ch(off + 1).is_ascii_alphabetic()))
        {
            if self.ch(off) == b'/' {
                off += 1;
            }
            for tag in html_tags_6(self.ch(off).to_ascii_lowercase()) {
                let len = tag.len() as Off;
                if off + len <= self.size && self.ascii_case_eq(off, tag) {
                    let tmp = off + len;
                    if tmp >= self.size {
                        return 6;
                    }
                    let c = self.ch(tmp);
                    if is_blank(c) || is_newline(c) || c == b'>' {
                        return 6;
                    }
                    if tmp + 1 < self.size && c == b'/' && self.ch(tmp + 1) == b'>' {
                        return 6;
                    }
                    break;
                }
            }
        }

        // Type 7: any complete other opening or closing tag
        if off + 1 < self.size {
            if let Some(mut end) = self.is_html_tag(&[], beg, self.size) {
                // Only optional whitespace and a line break may follow
                while end < self.size && is_whitespace(self.ch(end)) {
                    end += 1;
                }
                if end >= self.size || is_newline(self.ch(end)) {
                    return 7;
                }
            }
        }
        0
    }

    /// `md_line_contains`: a case-sensitive search up to the end of the line. Note that a match must end before
    /// the end of the document.
    fn line_contains(&self, beg: Off, what: &[u8]) -> (bool, Off) {
        let len = what.len() as Off;
        let mut i = beg;
        while i + len < self.size {
            if is_newline(self.ch(i)) {
                break;
            }
            if self.str(i, i + len) == what {
                return (true, i + len);
            }
            i += 1;
        }
        (false, i)
    }

    /// `md_is_html_block_end_condition`: (end condition type or 0, the new offset if set)
    fn is_html_block_end_condition(&self, beg: Off) -> (i32, Option<Off>) {
        let contains = |what: &[u8], block_type: i32| {
            let (found, end) = self.line_contains(beg, what);
            (if found { block_type } else { 0 }, Some(end))
        };
        match self.html_block_type {
            1 => {
                let mut off = beg;
                while off + 1 < self.size && !is_newline(self.ch(off)) {
                    if self.ch(off) == b'<' && self.ch(off + 1) == b'/' {
                        for tag in HTML_TAGS_1 {
                            let len = tag.len() as Off;
                            if off + 2 + len < self.size
                                && self.ascii_case_eq(off + 2, tag)
                                && self.ch(off + 2 + len) == b'>'
                            {
                                return (1, Some(off + 2 + len + 1));
                            }
                        }
                    }
                    off += 1;
                }
                (0, Some(off))
            }
            2 => contains(b"-->", 2),
            3 => contains(b"?>", 3),
            4 => contains(b">", 4),
            5 => contains(b"]]>", 5),
            6 | 7 => {
                // A blank line ends types 6 and 7
                if beg >= self.size || is_newline(self.ch(beg)) {
                    (self.html_block_type, Some(beg))
                } else {
                    (0, None)
                }
            }
            _ => unreachable!("HTML block type {}", self.html_block_type),
        }
    }

    /// `md_is_container_compatible`
    fn is_container_compatible(pivot: &Container, container: &Container) -> bool {
        // A block quote has no items like lists
        container.ch != b'>' && container.ch == pivot.ch && container.mark_indent <= pivot.contents_indent
    }

    /// `md_enter_child_containers`
    fn enter_child_containers(&mut self, n_children: usize) {
        let n = self.containers.len();
        for i in n - n_children..n {
            let c = self.containers[i];
            match c.ch {
                b')' | b'.' | b'-' | b'+' | b'*' => {
                    let is_ordered_list = c.ch == b')' || c.ch == b'.';
                    // Remember the block so it can be revisited when the list turns out to be loose
                    self.end_current_block();
                    self.containers[i].block_index = self.blocks.len();
                    self.push_container_bytes(
                        if is_ordered_list { BlockType::Ol } else { BlockType::Ul },
                        c.start,
                        c.ch as u32,
                        BLOCK_CONTAINER_OPENER,
                    );
                    self.push_container_bytes(BlockType::Li, c.task_mark_off, 0, BLOCK_CONTAINER_OPENER);
                }
                b'>' => self.push_container_bytes(BlockType::Quote, 0, 0, BLOCK_CONTAINER_OPENER),
                _ => unreachable!("container {}", c.ch),
            }
        }
    }

    /// `md_leave_child_containers`
    fn leave_child_containers(&mut self, n_keep: usize) {
        while self.containers.len() > n_keep {
            let c = *self.containers.last().unwrap();
            match c.ch {
                b')' | b'.' | b'-' | b'+' | b'*' => {
                    let is_ordered_list = c.ch == b')' || c.ch == b'.';
                    self.push_container_bytes(BlockType::Li, c.task_mark_off, 0, BLOCK_CONTAINER_CLOSER);
                    self.push_container_bytes(
                        if is_ordered_list { BlockType::Ol } else { BlockType::Ul },
                        0,
                        c.ch as u32,
                        BLOCK_CONTAINER_CLOSER,
                    );
                }
                b'>' => self.push_container_bytes(BlockType::Quote, 0, 0, BLOCK_CONTAINER_CLOSER),
                _ => unreachable!("container {}", c.ch),
            }
            self.containers.pop();
        }
    }

    /// `md_is_container_mark`: a block quote or list item mark at `beg`. Modifies `container` (the start number) even
    /// on failure.
    fn is_container_mark(&self, indent: u32, beg: Off, container: &mut Container) -> Option<Off> {
        let mut off = beg;
        if off >= self.size || indent >= self.code_indent_offset {
            return None;
        }

        // A block quote mark
        if self.ch(off) == b'>' {
            container.ch = b'>';
            container.is_loose = false;
            container.is_task = false;
            container.mark_indent = indent;
            container.contents_indent = indent + 1;
            return Some(off + 1);
        }

        // A list item bullet mark
        let next_is_space =
            |o: Off| o + 1 >= self.size || is_blank(self.ch(o + 1)) || is_newline(self.ch(o + 1));
        if is_any_of(self.ch(off), b"-+*") && next_is_space(off) {
            container.ch = self.ch(off);
            container.is_loose = false;
            container.is_task = false;
            container.mark_indent = indent;
            container.contents_indent = indent + 1;
            return Some(off + 1);
        }

        // An ordered list item mark
        let max_end = (off + 9).min(self.size);
        container.start = 0;
        while off < max_end && self.ch(off).is_ascii_digit() {
            container.start = container.start * 10 + (self.ch(off) - b'0') as u32;
            off += 1;
        }
        if off > beg && off < self.size && (self.ch(off) == b'.' || self.ch(off) == b')') && next_is_space(off) {
            container.ch = self.ch(off);
            container.is_loose = false;
            container.is_task = false;
            container.mark_indent = indent;
            container.contents_indent = indent + off - beg + 1;
            return Some(off + 1);
        }
        None
    }

    /// `md_line_indentation`: the indentation from `beg` (tabs to multiples of 4) and the end of it
    fn line_indentation(&self, total_indent: u32, beg: Off) -> (u32, Off) {
        let mut off = beg;
        let mut indent = total_indent;
        while off < self.size && is_blank(self.ch(off)) {
            if self.ch(off) == b'\t' {
                indent = (indent + 4) & !3;
            } else {
                indent += 1;
            }
            off += 1;
        }
        (indent - total_indent, off)
    }

    /// `md_analyze_line`: the type and the properties of the line at `beg`, returns the start of the next line
    fn analyze_line(&mut self, beg: Off, pivot: LineAnalysis, line: &mut LineAnalysis) -> Off {
        let mut pivot_line = pivot;
        let mut total_indent: u32 = 0;
        let mut n_parents = 0;
        let mut n_brothers = 0;
        let mut n_children = 0;
        let mut container = Container::default();
        let prev_line_has_list_loosening_effect = self.last_line_has_list_loosening_effect;
        let mut off;
        let mut hr_killer: Off = 0;
        let cio = self.code_indent_offset;

        (line.indent, off) = self.line_indentation(total_indent, beg);
        total_indent += line.indent;
        line.beg = off;
        line.enforce_new_block = false;

        // How many of the current containers are our parents, given the indentation and block quote marks
        while n_parents < self.containers.len() {
            let c = self.containers[n_parents];
            if c.ch == b'>' && line.indent < cio && off < self.size && self.ch(off) == b'>' {
                // A block quote mark
                off += 1;
                total_indent += 1;
                (line.indent, off) = self.line_indentation(total_indent, off);
                total_indent += line.indent;
                // The optional first space after '>' is part of the block quote mark
                if line.indent > 0 {
                    line.indent -= 1;
                }
                line.beg = off;
            } else if c.ch != b'>' && line.indent >= c.contents_indent {
                // A list
                line.indent -= c.contents_indent;
            } else {
                break;
            }
            n_parents += 1;
        }

        if off >= self.size || is_newline(self.ch(off)) {
            // A blank line does not need any real indentation to be nested inside a list
            if n_brothers + n_children == 0 {
                while n_parents < self.containers.len() && self.containers[n_parents].ch != b'>' {
                    n_parents += 1;
                }
            }
        }

        loop {
            // A fenced code continuation
            if pivot_line.line_type == LineType::FencedCode {
                line.beg = off;
                // Another fenced code line, unless it is the closing fence, which becomes a blank line
                if line.indent < cio {
                    let (is_closing, end) = self.is_closing_code_fence(self.ch(pivot_line.beg), off);
                    off = end;
                    if is_closing {
                        line.line_type = LineType::Blank;
                        self.last_line_has_list_loosening_effect = false;
                        break;
                    }
                }
                // The indentation relative to the opening fence
                if n_parents == self.containers.len() {
                    if line.indent > pivot_line.indent {
                        line.indent -= pivot_line.indent;
                    } else {
                        line.indent = 0;
                    }
                    line.line_type = LineType::FencedCode;
                    break;
                }
            }

            // An HTML block continuation
            if pivot_line.line_type == LineType::Html && self.html_block_type > 0 {
                if n_parents < self.containers.len() {
                    // The HTML block ends with its enclosing container
                    self.html_block_type = 0;
                } else {
                    let (html_block_type, end) = self.is_html_block_end_condition(off);
                    if let Some(end) = end {
                        off = end;
                    }
                    if html_block_type > 0 {
                        // This is the last line of the block
                        self.html_block_type = 0;
                        // Some end conditions are blank lines at the same time
                        if html_block_type == 6 || html_block_type == 7 {
                            line.line_type = LineType::Blank;
                            line.indent = 0;
                            break;
                        }
                    }
                    line.line_type = LineType::Html;
                    n_parents = self.containers.len();
                    break;
                }
            }

            // A blank line
            if off >= self.size || is_newline(self.ch(off)) {
                if pivot_line.line_type == LineType::IndentedCode && n_parents == self.containers.len() {
                    line.line_type = LineType::IndentedCode;
                    if line.indent > cio {
                        line.indent -= cio;
                    } else {
                        line.indent = 0;
                    }
                    self.last_line_has_list_loosening_effect = false;
                } else {
                    line.line_type = LineType::Blank;
                    self.last_line_has_list_loosening_effect = n_parents > 0
                        && n_brothers + n_children == 0
                        && self.containers[n_parents - 1].ch != b'>';

                    // md4c issue #6: a blank line in a (yet empty) list item, but not on its first line. A following
                    // non-blank line of the item ends the list, because a list item can begin with at most one
                    // blank line.
                    if n_parents > 0
                        && self.containers[n_parents - 1].ch != b'>'
                        && n_brothers + n_children == 0
                        && !self.has_current_block
                        && self.n_block_bytes > SIZEOF_BLOCK
                        && self.top_block_type() == BlockType::Li as u32
                    {
                        self.last_list_item_starts_with_two_blank_lines = true;
                    }
                }
                break;
            } else {
                // The second half of the hack: end the list
                if self.last_list_item_starts_with_two_blank_lines {
                    if n_parents > 0
                        && n_parents == self.containers.len()
                        && self.containers[n_parents - 1].ch != b'>'
                        && n_brothers + n_children == 0
                        && !self.has_current_block
                        && self.n_block_bytes > SIZEOF_BLOCK
                        && self.top_block_type() == BlockType::Li as u32
                    {
                        n_parents -= 1;
                        line.indent = total_indent;
                        if n_parents > 0 {
                            line.indent -= line.indent.min(self.containers[n_parents - 1].contents_indent);
                        }
                    }
                    self.last_list_item_starts_with_two_blank_lines = false;
                }
                self.last_line_has_list_loosening_effect = false;
            }

            // A setext underline
            if line.indent < cio
                && pivot_line.line_type == LineType::Text
                && off < self.size
                && (self.ch(off) == b'=' || self.ch(off) == b'-')
                && n_parents == self.containers.len()
            {
                if let Some((end, level)) = self.is_setext_underline(off) {
                    off = end;
                    line.line_type = LineType::SetextUnderline;
                    line.data = level;
                    break;
                }
            }

            // A thematic break
            if line.indent < cio && off < self.size && off >= hr_killer && is_any_of(self.ch(off), b"-_*") {
                match self.is_hr_line(off) {
                    Ok(end) => {
                        off = end;
                        line.line_type = LineType::Hr;
                        break;
                    }
                    Err(killer) => hr_killer = killer,
                }
            }

            // A brother container: another list item of an already started list
            if n_parents < self.containers.len() && n_brothers + n_children == 0 {
                if let Some(tmp) = self.is_container_mark(line.indent, off, &mut container) {
                    if Self::is_container_compatible(&self.containers[n_parents], &container) {
                        pivot_line = DUMMY_BLANK_LINE;
                        off = tmp;
                        total_indent += container.contents_indent - container.mark_indent;
                        (line.indent, off) = self.line_indentation(total_indent, off);
                        total_indent += line.indent;
                        line.beg = off;

                        // Some of the following whitespace still belongs to the mark
                        if off >= self.size || is_newline(self.ch(off)) {
                            container.contents_indent += 1;
                        } else if line.indent <= cio {
                            container.contents_indent += line.indent;
                            line.indent = 0;
                        } else {
                            container.contents_indent += 1;
                            line.indent -= 1;
                        }

                        self.containers[n_parents].mark_indent = container.mark_indent;
                        self.containers[n_parents].contents_indent = container.contents_indent;
                        n_brothers += 1;
                        continue;
                    }
                }
            }

            // Indented code, which cannot interrupt a paragraph
            if line.indent >= cio && pivot_line.line_type != LineType::Text {
                line.line_type = LineType::IndentedCode;
                line.indent -= cio;
                line.data = 0;
                break;
            }

            // The start of a new container block
            if line.indent < cio {
                if let Some(end) = self.is_container_mark(line.indent, off, &mut container) {
                    off = end;
                    if pivot_line.line_type == LineType::Text
                        && n_parents == self.containers.len()
                        && (off >= self.size || is_newline(self.ch(off)))
                        && container.ch != b'>'
                    {
                        // A list mark followed by a blank line cannot interrupt a paragraph
                    } else if pivot_line.line_type == LineType::Text
                        && n_parents == self.containers.len()
                        && (container.ch == b'.' || container.ch == b')')
                        && container.start != 1
                    {
                        // An ordered list cannot interrupt a paragraph unless it starts with 1
                    } else {
                        total_indent += container.contents_indent - container.mark_indent;
                        (line.indent, off) = self.line_indentation(total_indent, off);
                        total_indent += line.indent;
                        line.beg = off;
                        line.data = container.ch as u32;

                        // Some of the following whitespace still belongs to the mark
                        if off >= self.size || is_newline(self.ch(off)) {
                            container.contents_indent += 1;
                        } else if line.indent <= cio {
                            container.contents_indent += line.indent;
                            line.indent = 0;
                        } else {
                            container.contents_indent += 1;
                            line.indent -= 1;
                        }

                        if n_brothers + n_children == 0 {
                            pivot_line = DUMMY_BLANK_LINE;
                        }
                        if n_children == 0 {
                            self.leave_child_containers(n_parents + n_brothers);
                        }
                        n_children += 1;
                        self.containers.push(container);
                        continue;
                    }
                }
            }

            // An ATX header
            if line.indent < cio && off < self.size && self.ch(off) == b'#' {
                if let Some((beg, end, level)) = self.is_atxheader_line(off) {
                    line.beg = beg;
                    off = end;
                    line.line_type = LineType::AtxHeader;
                    line.data = level;
                    break;
                }
            }

            // An opening code fence
            if line.indent < cio && off < self.size && (self.ch(off) == b'`' || self.ch(off) == b'~') {
                if let Some(end) = self.is_opening_code_fence(off) {
                    off = end;
                    line.line_type = LineType::FencedCode;
                    line.data = 1;
                    line.enforce_new_block = true;
                    break;
                }
            }

            // The start of an HTML block
            if off < self.size && self.ch(off) == b'<' {
                self.html_block_type = self.is_html_block_start_condition(off);
                // An HTML block of type 7 cannot interrupt a paragraph
                if self.html_block_type == 7 && pivot_line.line_type == LineType::Text {
                    self.html_block_type = 0;
                }
                if self.html_block_type > 0 {
                    // The line itself may close the block
                    let (end_type, end) = self.is_html_block_end_condition(off);
                    if let Some(end) = end {
                        off = end;
                    }
                    if end_type == self.html_block_type {
                        self.html_block_type = 0;
                    }
                    line.enforce_new_block = true;
                    line.line_type = LineType::Html;
                    break;
                }
            }

            // A normal text line
            line.line_type = LineType::Text;
            if pivot_line.line_type == LineType::Text && n_brothers + n_children == 0 {
                // A lazy continuation
                n_parents = self.containers.len();
            }
            break;
        }

        // The end of the line
        while off < self.size && !is_newline(self.ch(off)) {
            off += 1;
        }
        line.end = off;

        // An ATX header excludes the optional closing sequence
        if line.line_type == LineType::AtxHeader {
            let mut tmp = line.end;
            while tmp > line.beg && self.ch(tmp - 1) == b' ' {
                tmp -= 1;
            }
            while tmp > line.beg && self.ch(tmp - 1) == b'#' {
                tmp -= 1;
            }
            if tmp == line.beg || self.ch(tmp - 1) == b' ' {
                line.end = tmp;
            }
        }

        // Trim trailing spaces
        if !matches!(line.line_type, LineType::IndentedCode | LineType::FencedCode | LineType::Html) {
            while line.end > line.beg && self.ch(line.end - 1) == b' ' {
                line.end -= 1;
            }
        }

        // Eat the line break
        if off < self.size && self.ch(off) == b'\r' {
            off += 1;
        }
        if off < self.size && self.ch(off) == b'\n' {
            off += 1;
        }

        // Belonging to a list after a blank line makes the list loose
        if prev_line_has_list_loosening_effect && line.line_type != LineType::Blank && n_parents + n_brothers > 0 {
            let c = self.containers[n_parents + n_brothers - 1];
            if c.ch != b'>' {
                self.blocks[c.block_index].flags |= BLOCK_LOOSE_LIST;
            }
        }

        // Leave containers we are not part of anymore
        if n_children == 0 && n_parents + n_brothers < self.containers.len() {
            self.leave_child_containers(n_parents + n_brothers);
        }

        // Enter a brother container
        if n_brothers > 0 {
            let task_mark_off = self.containers[n_parents].task_mark_off;
            self.push_container_bytes(BlockType::Li, task_mark_off, 0, BLOCK_CONTAINER_CLOSER);
            self.push_container_bytes(BlockType::Li, container.task_mark_off, 0, BLOCK_CONTAINER_OPENER);
            self.containers[n_parents].is_task = container.is_task;
            self.containers[n_parents].task_mark_off = container.task_mark_off;
        }

        if n_children > 0 {
            self.enter_child_containers(n_children);
        }
        off
    }

    /// `md_process_line`
    fn process_line(&mut self, pivot: &mut Pivot, buffers: &mut [LineAnalysis; 2], current: usize) {
        let line = buffers[current];
        let pivot_type = match *pivot {
            Pivot::Dummy => LineType::Blank,
            Pivot::Buffer(i) => buffers[i].line_type,
        };

        // A blank line ends the current leaf block
        if line.line_type == LineType::Blank {
            self.end_current_block();
            *pivot = Pivot::Dummy;
            return;
        }

        if line.enforce_new_block {
            self.end_current_block();
        }

        // Some line types form blocks on their own
        if line.line_type == LineType::Hr || line.line_type == LineType::AtxHeader {
            self.end_current_block();
            self.start_new_block(&line);
            self.add_line_into_current_block(&line);
            self.end_current_block();
            *pivot = Pivot::Dummy;
            return;
        }

        // A setext underline changes the meaning of the current block and ends it
        if line.line_type == LineType::SetextUnderline {
            let Some(block) = self.current_block() else {
                unreachable!("setext underline without a block");
            };
            block.block_type = BlockType::H;
            block.data = line.data & 0xffff;
            block.flags |= BLOCK_SETEXT_HEADER;
            self.add_line_into_current_block(&line);
            self.end_current_block();
            if self.has_current_block {
                // All the body was consumed as reference definitions and the underline became the start of a new
                // paragraph
                buffers[current].line_type = LineType::Text;
                *pivot = Pivot::Buffer(current);
            } else {
                *pivot = Pivot::Dummy;
            }
            return;
        }

        // The current block also ends if the line has a different type
        if line.line_type != pivot_type {
            self.end_current_block();
        }

        // The line may start a new block
        if !self.has_current_block {
            self.start_new_block(&line);
            *pivot = Pivot::Buffer(current);
        }

        // Otherwise the line continues the current block
        self.add_line_into_current_block(&line);
    }

    /// `md_process_doc`
    fn process_doc(&mut self) {
        let mut pivot = Pivot::Dummy;
        let mut buffers = [DUMMY_BLANK_LINE; 2];
        let mut current = 0;
        let mut off = 0;

        self.r.enter_block(BlockType::Doc, BlockDetail::None);

        while off < self.size {
            if pivot == Pivot::Buffer(current) {
                current = 1 - current;
            }
            let pivot_line = match pivot {
                Pivot::Dummy => DUMMY_BLANK_LINE,
                Pivot::Buffer(i) => buffers[i],
            };
            // The line buffers keep stale data of earlier lines
            let mut line = buffers[current];
            off = self.analyze_line(off, pivot_line, &mut line);
            buffers[current] = line;
            self.process_line(&mut pivot, &mut buffers, current);
        }

        self.end_current_block();
        self.build_ref_def_hashtable();

        // Process all blocks
        self.leave_child_containers(0);
        self.process_all_blocks();

        self.r.leave_block(BlockType::Doc);
    }
}
