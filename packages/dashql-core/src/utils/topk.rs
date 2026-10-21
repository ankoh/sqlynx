//! A top-k heap (`include/dashql/utils/topk.h`).
//!
//! The heap is a min heap over at most `capacity` entries: a new entry replaces the minimum if the
//! minimum is less. The order should be total, then the top k and their order are well-defined.

use std::cmp::Ordering;

pub struct TopKHeap<T, C: Fn(&T, &T) -> Ordering> {
    entries: Vec<T>,
    capacity: usize,
    cmp: C,
}

impl<T, C: Fn(&T, &T) -> Ordering> TopKHeap<T, C> {
    pub fn new(capacity: usize, cmp: C) -> Self {
        Self { entries: Vec::with_capacity(capacity), capacity, cmp }
    }

    fn less(&self, l: usize, r: usize) -> bool {
        (self.cmp)(&self.entries[l], &self.entries[r]) == Ordering::Less
    }

    /// Move an entry down until the first `len` entries are a min heap below it
    fn sift_down(&mut self, mut i: usize, len: usize) {
        loop {
            let l = 2 * i + 1;
            let r = 2 * i + 2;
            let mut smallest = i;
            if l < len && self.less(l, smallest) {
                smallest = l;
            }
            if r < len && self.less(r, smallest) {
                smallest = r;
            }
            if smallest == i {
                break;
            }
            self.entries.swap(i, smallest);
            i = smallest;
        }
    }

    /// Make the entries a min heap
    fn heapify(&mut self) {
        let len = self.entries.len();
        for i in (0..len / 2).rev() {
            self.sift_down(i, len);
        }
    }

    pub fn insert(&mut self, value: T) {
        if self.entries.len() < self.capacity {
            self.entries.push(value);
            if self.entries.len() == self.capacity {
                self.heapify();
            }
        } else if self.capacity > 0 && (self.cmp)(&self.entries[0], &value) == Ordering::Less {
            self.entries[0] = value;
            self.sift_down(0, self.capacity);
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Sort the entries in descending order: heap sort, moving the minimum to the end
    pub fn finish(&mut self) -> &mut Vec<T> {
        if self.entries.len() < self.capacity {
            self.heapify();
        }
        for end in (1..self.entries.len()).rev() {
            self.entries.swap(0, end);
            self.sift_down(0, end);
        }
        &mut self.entries
    }

    pub fn entries(&self) -> &[T] {
        &self.entries
    }

    pub fn take_entries(&mut self) -> Vec<T> {
        std::mem::take(&mut self.entries)
    }
}
