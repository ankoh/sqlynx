//! The Markdown renderer spec (`markdown.cc`): a row template with `{{field}}` placeholders compiled into a safe,
//! renderer-neutral document tree.
//!
//! The fields are replaced by unique tokens, the template is parsed with a port of md4c, and the tokens are turned
//! into field nodes again. Raw HTML is dropped, links and images with unsafe URLs or with fields in their URLs
//! become plain spans.

mod entity;
mod md4c;
mod unicode;

use crate::analyzer::types::VisualizationSpec;
use dashql_buffers::visualization::{
    MarkdownNode as MarkdownNodeBuffer, MarkdownNodeArgs, MarkdownNodeType, MarkdownSpec, MarkdownSpecArgs,
};
use flatbuffers::{FlatBufferBuilder, WIPOffset};
use md4c::{Attribute, BlockDetail, BlockType, LinkDetail, Renderer, SpanType, TextType};

/// A node of a compiled document (`MarkdownNodeT`). Empty strings are not set.
#[derive(Clone, Debug, PartialEq)]
pub struct MarkdownNode {
    pub node_type: MarkdownNodeType,
    pub value: String,
    pub url: String,
    pub title: String,
    pub language: String,
    pub level: u8,
    pub start: u32,
    pub ordered: bool,
    pub tight: bool,
    pub children: Vec<MarkdownNode>,
}

impl MarkdownNode {
    pub fn new(node_type: MarkdownNodeType) -> Self {
        Self {
            node_type,
            value: String::new(),
            url: String::new(),
            title: String::new(),
            language: String::new(),
            level: 0,
            start: 0,
            ordered: false,
            tight: false,
            children: Vec::new(),
        }
    }
}

/// A compiled Markdown spec (`MarkdownSpecT`)
#[derive(Clone, Debug, PartialEq)]
pub struct MarkdownDocument {
    /// The row template
    pub template: String,
    /// The distinct field names in order of appearance
    pub fields: Vec<String>,
    pub document: MarkdownNode,
}

/// A field of the template and its token
struct MarkdownField {
    name: Vec<u8>,
    token: Vec<u8>,
}

/// Does `haystack` contain `needle` at or after `from`?
fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from > haystack.len() {
        return None;
    }
    if needle.is_empty() {
        return Some(from);
    }
    haystack[from..].windows(needle.len()).position(|w| w == needle).map(|i| i + from)
}

/// Trim spaces and line breaks (`trim_view(..., is_no_space)`)
fn trim_spaces(s: &[u8]) -> &[u8] {
    let keep = |c: &u8| *c != b' ' && *c != b'\n';
    let Some(begin) = s.iter().position(keep) else {
        return &[];
    };
    let end = s.iter().rposition(keep).unwrap();
    &s[begin..=end]
}

/// Replace `{{field}}` placeholders with tokens that do not occur in the template (`TokenizeFields`)
fn tokenize_fields(row_template: &[u8]) -> (Vec<u8>, Vec<MarkdownField>) {
    let mut prefix = b"DASHQLMARKDOWNFIELD".to_vec();
    while find(row_template, &prefix, 0).is_some() {
        prefix.push(b'X');
    }

    let mut markdown = Vec::with_capacity(row_template.len());
    let mut fields: Vec<MarkdownField> = Vec::new();
    let mut cursor = 0;
    while cursor < row_template.len() {
        let Some(open) = find(row_template, b"{{", cursor) else {
            markdown.extend_from_slice(&row_template[cursor..]);
            break;
        };
        markdown.extend_from_slice(&row_template[cursor..open]);
        let Some(close) = find(row_template, b"}}", open + 2) else {
            markdown.extend_from_slice(&row_template[open..]);
            break;
        };
        let field = trim_spaces(&row_template[open + 2..close]);
        if field.is_empty() {
            markdown.extend_from_slice(&row_template[open..close + 2]);
        } else {
            let index = match fields.iter().position(|f| f.name == field) {
                Some(index) => index,
                None => {
                    let mut token = prefix.clone();
                    token.extend_from_slice(fields.len().to_string().as_bytes());
                    token.extend_from_slice(b"TOKEN");
                    fields.push(MarkdownField { name: field.to_vec(), token });
                    fields.len() - 1
                }
            };
            markdown.extend_from_slice(&fields[index].token);
        }
        cursor = close + 2;
    }
    (markdown, fields)
}

/// The replacement character U+FFFD
const REPLACEMENT: &[u8] = b"\xef\xbf\xbd";

