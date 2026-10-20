//! Encoders that produce the `expected` YAML of the snapshot tests, ports of the C++ encoders in
//! `packages/dashql-core/src/testing`.
//!
//! Values are typed like the YAML the C++ encoders emit after loading it again: plain scalars go
//! through YAML type inference, double-quoted scalars stay strings.

pub mod analyzer;
pub mod completion;
pub mod parser;
pub mod planner;
pub mod visualize;

use yaml_rust2::yaml::Hash;
use yaml_rust2::Yaml;

/// Texts shorter than this are encoded in full, longer ones as prefix..suffix
const INLINE_LOCATION_CAP: usize = 20;
/// The length of the prefix and suffix of long texts
const LOCATION_HINT_LENGTH: usize = 10;

/// A YAML mapping under construction
#[derive(Default)]
pub struct Map(Hash);

impl Map {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, key: &str, value: Yaml) -> &mut Self {
        self.0.insert(Yaml::String(key.to_string()), value);
        self
    }

    /// A plain scalar, typed by YAML inference
    pub fn plain(&mut self, key: &str, value: &str) -> &mut Self {
        self.insert(key, plain(value))
    }

    /// A double-quoted scalar
    pub fn quoted(&mut self, key: &str, value: &str) -> &mut Self {
        self.insert(key, Yaml::String(value.to_string()))
    }

    pub fn int(&mut self, key: &str, value: i64) -> &mut Self {
        self.insert(key, Yaml::Integer(value))
    }

    pub fn into_yaml(self) -> Yaml {
        Yaml::Hash(self.0)
    }
}

/// A plain scalar, typed by YAML inference
pub fn plain(value: &str) -> Yaml {
    Yaml::from_str(value)
}

/// The text of a location: in full if short, otherwise as prefix..suffix (`EncodeLocationText`)
pub fn location_text(text: &str, offset: u32, length: u32) -> String {
    let bytes = text.as_bytes();
    let offset = offset as usize;
    let length = length as usize;
    let slice = |b: usize, n: usize| String::from_utf8_lossy(&bytes[b.min(bytes.len())..(b + n).min(bytes.len())]).into_owned();
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

/// `EncodeLocationRange`: `key: [begin, end]`
pub fn encode_location_range(map: &mut Map, offset: u32, length: u32, key: &str) {
    map.insert(key, Yaml::Array(vec![Yaml::Integer(offset as i64), Yaml::Integer((offset + length) as i64)]));
}
