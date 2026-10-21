//! Encoders that produce the `expected` YAML of the snapshot tests, ports of the C++ encoders in
//! the C++ `src/testing`.
//!
//! The encoders build styled trees ([`Node`]) so that the snapshotter can write the snapshot files byte for byte
//! like the C++ snapshotter. The tests compare them structurally through [`Node::to_yaml`]: plain scalars go
//! through YAML type inference, quoted scalars stay strings.

pub mod analyzer;
pub mod completion;
pub mod diff;
pub mod parser;
pub mod plan_view_model;
pub mod planner;
pub mod visualize;

use crate::ryml::{Node, Scalar, ScalarStyle};
use yaml_rust2::Yaml;

/// Texts shorter than this are encoded in full, longer ones as prefix..suffix
const INLINE_LOCATION_CAP: usize = 20;
/// The length of the prefix and suffix of long texts
const LOCATION_HINT_LENGTH: usize = 10;

/// A YAML mapping under construction, keys in insertion order
#[derive(Default)]
pub struct Map(pub Vec<(Scalar, Node)>);

impl Map {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, key: &str, value: Node) -> &mut Self {
        self.0.push((Scalar::new(key, ScalarStyle::Auto), value));
        self
    }

    /// A scalar written with `<<`: plain, unless the emitter has to quote it
    pub fn plain(&mut self, key: &str, value: &str) -> &mut Self {
        self.insert(key, plain(value))
    }

    /// A double-quoted scalar
    pub fn quoted(&mut self, key: &str, value: &str) -> &mut Self {
        self.insert(key, Node::dquo(value))
    }

    pub fn int(&mut self, key: &str, value: i64) -> &mut Self {
        self.insert(key, Node::int(value))
    }

    /// `c4::fmt::boolalpha`
    pub fn boolean(&mut self, key: &str, value: bool) -> &mut Self {
        self.insert(key, Node::boolean(value))
    }

    pub fn into_node(self) -> Node {
        Node::Map(self.0, Default::default())
    }

    pub fn into_yaml(self) -> Yaml {
        self.into_node().to_yaml()
    }
}

/// A scalar written with `<<`: plain, unless the emitter has to quote it
pub fn plain(value: &str) -> Node {
    Node::auto(value)
}

/// The text of a location: in full if short, otherwise as prefix..suffix (`EncodeLocationText`)
pub fn location_text(text: &str, offset: u32, length: u32) -> String {
    let bytes = text.as_bytes();
    let offset = offset as usize;
    let length = length as usize;
    let slice =
        |b: usize, n: usize| String::from_utf8_lossy(&bytes[b.min(bytes.len())..(b + n).min(bytes.len())]).into_owned();
    if length < INLINE_LOCATION_CAP {
        slice(offset, length)
    } else {
        let hint = LOCATION_HINT_LENGTH.min(length);
        format!("{}..{}", slice(offset, hint), slice(offset + length - hint, hint))
    }
}

/// `EncodeLocationText`
pub fn encode_location_text(map: &mut Map, text: &str, offset: u32, length: u32, key: &str) {
    map.quoted(key, &location_text(text, offset, length));
}

/// `EncodeLocationRange`: `key: [begin,end]`
pub fn encode_location_range(map: &mut Map, offset: u32, length: u32, key: &str) {
    map.insert(key, Node::flow_seq(vec![Node::int(offset), Node::int(offset + length)]));
}