/// `AppendUtf8`: invalid code points become the replacement character
fn append_utf8(out: &mut Vec<u8>, codepoint: u32) {
    if codepoint == 0 || codepoint > 0x10ffff || (0xd800..=0xdfff).contains(&codepoint) {
        out.extend_from_slice(REPLACEMENT);
    } else {
        let c = char::from_u32(codepoint).unwrap();
        let mut buffer = [0; 4];
        out.extend_from_slice(c.encode_utf8(&mut buffer).as_bytes());
    }
}

/// `entity_lookup`: glibc `bsearch` with `strncmp(key, name, key_size)`
fn entity_lookup(key: &[u8]) -> Option<[u32; 2]> {
    let map = entity::ENTITY_MAP;
    let (mut l, mut u) = (0, map.len());
    while l < u {
        let idx = (l + u) / 2;
        let name = map[idx].0.as_bytes();
        let mut cmp = std::cmp::Ordering::Equal;
        for i in 0..key.len() {
            let (a, b) = (key[i], name.get(i).copied().unwrap_or(0));
            if a != b || a == 0 {
                cmp = a.cmp(&b);
                break;
            }
        }
        match cmp {
            std::cmp::Ordering::Less => u = idx,
            std::cmp::Ordering::Greater => l = idx + 1,
            std::cmp::Ordering::Equal => return Some(map[idx].1),
        }
    }
    None
}

/// `DecodeEntity`: numeric and named entities, the raw text if it is unknown
fn decode_entity(text: &[u8], out: &mut Vec<u8>) {
    if text.len() > 3 && text[1] == b'#' {
        let (begin, base) = if text[2] == b'x' || text[2] == b'X' { (3, 16) } else { (2, 10) };
        let mut codepoint: u32 = 0;
        for &c in &text[begin..text.len() - 1] {
            let digit = match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' if base == 16 => c - b'a' + 10,
                b'A'..=b'F' if base == 16 => c - b'A' + 10,
                _ => {
                    out.extend_from_slice(text);
                    return;
                }
            };
            codepoint = codepoint.wrapping_mul(base).wrapping_add(digit as u32);
        }
        append_utf8(out, codepoint);
        return;
    }
    match entity_lookup(text) {
        Some(codepoints) => {
            append_utf8(out, codepoints[0]);
            if codepoints[1] != 0 {
                append_utf8(out, codepoints[1]);
            }
        }
        None => out.extend_from_slice(text),
    }
}

/// `DecodeAttribute`
fn decode_attribute(attribute: &Attribute) -> Vec<u8> {
    let mut out = Vec::with_capacity(attribute.text.len());
    let size = attribute.text.len() as u32;
    let mut i = 0;
    while attribute.substr_offsets[i] < size {
        let offset = attribute.substr_offsets[i] as usize;
        let part = &attribute.text[offset..attribute.substr_offsets[i + 1] as usize];
        match attribute.substr_types[i] {
            TextType::Entity => decode_entity(part, &mut out),
            TextType::NullChar => out.extend_from_slice(REPLACEMENT),
            _ => out.extend_from_slice(part),
        }
        i += 1;
    }
    out
}

/// `IsSafeUrl`: relative URLs and the schemes http, https and mailto
fn is_safe_url(url: &[u8]) -> bool {
    let normalized: Vec<u8> = url.iter().filter(|&&b| b > 0x20 && b != 0x7f).map(|b| b.to_ascii_lowercase()).collect();
    let Some(colon) = normalized.iter().position(|&c| c == b':') else {
        return true;
    };
    if let Some(first_delimiter) = normalized.iter().position(|&c| c == b'/' || c == b'?' || c == b'#') {
        if first_delimiter < colon {
            return true;
        }
    }
    matches!(&normalized[..colon], b"http" | b"https" | b"mailto")
}

fn into_string(bytes: Vec<u8>) -> String {
    super::into_string(bytes)
}

/// Builds the document from the md4c events (`MarkdownBuilder`)
struct MarkdownBuilder<'a> {
    fields: &'a [MarkdownField],
    /// The open nodes, the root first. A node is added to its parent when it is closed.
    stack: Vec<MarkdownNode>,
    suppressed_html_depth: u32,
}

impl<'a> MarkdownBuilder<'a> {
    fn new(fields: &'a [MarkdownField]) -> Self {
        Self { fields, stack: vec![MarkdownNode::new(MarkdownNodeType::DOCUMENT)], suppressed_html_depth: 0 }
    }

    fn take_root(mut self) -> MarkdownNode {
        while self.stack.len() > 1 {
            self.pop_parent();
        }
        self.stack.pop().unwrap()
    }

