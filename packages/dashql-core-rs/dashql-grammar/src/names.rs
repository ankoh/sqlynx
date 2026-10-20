//! The names of a script: identifiers and keywords that may be used as names.

use crate::span::TextSpan;

/// The id of a registered name, unique within a script
pub type NameId = u32;

/// A registered name
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegisteredName {
    /// The name id
    pub name_id: NameId,
    /// The text (lower-cased unless the name was quoted)
    pub text: String,
    /// The location of the first occurrence (empty for names without one)
    pub location: TextSpan,
    /// The number of occurrences
    pub occurrences: u32,
}

/// The names of a script, ids are assigned in order of first registration.
///
/// An open-addressing table over the names (name id + 1 per slot, 0 = empty), so the texts are
/// stored once.
#[derive(Clone, Debug, Default)]
pub struct NameRegistry {
    names: Vec<RegisteredName>,
    table: Vec<u32>,
}

/// A fast hash for short names (FxHash over 8-byte words)
fn hash(text: &[u8]) -> u64 {
    const K: u64 = 0x517c_c1b7_2722_0a95;
    let mut h: u64 = text.len() as u64;
    let mut chunks = text.chunks_exact(8);
    for chunk in &mut chunks {
        let word = u64::from_le_bytes(chunk.try_into().unwrap());
        h = (h.rotate_left(5) ^ word).wrapping_mul(K);
    }
    for &b in chunks.remainder() {
        h = (h.rotate_left(5) ^ b as u64).wrapping_mul(K);
    }
    h
}

impl NameRegistry {
    /// The number of names
    pub fn len(&self) -> usize {
        self.names.len()
    }

    /// Are there no names?
    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }

    /// Get a name
    pub fn get(&self, id: NameId) -> &RegisteredName {
        &self.names[id as usize]
    }

    /// All names in id order
    pub fn iter(&self) -> impl Iterator<Item = &RegisteredName> {
        self.names.iter()
    }

    /// The slot of a name text: either the slot holding it or the empty slot where it belongs
    fn slot(&self, text: &str) -> usize {
        let mask = self.table.len() - 1;
        let mut slot = hash(text.as_bytes()) as usize & mask;
        loop {
            match self.table[slot] {
                0 => return slot,
                id if self.names[id as usize - 1].text == text => return slot,
                _ => slot = (slot + 1) & mask,
            }
        }
    }

    /// Find a name by its text
    pub fn find(&self, text: &str) -> Option<NameId> {
        if self.table.is_empty() {
            return None;
        }
        match self.table[self.slot(text)] {
            0 => None,
            id => Some(id - 1),
        }
    }

    fn grow(&mut self) {
        let capacity = (self.table.len() * 2).max(64);
        self.table = vec![0; capacity];
        let mask = capacity - 1;
        for (i, name) in self.names.iter().enumerate() {
            let mut slot = hash(name.text.as_bytes()) as usize & mask;
            while self.table[slot] != 0 {
                slot = (slot + 1) & mask;
            }
            self.table[slot] = i as u32 + 1;
        }
    }

    /// Register a name. A known name counts another occurrence and keeps its first location.
    pub fn register(&mut self, text: &str, location: TextSpan) -> NameId {
        if (self.names.len() + 1) * 2 > self.table.len() {
            self.grow();
        }
        let slot = self.slot(text);
        match self.table[slot] {
            0 => {
                let id = self.names.len() as NameId;
                self.names.push(RegisteredName {
                    name_id: id,
                    text: text.to_string(),
                    location,
                    occurrences: 1,
                });
                self.table[slot] = id + 1;
                id
            }
            id => {
                self.names[id as usize - 1].occurrences += 1;
                id - 1
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_names_once() {
        let mut names = NameRegistry::default();
        assert_eq!(names.register("foo", TextSpan::new(0, 3)), 0);
        assert_eq!(names.register("bar", TextSpan::new(4, 3)), 1);
        assert_eq!(names.register("foo", TextSpan::new(8, 3)), 0);
        assert_eq!(names.len(), 2);
        assert_eq!(names.get(0).occurrences, 2);
        assert_eq!(names.get(0).location, TextSpan::new(0, 3));
        assert_eq!(names.find("bar"), Some(1));
        assert_eq!(names.find("baz"), None);
    }

    #[test]
    fn grows() {
        let mut names = NameRegistry::default();
        for i in 0..1000 {
            assert_eq!(names.register(&format!("name{i}"), TextSpan::default()), i);
        }
        for i in 0..1000 {
            assert_eq!(names.find(&format!("name{i}")), Some(i));
            assert_eq!(names.register(&format!("name{i}"), TextSpan::default()), i);
        }
        assert_eq!(names.len(), 1000);
    }
}
