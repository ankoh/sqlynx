//! A YAML tree that keeps the emitter style of every node, and an emitter that writes it like rapidyaml.
//!
//! The snapshot files were written by the C++ snapshotter through rapidyaml. To regenerate them byte for byte,
//! the encoders record what the C++ encoders tell rapidyaml: the style of a scalar (plain, quoted, literal, or
//! chosen by the emitter), the style of a container (block, flow), and the order of the keys. Templates are read
//! into the same tree with the styles of their source, which rapidyaml keeps when it emits a parsed tree again.

mod emit;
mod parse;

pub use emit::{emit_entry, emit_root, inject_blank_lines};
pub use parse::parse;

use yaml_rust2::yaml::Hash;
use yaml_rust2::Yaml;

/// The style of a scalar
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ScalarStyle {
    /// Chosen by the emitter (`scalar_style_choose`), the style of values written with `<<`
    #[default]
    Auto,
    Plain,
    SingleQuoted,
    DoubleQuoted,
    /// `|`
    Literal,
    /// `>`
    Folded,
}

/// The style of a sequence or a mapping
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ContainerStyle {
    /// Block style, flow style when empty
    #[default]
    Auto,
    Block,
    /// Flow style on a single line, `[a,b]`
    Flow,
    /// Flow style over multiple lines
    FlowMultiline,
}

/// A scalar: its text and style. A scalar without text is a null value (`key:`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Scalar {
    pub text: Option<String>,
    pub style: ScalarStyle,
}

impl Scalar {
    pub fn new(text: impl Into<String>, style: ScalarStyle) -> Self {
        Self { text: Some(text.into()), style }
    }

    /// The text, empty for null scalars
    pub fn as_str(&self) -> &str {
        self.text.as_deref().unwrap_or("")
    }
}

/// A YAML node with styles
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Node {
    Scalar(Scalar),
    Seq(Vec<Node>, ContainerStyle),
    Map(Vec<(Scalar, Node)>, ContainerStyle),
}

impl Node {
    /// A scalar whose style the emitter chooses, like a value written with `<<` in C++
    pub fn auto(text: impl Into<String>) -> Node {
        Node::Scalar(Scalar::new(text, ScalarStyle::Auto))
    }

    /// A double-quoted scalar (`VAL_DQUO`)
    pub fn dquo(text: impl Into<String>) -> Node {
        Node::Scalar(Scalar::new(text, ScalarStyle::DoubleQuoted))
    }

    /// A single-quoted scalar (`VAL_SQUO`)
    pub fn squo(text: impl Into<String>) -> Node {
        Node::Scalar(Scalar::new(text, ScalarStyle::SingleQuoted))
    }

    /// A block literal (`VAL_LITERAL`)
    pub fn literal(text: impl Into<String>) -> Node {
        Node::Scalar(Scalar::new(text, ScalarStyle::Literal))
    }

    /// A null scalar
    pub fn null() -> Node {
        Node::Scalar(Scalar::default())
    }

    /// An integer, written with `<<`
    pub fn int(value: impl Into<i64>) -> Node {
        Node::auto(value.into().to_string())
    }

    /// A boolean, written with `c4::fmt::boolalpha`
    pub fn boolean(value: bool) -> Node {
        Node::auto(if value { "true" } else { "false" })
    }

    /// A sequence in block style (flow style when empty)
    pub fn seq(items: Vec<Node>) -> Node {
        Node::Seq(items, ContainerStyle::Auto)
    }

    /// A sequence in single-line flow style (`FLOW_SL`)
    pub fn flow_seq(items: Vec<Node>) -> Node {
        Node::Seq(items, ContainerStyle::Flow)
    }

    /// An empty mapping
    pub fn map() -> Node {
        Node::Map(Vec::new(), ContainerStyle::Auto)
    }

    /// The text of a scalar, `None` for containers and null scalars
    pub fn val(&self) -> Option<&str> {
        match self {
            Node::Scalar(s) => s.text.as_deref(),
            _ => None,
        }
    }

    /// The entries of a mapping
    pub fn entries(&self) -> &[(Scalar, Node)] {
        match self {
            Node::Map(entries, _) => entries,
            _ => &[],
        }
    }

    /// The entries of a mapping, mutable
    pub fn entries_mut(&mut self) -> Option<&mut Vec<(Scalar, Node)>> {
        match self {
            Node::Map(entries, _) => Some(entries),
            _ => None,
        }
    }

    /// The items of a sequence, or the values of a mapping (`children()`)
    pub fn children(&self) -> Vec<&Node> {
        match self {
            Node::Seq(items, _) => items.iter().collect(),
            Node::Map(entries, _) => entries.iter().map(|(_, v)| v).collect(),
            Node::Scalar(_) => Vec::new(),
        }
    }