    fn contains_field_token(&self, text: &[u8]) -> bool {
        self.fields.iter().any(|field| find(text, &field.token, 0).is_some())
    }

    fn append_node(&mut self, node: MarkdownNode, push: bool) {
        if push {
            self.stack.push(node);
        } else {
            self.stack.last_mut().unwrap().children.push(node);
        }
    }

    fn pop_parent(&mut self) {
        if self.stack.len() > 1 {
            let node = self.stack.pop().unwrap();
            self.stack.last_mut().unwrap().children.push(node);
        }
    }

    fn append_leaf(&mut self, node_type: MarkdownNodeType, value: &[u8]) {
        let mut node = MarkdownNode::new(node_type);
        node.value = into_string(value.to_vec());
        self.append_node(node, false);
    }

    /// Text with field tokens replaced by field nodes (`AppendTextWithFields`)
    fn append_text_with_fields(&mut self, text: &[u8]) {
        let mut cursor = 0;
        while cursor < text.len() {
            let mut matched: Option<(usize, usize)> = None;
            for (index, field) in self.fields.iter().enumerate() {
                if let Some(at) = find(text, &field.token, cursor) {
                    if matched.is_none_or(|(matched_at, _)| at < matched_at) {
                        matched = Some((at, index));
                    }
                }
            }
            let Some((matched_at, index)) = matched else {
                self.append_leaf(MarkdownNodeType::TEXT, &text[cursor..]);
                break;
            };
            if matched_at > cursor {
                self.append_leaf(MarkdownNodeType::TEXT, &text[cursor..matched_at]);
            }
            let field = &self.fields[index];
            let (name, token_len) = (field.name.clone(), field.token.len());
            self.append_leaf(MarkdownNodeType::FIELD, &name);
            cursor = matched_at + token_len;
        }
    }

    /// A link or an image, a span if the URL is unsafe or contains a field
    fn link_node(&self, detail: &LinkDetail, node_type: MarkdownNodeType) -> MarkdownNode {
        let url = decode_attribute(&detail.href);
        let title = decode_attribute(&detail.title);
        let safe = is_safe_url(&url) && !self.contains_field_token(&url);
        let title_has_field = self.contains_field_token(&title);
        let mut node = MarkdownNode::new(if safe { node_type } else { MarkdownNodeType::SPAN });
        node.url = into_string(url);
        if !title_has_field {
            node.title = into_string(title);
        }
        node
    }
}

impl Renderer for MarkdownBuilder<'_> {
    fn enter_block(&mut self, block_type: BlockType, detail: BlockDetail) {
        if block_type == BlockType::Html {
            self.suppressed_html_depth += 1;
            return;
        }
        if self.suppressed_html_depth > 0 || block_type == BlockType::Doc {
            return;
        }
        let mut container = true;
        let node = match (block_type, detail) {
            (BlockType::Quote, _) => MarkdownNode::new(MarkdownNodeType::BLOCKQUOTE),
            (BlockType::Ul, BlockDetail::Ul { is_tight }) => {
                let mut node = MarkdownNode::new(MarkdownNodeType::LIST);
                node.tight = is_tight;
                node
            }
            (BlockType::Ol, BlockDetail::Ol { start, is_tight }) => {
                let mut node = MarkdownNode::new(MarkdownNodeType::LIST);
                node.ordered = true;
                node.start = start;
                node.tight = is_tight;
                node
            }
            (BlockType::Li, _) => MarkdownNode::new(MarkdownNodeType::LIST_ITEM),
            (BlockType::Hr, _) => {
                container = false;
                MarkdownNode::new(MarkdownNodeType::THEMATIC_BREAK)
            }
            (BlockType::H, BlockDetail::H { level }) => {
                let mut node = MarkdownNode::new(MarkdownNodeType::HEADING);
                node.level = level as u8;
                node
            }
            (BlockType::Code, BlockDetail::Code { lang }) => {
                let mut node = MarkdownNode::new(MarkdownNodeType::CODE_BLOCK);
                if let Some(lang) = lang {
                    node.language = into_string(decode_attribute(&lang));
                }
                node
            }
            (BlockType::P, _) => MarkdownNode::new(MarkdownNodeType::PARAGRAPH),
            _ => return,
        };
        self.append_node(node, container);
    }

    fn leave_block(&mut self, block_type: BlockType) {
        if block_type == BlockType::Html {
            if self.suppressed_html_depth > 0 {
                self.suppressed_html_depth -= 1;
            }
            return;
        }
        if self.suppressed_html_depth > 0 || block_type == BlockType::Doc || block_type == BlockType::Hr {
            return;
        }
        match block_type {
            BlockType::Quote
            | BlockType::Ul
            | BlockType::Ol
            | BlockType::Li
            | BlockType::H
            | BlockType::Code
            | BlockType::P => self.pop_parent(),
            _ => {}
        }
    }

    fn enter_span(&mut self, span_type: SpanType, detail: Option<LinkDetail>) {
        if self.suppressed_html_depth > 0 {
            return;
        }
        let node = match (span_type, detail) {
            (SpanType::Em, _) => MarkdownNode::new(MarkdownNodeType::EMPHASIS),
            (SpanType::Strong, _) => MarkdownNode::new(MarkdownNodeType::STRONG),
            (SpanType::Code, _) => MarkdownNode::new(MarkdownNodeType::INLINE_CODE),
            (SpanType::A, Some(detail)) => self.link_node(&detail, MarkdownNodeType::LINK),
            (SpanType::Img, Some(detail)) => self.link_node(&detail, MarkdownNodeType::IMAGE),
            _ => MarkdownNode::new(MarkdownNodeType::SPAN),
        };
        self.append_node(node, true);
    }

    fn leave_span(&mut self, _span_type: SpanType) {
        if self.suppressed_html_depth == 0 {
            self.pop_parent();
        }
    }

    fn text(&mut self, text_type: TextType, text: &[u8]) {
        if self.suppressed_html_depth > 0 || text_type == TextType::Html {
            return;
        }
        match text_type {
            TextType::Br => self.append_leaf(MarkdownNodeType::HARD_BREAK, b""),
            TextType::SoftBr => self.append_leaf(MarkdownNodeType::TEXT, b"\n"),
            TextType::NullChar => self.append_text_with_fields(REPLACEMENT),
            TextType::Entity => {
                let mut decoded = Vec::new();
                decode_entity(text, &mut decoded);
                self.append_text_with_fields(&decoded);
            }
            _ => self.append_text_with_fields(text),
        }
    }
}

