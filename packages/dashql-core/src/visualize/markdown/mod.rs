//! The Markdown renderer spec: a row template with `{{field}}` placeholders compiled into a safe, renderer-neutral
//! document tree.
//!
//! The fields are replaced by unique tokens, the template is parsed as CommonMark with pulldown-cmark, and the tokens
//! are turned into field nodes again. Raw HTML is dropped, links and images with unsafe URLs or with fields in their
//! URLs become plain spans. Adjacent text is merged into one text node, soft line breaks are text (`\n`).

use crate::analyzer::types::VisualizationSpec;
use dashql_buffers::visualization::{
    MarkdownNode as MarkdownNodeBuffer, MarkdownNodeArgs, MarkdownNodeType, MarkdownSpec, MarkdownSpecArgs,
};
use flatbuffers::{FlatBufferBuilder, WIPOffset};
use pulldown_cmark::{CodeBlockKind, Event, LinkType, Parser, Tag, TagEnd};

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

    fn leaf(node_type: MarkdownNodeType, value: &str) -> Self {
        Self { value: value.to_string(), ..Self::new(node_type) }
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

/// A field of the template and the token that stands for it in the parsed Markdown
struct MarkdownField {
    name: String,
    token: String,
}

/// Replace `{{field}}` placeholders with tokens that do not occur in the template
fn tokenize_fields(row_template: &str) -> (String, Vec<MarkdownField>) {
    let mut prefix = String::from("DASHQLMARKDOWNFIELD");
    while row_template.contains(&prefix) {
        prefix.push('X');
    }

    let mut markdown = String::with_capacity(row_template.len());
    let mut fields: Vec<MarkdownField> = Vec::new();
    let mut rest = row_template;
    while let Some(open) = rest.find("{{") {
        let Some(close) = rest[open + 2..].find("}}").map(|close| open + 2 + close) else {
            break;
        };
        markdown.push_str(&rest[..open]);
        let name = rest[open + 2..close].trim_matches([' ', '\n']);
        if name.is_empty() {
            markdown.push_str(&rest[open..close + 2]);
        } else {
            let index = fields.iter().position(|field| field.name == name).unwrap_or_else(|| {
                let token = format!("{prefix}{}TOKEN", fields.len());
                fields.push(MarkdownField { name: name.to_string(), token });
                fields.len() - 1
            });
            markdown.push_str(&fields[index].token);
        }
        rest = &rest[close + 2..];
    }
    markdown.push_str(rest);
    (markdown, fields)
}

/// Relative URLs and the schemes http, https and mailto are safe
fn is_safe_url(url: &str) -> bool {
    let normalized: String = url.chars().filter(|&c| c > ' ' && c != '\x7f').map(|c| c.to_ascii_lowercase()).collect();
    let Some(colon) = normalized.find(':') else {
        return true;
    };
    if normalized.find(['/', '?', '#']).is_some_and(|delimiter| delimiter < colon) {
        return true;
    }
    matches!(&normalized[..colon], "http" | "https" | "mailto")
}

/// Builds the document tree from the pulldown-cmark events
struct DocumentBuilder<'a> {
    fields: &'a [MarkdownField],
    /// The open nodes, the root first. A node is added to its parent when it is closed.
    stack: Vec<MarkdownNode>,
    /// Text that is not yet added, so that adjacent text events become one node
    text: String,
    /// Inside a raw HTML block, which is dropped
    in_html_block: bool,
}

impl<'a> DocumentBuilder<'a> {
    fn new(fields: &'a [MarkdownField]) -> Self {
        Self {
            fields,
            stack: vec![MarkdownNode::new(MarkdownNodeType::DOCUMENT)],
            text: String::new(),
            in_html_block: false,
        }
    }

    fn finish(mut self) -> MarkdownNode {
        self.flush_text();
        while self.stack.len() > 1 {
            self.close();
        }
        self.stack.pop().unwrap()
    }

    fn contains_field(&self, text: &str) -> bool {
        self.fields.iter().any(|field| text.contains(&field.token))
    }

    fn append(&mut self, node: MarkdownNode) {
        self.stack.last_mut().unwrap().children.push(node);
    }

    fn open(&mut self, node: MarkdownNode) {
        self.flush_text();
        self.stack.push(node);
    }

    fn close(&mut self) {
        self.flush_text();
        if self.stack.len() > 1 {
            let mut node = self.stack.pop().unwrap();
            if node.node_type == MarkdownNodeType::LIST {
                // pulldown-cmark does not report the tightness of a list, but it omits the paragraphs of tight items
                node.tight = !node
                    .children
                    .iter()
                    .any(|item| item.children.iter().any(|child| child.node_type == MarkdownNodeType::PARAGRAPH));
            }
            self.append(node);
        }
    }

    /// Add the pending text, with field tokens replaced by field nodes
    fn flush_text(&mut self) {
        if !self.text.is_empty() {
            let text = std::mem::take(&mut self.text);
            self.append_text(&text);
        }
    }

