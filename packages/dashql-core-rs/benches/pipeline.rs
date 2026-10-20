//! Pipeline benchmarks, the counterpart of packages/dashql-core/benchmarks/benchmark_pipeline.cc.
//!
//!   bazel run -c opt //packages/dashql-core-rs:bench_pipeline

use dashql_grammar::parser::parse;
use dashql_grammar::scanner::scan;
use std::hint::black_box;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The main script of benchmark_pipeline.cc (TPC-DS query 1)
const MAIN_SCRIPT: &str = r#"
with customer_total_return as
(select sr_customer_sk as ctr_customer_sk
,sr_store_sk as ctr_store_sk
,sum(SR_RETURN_AMT) as ctr_total_return
from store_returns
,date_dim
where sr_returned_date_sk = d_date_sk
and d_year =2000
group by sr_customer_sk
,sr_store_sk)
 select  c_customer_id
from customer_total_return ctr1
,store
,customer
where ctr1.ctr_total_return > (select avg(ctr_total_return)*1.2
from customer_total_return ctr2
where ctr1.ctr_store_sk = ctr2.ctr_store_sk)
and s_store_sk = ctr1.ctr_store_sk
and s_state = 'TN'
and ctr1.ctr_customer_sk = c_customer_sk
order by c_customer_id
limit 100;
"#;

/// Run a function repeatedly and print the median time per iteration of several batches
fn bench(name: &str, mut f: impl FnMut()) {
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
    println!("{name:<20} {:>12.0} ns", samples[samples.len() / 2]);
}

fn main() {
    bench("scan_query", || {
        black_box(scan(black_box(MAIN_SCRIPT), 0, 1));
    });
    let scanned = scan(MAIN_SCRIPT, 0, 1);
    bench("parse_driver_only", || {
        let mut ctx = dashql_grammar::parser::context::ParseContext::new(
            &scanned.text,
            &scanned.symbols,
            scanned.names.clone(),
            true,
        );
        dashql_grammar::parser::driver::parse(&mut ctx);
        black_box(&ctx);
    });
    // The parser takes ownership of the scanned script, scan and parse together and subtract.
    bench("scan_parse_query", || {
        black_box(parse(Arc::new(scan(black_box(MAIN_SCRIPT), 0, 1))));
    });
}
