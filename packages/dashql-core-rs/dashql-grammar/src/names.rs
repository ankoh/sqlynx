//! The names of a script: identifiers and keywords that may be used as names.

use crate::span::TextSpan;
use std::collections::HashMap;

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
#[derive(Clone, Debug, Default)]
pub struct NameRegistry {
    names: Vec<RegisteredName>,
    ids_by_text: HashMap<String, NameId>,
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

    /// Find a name by its text
    pub fn find(&self, text: &str) -> Option<NameId> {
        self.ids_by_text.get(text).copied()
    }

    /// All names in id order
    pub fn iter(&self) -> impl Iterator<Item = &RegisteredName> {
        self.names.iter()
    }

    /// Register a name. A known name counts another occurrence and keeps its first location.
    pub fn register(&mut self, text: &str, location: TextSpan) -> NameId {
        if let Some(&id) = self.ids_by_text.get(text) {
            self.names[id as usize].occurrences += 1;
            return id;
        }
        let id = self.names.len() as NameId;
        self.names.push(RegisteredName {
            name_id: id,
            text: text.to_string(),
            location,
            occurrences: 1,
        });
        self.ids_by_text.insert(text.to_string(), id);
        id
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
}
