//! A port of `packages/dashql-core/test/topk_test.cc`.

use dashql_core::utils::topk::TopKHeap;
use std::cmp::Ordering;

#[derive(Clone, Copy, Debug)]
struct Entry {
    value: usize,
    score: usize,
}

fn entry(value: usize, score: usize) -> Entry {
    Entry { value, score }
}

fn cmp(l: &Entry, r: &Entry) -> Ordering {
    l.score.cmp(&r.score)
}

/// Insert the entries into a heap of capacity k and return the values of the top k, best first
fn top_k(k: usize, entries: impl IntoIterator<Item = Entry>) -> Vec<usize> {
    let mut heap = TopKHeap::new(k, cmp);
    for e in entries {
        heap.insert(e);
    }
    heap.finish().iter().map(|e| e.value).collect()
}

#[test]
fn empty() {
    assert_eq!(top_k(4, []), Vec::<usize>::new());
}

#[test]
fn ordered_1() {
    assert_eq!(top_k(4, [entry(0, 10)]), [0]);
}

#[test]
fn ordered_2() {
    assert_eq!(top_k(4, [entry(0, 10), entry(1, 20)]), [1, 0]);
}

#[test]
fn swap_2() {
    assert_eq!(top_k(4, [entry(0, 20), entry(1, 10)]), [0, 1]);
}

#[test]
fn capacity_reached() {
    assert_eq!(top_k(4, [entry(0, 50), entry(1, 40), entry(2, 30), entry(3, 20)]), [0, 1, 2, 3]);
}

#[test]
fn capacity_exceeded_1() {
    assert_eq!(top_k(4, [entry(0, 50), entry(1, 40), entry(2, 30), entry(3, 20), entry(4, 10)]), [0, 1, 2, 3]);
}

#[test]
fn ascending_sequence() {
    let values = top_k(10, (0..1000).map(|i| entry(i, i * 10)));
    assert_eq!(values, [999, 998, 997, 996, 995, 994, 993, 992, 991, 990]);
}

#[test]
fn descending_sequence() {
    let values = top_k(10, (0..1000).map(|i| entry(i, 1000 * 10 - i * 10)));
    assert_eq!(values, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
}
