//! The measurement loop shared by the benchmark binaries.

use std::time::{Duration, Instant};

/// Run a function repeatedly and print the median time per iteration of several batches
pub fn bench(name: &str, mut f: impl FnMut()) {
    // Calibrate the batch size to ~10ms
    let mut iterations = 1u64;
    loop {
        let start = Instant::now();
        for _ in 0..iterations {
            f();
        }
        if start.elapsed() > Duration::from_millis(10) {
            break;
        }
        iterations *= 2;
    }
    let mut samples: Vec<f64> = (0..21)
        .map(|_| {
            let start = Instant::now();
            for _ in 0..iterations {
                f();
            }
            start.elapsed().as_nanos() as f64 / iterations as f64
        })
        .collect();
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("{name:<24} {:>12.0} ns", samples[samples.len() / 2]);
}
