//! Attribute lookups over the children of an AST object (`include/dashql/utils/ast_attributes.h`).
//!
//! The C++ core looks up several attributes at once through a `frozen::unordered_map` that is built
//! at compile time. [`attrs!`](crate::attrs) fixes the keys at compile time as well, rejects
//! duplicate keys during constant evaluation, and then scans the children against the constant key
//! array. LLVM vectorizes that comparison, which measured faster than a static perfect hash table
//! and than a direct-index table for every object size of the grammar (see docs/rust-port/README.md).
//!
//! The semantics follow the C++ lookup exactly:
//! - with a single key, the first child with that key is returned,
//! - with several keys, the last child with each key is returned.

pub use dashql_buffers::parser::AttributeKey;
use dashql_buffers::parser::Node;

/// Copy constant keys into an array, rejecting duplicates (evaluated at compile time)
pub const fn key_array<const N: usize>(keys: &[AttributeKey]) -> [AttributeKey; N] {
    assert!(keys.len() == N);
    let mut out = [AttributeKey::NONE; N];
    let mut i = 0;
    while i < N {
        let mut j = i + 1;
        while j < N {
            assert!(keys[i].0 != keys[j].0, "duplicate attribute key");
            j += 1;
        }
        out[i] = keys[i];
        i += 1;
    }
    out
}

/// Find the last child with each key
#[inline(always)]
pub fn lookup_last<'a, const N: usize>(children: &'a [Node], keys: &[AttributeKey; N]) -> [Option<&'a Node>; N] {
    let mut out = [None; N];
    for child in children {
        let key = child.attribute_key();
        for (slot, k) in out.iter_mut().zip(keys.iter()) {
            if key == *k {
                *slot = Some(child);
            }
        }
    }
    out
}

/// Find the first child with a key
#[inline(always)]
pub fn lookup_first(children: &[Node], key: AttributeKey) -> [Option<&Node>; 1] {
    [children.iter().find(|c| c.attribute_key() == key)]
}

/// Look up attributes in the children of an object: `attrs!(children, [KEY_A, KEY_B])` returns
/// `[Option<&Node>; 2]`.
///
/// A single key returns the first child with that key, several keys the last child with each key.
/// The keys must be constant expressions.
#[macro_export]
macro_rules! attrs {
    ($children:expr, [$key:expr $(,)?] $(,)?) => {
        $crate::attributes::lookup_first($children, $key)
    };
    ($children:expr, [$($key:expr),+ $(,)?] $(,)?) => {{
        const KEY_LIST: &[$crate::attributes::AttributeKey] = &[$($key),+];
        const KEYS: [$crate::attributes::AttributeKey; KEY_LIST.len()] = $crate::attributes::key_array(KEY_LIST);
        $crate::attributes::lookup_last($children, &KEYS)
    }};
}

#[cfg(test)]
mod tests {
    use dashql_buffers::parser::{AttributeKey, Node, NodeType, SymbolSpan};

    fn node(key: AttributeKey, value: u32) -> Node {
        Node::new(&SymbolSpan::new(0, 0), NodeType::NONE, key, 0, value, 0)
    }

    #[test]
    fn single_key_finds_first() {
        let children = [node(AttributeKey::SQL_SELECT_FROM, 1), node(AttributeKey::SQL_SELECT_FROM, 2)];
        let [from] = attrs!(&children, [AttributeKey::SQL_SELECT_FROM]);
        assert_eq!(from.unwrap().children_begin_or_value(), 1);
    }

    #[test]
    fn several_keys_find_last() {
        let children = [
            node(AttributeKey::SQL_SELECT_FROM, 1),
            node(AttributeKey::SQL_SELECT_WHERE, 2),
            node(AttributeKey::SQL_SELECT_FROM, 3),
            node(AttributeKey::NONE, 4),
        ];
        let [from, where_, limit] = attrs!(
            &children,
            [AttributeKey::SQL_SELECT_FROM, AttributeKey::SQL_SELECT_WHERE, AttributeKey::SQL_SELECT_LIMIT]
        );
        assert_eq!(from.unwrap().children_begin_or_value(), 3);
        assert_eq!(where_.unwrap().children_begin_or_value(), 2);
        assert!(limit.is_none());
    }
}