    /// The items of a sequence or the values of a mapping, mutable
    pub fn children_mut(&mut self) -> Vec<&mut Node> {
        match self {
            Node::Seq(items, _) => items.iter_mut().collect(),
            Node::Map(entries, _) => entries.iter_mut().map(|(_, v)| v).collect(),
            Node::Scalar(_) => Vec::new(),
        }
    }

    pub fn is_map(&self) -> bool {
        matches!(self, Node::Map(..))
    }

    /// The value of the first entry with a key (`node[key]`)
    pub fn get(&self, key: &str) -> Option<&Node> {
        self.entries().iter().find(|(k, _)| k.as_str() == key).map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Node> {
        self.entries_mut()?.iter_mut().find(|(k, _)| k.as_str() == key).map(|(_, v)| v)
    }

    /// Does a mapping have a key (`has_child`)?
    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// Append an entry to a mapping
    pub fn push(&mut self, key: &str, value: Node) {
        if let Some(entries) = self.entries_mut() {
            entries.push((Scalar::new(key, ScalarStyle::Auto), value));
        }
    }

    /// Remove the first entry with a key (`remove_child`)
    pub fn remove(&mut self, key: &str) {
        if let Some(entries) = self.entries_mut() {
            if let Some(i) = entries.iter().position(|(k, _)| k.as_str() == key) {
                entries.remove(i);
            }
        }
    }

    /// The node as `yaml_rust2` loads it from the emitted text: plain scalars are typed by YAML inference,
    /// quoted and block scalars are strings.
    pub fn to_yaml(&self) -> Yaml {
        match self {
            Node::Scalar(Scalar { text: None, .. }) => Yaml::Null,
            Node::Scalar(Scalar { text: Some(text), style }) => {
                let style = match style {
                    ScalarStyle::Auto => emit::scalar_style_choose(Some(text)),
                    style => *style,
                };
                match style {
                    ScalarStyle::Auto | ScalarStyle::Plain => Yaml::from_str(text),
                    _ => Yaml::String(text.clone()),
                }
            }
            Node::Seq(items, _) => Yaml::Array(items.iter().map(Node::to_yaml).collect()),
            Node::Map(entries, _) => {
                let mut hash = Hash::new();
                for (key, value) in entries {
                    hash.insert(Yaml::String(key.as_str().to_string()), value.to_yaml());
                }
                Yaml::Hash(hash)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(text: &str) -> String {
        let root = parse(text).unwrap().unwrap();
        let mut out = emit_root(&root);
        inject_blank_lines(&mut out);
        out
    }

    #[test]
    fn keeps_template_styles() {
        let text = "a-snapshots:\n  - name: x\n    input: ''\n    quoted: \"1\"\n    lit: |-\n      select 1\n    catalog: {}\n    list: [1, 2]\n    empty:\n";
        assert_eq!(
            roundtrip(text),
            "a-snapshots:\n\n  - name: x\n    input: ''\n    quoted: \"1\"\n    lit: |-\n      select 1\n    catalog: {}\n    list: [1,2]\n    empty:\n"
        );
    }

    #[test]
    fn chooses_scalar_styles() {
        let mut root = Node::map();
        root.push("a", Node::auto("x: y"));
        root.push("b", Node::auto(""));
        root.push("c", Node::auto("?"));
        root.push("d", Node::auto("-1"));
        root.push("e", Node::auto(" x"));
        root.push("f", Node::dquo("a\"b\nc"));
        root.push("g", Node::literal("a\nb\n"));
        root.push("h", Node::flow_seq(vec![Node::int(1), Node::int(2)]));
        root.push("i", Node::seq(vec![]));
        root.push("j", Node::null());
        assert_eq!(
            emit_root(&root),
            "a: 'x: y'\nb: ''\nc: '?'\nd: -1\ne: \" x\"\nf: \"a\\\"b\\nc\"\ng: |\n  a\n  b\nh: [1,2]\ni: []\nj: \n"
        );
    }

    #[test]
    fn types_like_yaml_rust() {
        let mut root = Node::map();
        root.push("a", Node::int(1));
        root.push("b", Node::dquo("1"));
        root.push("c", Node::auto("?"));
        root.push("d", Node::boolean(true));
        let yaml = root.to_yaml();
        assert_eq!(yaml["a"], Yaml::Integer(1));
        assert_eq!(yaml["b"], Yaml::String("1".into()));
        assert_eq!(yaml["c"], Yaml::String("?".into()));
        assert_eq!(yaml["d"], Yaml::Boolean(true));
    }
}
