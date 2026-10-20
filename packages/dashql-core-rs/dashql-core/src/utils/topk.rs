//! A top-k heap (`include/dashql/utils/topk.h`).
//!
//! The heap is a min heap over at most `capacity` entries: a new entry replaces the minimum if the
//! minimum is less. The sorts use [`std_sort`] so that ties come out in the C++ order.

use super::sort::std_sort;

pub struct TopKHeap<T, L: Fn(&T, &T) -> bool> {
    entries: Vec<T>,
    capacity: usize,
    less: L,
}

impl<T, L: Fn(&T, &T) -> bool> TopKHeap<T, L> {
    pub fn new(capacity: usize, less: L) -> Self {
        Self { entries: Vec::with_capacity(capacity), capacity, less }
    }

    /// Move the root down until the heap property holds
    fn fix_heap(&mut self) {
        let mut i = 0;
        loop {
            let l = 2 * i + 1;
            let r = 2 * i + 2;
            let mut best = i;
            if l < self.entries.len() && (self.less)(&self.entries[l], &self.entries[best]) {
                best = l;
            }
            if r < self.entries.len() && (self.less)(&self.entries[r], &self.entries[best]) {
                best = r;
            }
            if best == i {
                break;
            }
            self.entries.swap(i, best);
            i = best;
        }
    }

    pub fn insert(&mut self, value: T) {
        if self.entries.len() < self.capacity {
            self.entries.push(value);
            if self.entries.len() == self.capacity {
                std_sort(&mut self.entries, &self.less);
            }
        } else if self.capacity > 0 && (self.less)(&self.entries[0], &value) {
            self.entries[0] = value;
            self.fix_heap();
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Sort the entries in descending order
    pub fn finish(&mut self) -> &mut Vec<T> {
        let less = &self.less;
        std_sort(&mut self.entries, &|l: &T, r: &T| less(r, l));
        &mut self.entries
    }

    pub fn entries(&self) -> &[T] {
        &self.entries
    }

    pub fn take_entries(&mut self) -> Vec<T> {
        std::mem::take(&mut self.entries)
    }
}
