//! The name search index of a catalog entry (`CatalogEntry::NameSearchIndex`).
//!
//! The C++ index is a `btree::multimap` from every suffix of every name to the name, ordered
//! case-insensitively, so that a prefix search finds substring matches. Equal keys keep their
//! insertion order. Here the suffixes are a sorted vector of (name, suffix offset) pairs.

use super::entry::CatalogObjectRef;
use crate::utils::{ci_cmp, ci_starts_with};
use dashql_buffers::analyzer::NameTag;
use dashql_parser::span::TextSpan;
use std::sync::Arc;

/// A name of the index (the fields of `RegisteredName` the completion reads)
#[derive(Clone, Debug)]
pub struct IndexedName {
    pub text: Arc<str>,
    pub occurrences: u32,
    /// The location of the first occurrence in the script text
    pub location: TextSpan,
    /// The analyzer tags
    pub tags: NameTag,
    /// The objects the name resolves to
    pub objects: Vec<CatalogObjectRef>,
}

/// The order in which suffixes are inserted
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SuffixOrder {
    /// Shortest suffix first (`AnalyzedScript::GetNameSearchIndex`)
    ShortestFirst,
    /// Longest suffix first (`DescriptorEntry::GetNameSearchIndex`)
    LongestFirst,
}

#[derive(Debug, Default)]
pub struct NameSearchIndex {
    pub names: Vec<IndexedName>,
    /// (name index, byte offset of the suffix), sorted case-insensitively by the suffix
    suffixes: Vec<(u32, u32)>,
}

impl NameSearchIndex {
    pub fn new(names: Vec<IndexedName>, order: SuffixOrder) -> Self {
        let mut suffixes = Vec::new();
        for (i, name) in names.iter().enumerate() {
            let len = name.text.len() as u32;
            match order {
                SuffixOrder::ShortestFirst => suffixes.extend((0..len).rev().map(|offset| (i as u32, offset))),
                SuffixOrder::LongestFirst => suffixes.extend((0..len).map(|offset| (i as u32, offset))),
            }
        }
        let key = |&(name, offset): &(u32, u32)| &names[name as usize].text.as_bytes()[offset as usize..];
        // Stable, so equal keys keep their insertion order
        suffixes.sort_by(|a, b| ci_cmp(key(a), key(b)));
        Self { names, suffixes }
    }

    /// The number of indexed suffixes (the entry count of the C++ multimap)
    pub fn len(&self) -> usize {
        self.suffixes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.suffixes.is_empty()
    }

    /// The bytes of the suffix index
    pub fn byte_size(&self) -> usize {
        self.suffixes.len() * std::mem::size_of::<(u32, u32)>()
    }

    fn suffix(&self, entry: (u32, u32)) -> &[u8] {
        &self.names[entry.0 as usize].text.as_bytes()[entry.1 as usize..]
    }

    /// The names that have a suffix starting with `prefix`, once per matching suffix, in index order
    pub fn search<'a>(&'a self, prefix: &'a [u8]) -> impl Iterator<Item = &'a IndexedName> + 'a {
        let begin = self.suffixes.partition_point(|&e| ci_cmp(self.suffix(e), prefix) == std::cmp::Ordering::Less);
        self.suffixes[begin..]
            .iter()
            .take_while(move |&&e| ci_starts_with(self.suffix(e), prefix))
            .map(move |&(name, _)| &self.names[name as usize])
    }
}
