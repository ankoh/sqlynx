//! Read a YAML document into a styled tree, keeping the styles rapidyaml records when it parses a tree: the style of
//! every scalar, block or flow containers, and flow containers that span multiple lines. Comments are dropped.

use super::{ContainerStyle, Node, Scalar, ScalarStyle};
use yaml_rust2::parser::{Event, Parser};
use yaml_rust2::scanner::{Marker, TScalarStyle};

/// A container under construction
enum Open {
    Seq(Vec<Node>, ContainerStyle, usize),
    Map(Vec<(Scalar, Node)>, Option<Scalar>, ContainerStyle, usize),
}

fn scalar(text: String, style: TScalarStyle) -> Scalar {
    let style = match style {
        // An empty plain scalar is a null value
        TScalarStyle::Plain if text.is_empty() => return Scalar { text: None, style: ScalarStyle::Plain },
        TScalarStyle::Plain => ScalarStyle::Plain,
        TScalarStyle::SingleQuoted => ScalarStyle::SingleQuoted,
        TScalarStyle::DoubleQuoted => ScalarStyle::DoubleQuoted,
        TScalarStyle::Literal => ScalarStyle::Literal,
        TScalarStyle::Folded => ScalarStyle::Folded,
    };
    Scalar { text: Some(text), style }
}

/// Parse the first document of a YAML text. Returns `None` for an empty text.
pub fn parse(text: &str) -> Result<Option<Node>, String> {
    let chars: Vec<char> = text.chars().collect();
    let is_flow = |mark: &Marker, open: char| chars.get(mark.index()) == Some(&open);
    let mut parser = Parser::new_from_str(text);
    let mut stack: Vec<Open> = Vec::new();
    let mut root: Option<Node> = None;

    // Attach a finished node to its parent, or make it the root
    fn attach(stack: &mut [Open], root: &mut Option<Node>, node: Node) -> Result<(), String> {
        match stack.last_mut() {
            None => {
                if root.is_none() {
                    *root = Some(node);
                }
            }
            Some(Open::Seq(items, ..)) => items.push(node),
            Some(Open::Map(entries, key, ..)) => match key.take() {
                Some(k) => entries.push((k, node)),
                None => match node {
                    Node::Scalar(k) => *key = Some(k),
                    _ => return Err("containers as mapping keys are not supported".into()),
                },
            },
        }
        Ok(())
    }

    loop {
        let (event, mark) = parser.next_token().map_err(|e| e.to_string())?;
        match event {
            Event::StreamEnd => break,
            Event::Nothing | Event::StreamStart | Event::DocumentStart | Event::DocumentEnd => {}
            Event::Alias(_) => return Err("aliases are not supported".into()),
            Event::Scalar(value, style, _, _) => attach(&mut stack, &mut root, Node::Scalar(scalar(value, style)))?,
            Event::SequenceStart(..) => {
                let style = if is_flow(&mark, '[') { ContainerStyle::Flow } else { ContainerStyle::Block };
                stack.push(Open::Seq(Vec::new(), style, mark.line()));
            }
            Event::MappingStart(..) => {
                let style = if is_flow(&mark, '{') { ContainerStyle::Flow } else { ContainerStyle::Block };
                stack.push(Open::Map(Vec::new(), None, style, mark.line()));
            }
            Event::SequenceEnd | Event::MappingEnd => {
                let node = match stack.pop() {
                    Some(Open::Seq(items, style, line)) => Node::Seq(items, multiline(style, line, &mark)),
                    Some(Open::Map(entries, _, style, line)) => Node::Map(entries, multiline(style, line, &mark)),
                    None => return Err("unbalanced YAML events".into()),
                };
                attach(&mut stack, &mut root, node)?;
            }
        }
    }
    Ok(root)
}

/// A flow container that ends on a later line than it starts is a multi-line flow container
fn multiline(style: ContainerStyle, start_line: usize, end: &Marker) -> ContainerStyle {
    if style == ContainerStyle::Flow && end.line() > start_line {
        ContainerStyle::FlowMultiline
    } else {
        style
    }
}