    fn append_text(&mut self, text: &str) {
        let mut rest = text;
        while !rest.is_empty() {
            let next_field = self
                .fields
                .iter()
                .filter_map(|field| rest.find(&field.token).map(|at| (at, field)))
                .min_by_key(|(at, _)| *at);
            let Some((at, field)) = next_field else {
                self.append(MarkdownNode::leaf(MarkdownNodeType::TEXT, rest));
                break;
            };
            if at > 0 {
                self.append(MarkdownNode::leaf(MarkdownNodeType::TEXT, &rest[..at]));
            }
            self.append(MarkdownNode::leaf(MarkdownNodeType::FIELD, &field.name));
            rest = &rest[at + field.token.len()..];
        }
    }

    /// A link or an image, a span if the URL is unsafe or contains a field
    fn link(&self, node_type: MarkdownNodeType, link_type: LinkType, url: &str, title: &str) -> MarkdownNode {
        let url = if link_type == LinkType::Email { format!("mailto:{url}") } else { url.to_string() };
        let safe = is_safe_url(&url) && !self.contains_field(&url);
        let mut node = MarkdownNode::new(if safe { node_type } else { MarkdownNodeType::SPAN });
        if !self.contains_field(title) {
            node.title = title.to_string();
        }
        node.url = url;
        node
    }

    fn start(&mut self, tag: Tag) {
        let node = match tag {
            Tag::Paragraph => MarkdownNode::new(MarkdownNodeType::PARAGRAPH),
            Tag::Heading { level, .. } => {
                MarkdownNode { level: level as u8, ..MarkdownNode::new(MarkdownNodeType::HEADING) }
            }
            Tag::BlockQuote(_) => MarkdownNode::new(MarkdownNodeType::BLOCKQUOTE),
            Tag::CodeBlock(kind) => {
                let language = match kind {
                    CodeBlockKind::Fenced(info) => info.split_whitespace().next().unwrap_or_default().to_string(),
                    CodeBlockKind::Indented => String::new(),
                };
                MarkdownNode { language, ..MarkdownNode::new(MarkdownNodeType::CODE_BLOCK) }
            }
            Tag::List(start) => MarkdownNode {
                ordered: start.is_some(),
                start: start.map_or(0, |start| u32::try_from(start).unwrap_or(u32::MAX)),
                ..MarkdownNode::new(MarkdownNodeType::LIST)
            },
            Tag::Item => MarkdownNode::new(MarkdownNodeType::LIST_ITEM),
            Tag::Emphasis => MarkdownNode::new(MarkdownNodeType::EMPHASIS),
            Tag::Strong => MarkdownNode::new(MarkdownNodeType::STRONG),
            Tag::Link { link_type, dest_url, title, .. } => {
                self.link(MarkdownNodeType::LINK, link_type, &dest_url, &title)
            }
            Tag::Image { link_type, dest_url, title, .. } => {
                self.link(MarkdownNodeType::IMAGE, link_type, &dest_url, &title)
            }
            Tag::HtmlBlock => {
                self.in_html_block = true;
                return;
            }
            // The extensions are not enabled
            _ => MarkdownNode::new(MarkdownNodeType::SPAN),
        };
        self.open(node);
    }

    fn event(&mut self, event: Event) {
        if self.in_html_block {
            self.in_html_block = event != Event::End(TagEnd::HtmlBlock);
            return;
        }
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(_) => self.close(),
            Event::Text(text) => self.text.push_str(&text),
            Event::SoftBreak => self.text.push('\n'),
            Event::Code(code) => {
                self.open(MarkdownNode::new(MarkdownNodeType::INLINE_CODE));
                self.append_text(&code);
                self.close();
            }
            Event::HardBreak => {
                self.flush_text();
                self.append(MarkdownNode::new(MarkdownNodeType::HARD_BREAK));
            }
            Event::Rule => {
                self.flush_text();
                self.append(MarkdownNode::new(MarkdownNodeType::THEMATIC_BREAK));
            }
            // Inline HTML is dropped, the other events belong to extensions that are not enabled
            _ => {}
        }
    }
}

/// Compile a Markdown row template into a document
pub fn compile_markdown_template(row_template: &str) -> MarkdownDocument {
    let (markdown, fields) = tokenize_fields(row_template);
    // CommonMark replaces NUL characters for security reasons, pulldown-cmark leaves that to the caller
    let markdown = markdown.replace('\0', "\u{fffd}");
    let mut builder = DocumentBuilder::new(&fields);
    for event in Parser::new(&markdown) {
        builder.event(event);
    }
    let document = builder.finish();
    MarkdownDocument {
        template: row_template.to_string(),
        fields: fields.into_iter().map(|field| field.name).collect(),
        document,
    }
}

/// Compile the Markdown spec of a visualization, `None` if it has none
pub fn compile_markdown_spec(spec: &VisualizationSpec) -> Option<MarkdownDocument> {
    Some(compile_markdown_template(&spec.markdown.as_ref()?.row_template))
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
