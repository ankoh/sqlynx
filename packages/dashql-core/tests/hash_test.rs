//! Tests of the FxHash maps of the core.

use dashql_core::hash::{FxHasher, HashMap, HashSet};
use std::hash::{Hash, Hasher};

fn hash_of<T: Hash>(value: T) -> u64 {
    let mut hasher = FxHasher::default();
    value.hash(&mut hasher);
    hasher.finish()
}

#[test]
fn empty_hash_is_zero() {
    assert_eq!(FxHasher::default().finish(), 0);
}

#[test]
fn hashes_are_deterministic() {
    assert_eq!(hash_of("name"), hash_of("name"));
    assert_eq!(hash_of(42u32), hash_of(42u32));
}

#[test]
fn integer_widths_hash_their_value() {
    for value in [0u8, 1, 200] {
        assert_eq!(hash_of(value), hash_of(value as u16));
        assert_eq!(hash_of(value as u16), hash_of(value as u32));
        assert_eq!(hash_of(value as u32), hash_of(value as u64));
        assert_eq!(hash_of(value as u64), hash_of(value as usize));
    }
}

#[test]
fn different_values_differ() {
    assert_ne!(hash_of(1u16), hash_of(2u16));
    assert_ne!(hash_of(1usize), hash_of(2usize));
    assert_ne!(hash_of("a"), hash_of("b"));
    assert_ne!(hash_of(1u32), hash_of(1u32 << 31));
}

#[test]
fn byte_chunks_and_remainder_contribute() {
    let mut a = FxHasher::default();
    a.write(b"12345678");
    let mut b = FxHasher::default();
    b.write(b"123456789");
    let mut c = FxHasher::default();
    c.write(b"12345678a");
    assert_ne!(a.finish(), b.finish());
    assert_ne!(b.finish(), c.finish());
}

#[test]
fn maps_and_sets_work() {
    let mut map: HashMap<u16, &str> = HashMap::default();
    map.insert(1, "one");
    map.insert(2, "two");
    assert_eq!(map.get(&1), Some(&"one"));
    assert_eq!(map.get(&3), None);
    let mut set: HashSet<usize> = HashSet::default();
    assert!(set.insert(7));
    assert!(!set.insert(7));
    let mut names: HashMap<String, usize> = HashMap::default();
    names.insert("a".into(), 1);
    assert_eq!(names["a"], 1);
}