/// Compile a Markdown row template into a document (`CompileMarkdownSpec` without the spec)
pub fn compile_markdown_template(row_template: &str) -> Option<MarkdownDocument> {
    let (markdown, fields) = tokenize_fields(row_template.as_bytes());
    if markdown.len() > u32::MAX as usize {
        return None;
    }
    let mut builder = MarkdownBuilder::new(&fields);
    md4c::parse(&markdown, &mut builder);
    let document = builder.take_root();
    Some(MarkdownDocument {
        template: row_template.to_string(),
        fields: fields.into_iter().map(|field| into_string(field.name)).collect(),
        document,
    })
}

/// Compile the Markdown spec of a visualization (`CompileMarkdownSpec`), `None` if it has none
pub fn compile_markdown_spec(spec: &VisualizationSpec) -> Option<MarkdownDocument> {
    compile_markdown_template(&spec.markdown.as_ref()?.row_template)
}

/// Pack a node like the C++ object API does: empty strings and vectors are omitted
fn pack_markdown_node<'a>(
    builder: &mut FlatBufferBuilder<'a>,
    node: &MarkdownNode,
) -> WIPOffset<MarkdownNodeBuffer<'a>> {
    let mut string = |s: &str| if s.is_empty() { None } else { Some(builder.create_string(s)) };
    let value = string(&node.value);
    let url = string(&node.url);
    let title = string(&node.title);
    let language = string(&node.language);
    let children = if node.children.is_empty() {
        None
    } else {
        let children: Vec<_> = node.children.iter().map(|child| pack_markdown_node(builder, child)).collect();
        Some(builder.create_vector(&children))
    };
    MarkdownNodeBuffer::create(
        builder,
        &MarkdownNodeArgs {
            node_type: node.node_type,
            value,
            url,
            title,
            language,
            level: node.level,
            start: node.start,
            ordered: node.ordered,
            tight: node.tight,
            children,
        },
    )
}

/// Pack a compiled document (`PackMarkdownSpec`)
pub fn pack_markdown_spec<'a>(
    builder: &mut FlatBufferBuilder<'a>,
    spec: &MarkdownDocument,
) -> WIPOffset<MarkdownSpec<'a>> {
    let template = if spec.template.is_empty() { None } else { Some(builder.create_string(&spec.template)) };
    let fields = if spec.fields.is_empty() {
        None
    } else {
        let fields: Vec<_> = spec.fields.iter().map(|f| builder.create_string(f)).collect();
        Some(builder.create_vector(&fields))
    };
    let document = Some(pack_markdown_node(builder, &spec.document));
    MarkdownSpec::create(builder, &MarkdownSpecArgs { template, fields, document })
}

#[cfg(test)]
mod tests;
