//! Sorting with the exact element order of libstdc++'s `std::sort`.
//!
//! `std::sort` is unstable: elements that compare equal end up in an order that depends on the
//! algorithm. The completion ranks candidates with ties, so the port reproduces the introsort of
//! libstdc++ (median-of-three pivot, unguarded partition, final insertion sort over blocks of 16)
//! instead of using the stable `slice::sort_by`.

const THRESHOLD: usize = 16;

/// Sort like libstdc++ `std::sort(first, last, less)`
pub fn std_sort<T>(v: &mut [T], less: &impl Fn(&T, &T) -> bool) {
    if v.len() < 2 {
        return;
    }
    let depth_limit = 2 * (usize::BITS - 1 - v.len().leading_zeros()) as usize;
    introsort_loop(v, depth_limit, less);
    final_insertion_sort(v, less);
}

fn introsort_loop<T>(mut v: &mut [T], mut depth_limit: usize, less: &impl Fn(&T, &T) -> bool) {
    while v.len() > THRESHOLD {
        if depth_limit == 0 {
            // std::__partial_sort(first, last, last): heap sort
            make_heap(v, less);
            sort_heap(v, less);
            return;
        }
        depth_limit -= 1;
        let cut = unguarded_partition_pivot(v, less);
        let (left, right) = v.split_at_mut(cut);
        introsort_loop(right, depth_limit, less);
        v = left;
    }
}

/// `__move_median_to_first(result, a, b, c)`
fn move_median_to_first<T>(v: &mut [T], result: usize, a: usize, b: usize, c: usize, less: &impl Fn(&T, &T) -> bool) {
    if less(&v[a], &v[b]) {
        if less(&v[b], &v[c]) {
            v.swap(result, b);
        } else if less(&v[a], &v[c]) {
            v.swap(result, c);
        } else {
            v.swap(result, a);
        }
    } else if less(&v[a], &v[c]) {
        v.swap(result, a);
    } else if less(&v[b], &v[c]) {
        v.swap(result, c);
    } else {
        v.swap(result, b);
    }
}

/// `__unguarded_partition_pivot`, returns the cut
fn unguarded_partition_pivot<T>(v: &mut [T], less: &impl Fn(&T, &T) -> bool) -> usize {
    let len = v.len();
    let mid = len / 2;
    move_median_to_first(v, 0, 1, mid, len - 1, less);
    // __unguarded_partition(first + 1, last, first)
    let mut first = 1;
    let mut last = len;
    loop {
        while less(&v[first], &v[0]) {
            first += 1;
        }
        last -= 1;
        while less(&v[0], &v[last]) {
            last -= 1;
        }
        if first >= last {
            return first;
        }
        v.swap(first, last);
        first += 1;
    }
}

/// `__unguarded_linear_insert(last)`
fn unguarded_linear_insert<T>(v: &mut [T], mut last: usize, less: &impl Fn(&T, &T) -> bool) {
    // Rotating the element down by swaps visits the same comparisons as the move-based loop
    while less(&v[last], &v[last - 1]) {
        v.swap(last, last - 1);
        last -= 1;
    }
}

/// `__insertion_sort(first, last)`
fn insertion_sort<T>(v: &mut [T], less: &impl Fn(&T, &T) -> bool) {
    for i in 1..v.len() {
        if less(&v[i], &v[0]) {
            v[..=i].rotate_right(1);
        } else {
            unguarded_linear_insert(v, i, less);
        }
    }
}

/// `__final_insertion_sort(first, last)`
fn final_insertion_sort<T>(v: &mut [T], less: &impl Fn(&T, &T) -> bool) {
    if v.len() > THRESHOLD {
        insertion_sort(&mut v[..THRESHOLD], less);
        for i in THRESHOLD..v.len() {
            unguarded_linear_insert(v, i, less);
        }
    } else {
        insertion_sort(v, less);
    }
}

/// `std::__adjust_heap` with `__push_heap`
fn adjust_heap<T>(v: &mut [T], mut hole: usize, len: usize, less: &impl Fn(&T, &T) -> bool) {
    let top = hole;
    let mut child = hole;
    while child < (len - 1) / 2 {
        child = 2 * (child + 1);
        if less(&v[child], &v[child - 1]) {
            child -= 1;
        }
        v.swap(hole, child);
        hole = child;
    }
    if len % 2 == 0 && child == (len - 2) / 2 {
        child = 2 * (child + 1);
        v.swap(hole, child - 1);
        hole = child - 1;
    }
    // __push_heap(first, hole, top, value): the value now sits at `hole`
    let mut parent = if hole > 0 { (hole - 1) / 2 } else { 0 };
    while hole > top && less(&v[parent], &v[hole]) {
        v.swap(hole, parent);
        hole = parent;
        if hole == 0 {
            break;
        }
        parent = (hole - 1) / 2;
    }
}

fn make_heap<T>(v: &mut [T], less: &impl Fn(&T, &T) -> bool) {
    let len = v.len();
    if len < 2 {
        return;
    }
    let mut parent = (len - 2) / 2;
    loop {
        adjust_heap(v, parent, len, less);
        if parent == 0 {
            return;
        }
        parent -= 1;
    }
}

fn sort_heap<T>(v: &mut [T], less: &impl Fn(&T, &T) -> bool) {
    let mut len = v.len();
    while len > 1 {
        len -= 1;
        // __pop_heap(first, last, result = last)
        v.swap(0, len);
        adjust_heap(v, 0, len, less);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts() {
        let mut rng = 12345u64;
        for len in 0..200 {
            let mut v: Vec<(u32, usize)> = (0..len)
                .map(|i| {
                    rng ^= rng << 13;
                    rng ^= rng >> 7;
                    rng ^= rng << 17;
                    ((rng % 7) as u32, i)
                })
                .collect();
            std_sort(&mut v, &|a, b| a.0 < b.0);
            assert!(v.windows(2).all(|w| w[0].0 <= w[1].0));
        }
    }

    #[test]
    fn heap_sorts() {
        let mut v: Vec<u32> = (0..100).map(|i| (i * 37) % 101).collect();
        make_heap(&mut v, &|a, b| a < b);
        sort_heap(&mut v, &|a, b| a < b);
        assert!(v.windows(2).all(|w| w[0] <= w[1]));
    }
}
