//! Pipeline benchmarks, the counterpart of packages/dashql-core/benchmarks/benchmark_pipeline.cc.
//!
//!   bazel run -c opt //packages/dashql-core-rs:bench_pipeline

use dashql_buffers::formatting::FormattingConfigT;
use dashql_core::formatter::Formatter;
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
    bench_attribute_lookups();
    let parsed = parse(Arc::new(scan(MAIN_SCRIPT, 0, 1)));
    let config = FormattingConfigT::default();
    bench("format_query", || {
        let mut formatter = Formatter::new(black_box(&parsed));
        black_box(formatter.format(&config));
    });
}

/// Attribute lookups of a wide object (the 21 keys of a vis scale) with 5, 21 and 40 children
fn bench_attribute_lookups() {
    use dashql_buffers::parser::{AttributeKey as K, Node, NodeType, SymbolSpan};
    use dashql_grammar::attrs;
    const KEYS: [K; 21] = [
        K::VIS_SCALE_TYPE, K::VIS_SCALE_DOMAIN, K::VIS_SCALE_DOMAIN_MIN, K::VIS_SCALE_DOMAIN_MAX,
        K::VIS_SCALE_DOMAIN_MID, K::VIS_SCALE_RANGE, K::VIS_SCALE_RANGE_MIN, K::VIS_SCALE_RANGE_MAX,
        K::VIS_SCALE_SCHEME, K::VIS_SCALE_INTERPOLATE, K::VIS_SCALE_NICE, K::VIS_SCALE_ZERO, K::VIS_SCALE_CLAMP,
        K::VIS_SCALE_PADDING, K::VIS_SCALE_PADDING_INNER, K::VIS_SCALE_PADDING_OUTER, K::VIS_SCALE_REVERSE,
        K::VIS_SCALE_ROUND, K::VIS_SCALE_EXPONENT, K::VIS_SCALE_BINS, K::VIS_SCALE_NAME,
    ];
    let node = |k: K| Node::new(&SymbolSpan::new(0, 0), NodeType::NONE, k, 0, 0, 0);
    let few: Vec<Node> =
        [K::VIS_SCALE_TYPE, K::VIS_SCALE_DOMAIN, K::VIS_SCALE_NICE, K::VIS_SCALE_NAME, K::NONE].map(node).to_vec();
    let many: Vec<Node> = KEYS.iter().rev().map(|k| node(*k)).collect();
    let wide: Vec<Node> = (0..40u16).map(|i| node(K(KEYS[(i % 21) as usize].0 + (i / 21) * 300))).collect();
    for (label, children) in [("5", &few), ("21", &many), ("40", &wide)] {
        bench(&format!("attrs_21/{label}"), || {
            let found = attrs!(black_box(&children[..]), [
                K::VIS_SCALE_TYPE, K::VIS_SCALE_DOMAIN, K::VIS_SCALE_DOMAIN_MIN, K::VIS_SCALE_DOMAIN_MAX,
                K::VIS_SCALE_DOMAIN_MID, K::VIS_SCALE_RANGE, K::VIS_SCALE_RANGE_MIN, K::VIS_SCALE_RANGE_MAX,
                K::VIS_SCALE_SCHEME, K::VIS_SCALE_INTERPOLATE, K::VIS_SCALE_NICE, K::VIS_SCALE_ZERO,
                K::VIS_SCALE_CLAMP, K::VIS_SCALE_PADDING, K::VIS_SCALE_PADDING_INNER, K::VIS_SCALE_PADDING_OUTER,
                K::VIS_SCALE_REVERSE, K::VIS_SCALE_ROUND, K::VIS_SCALE_EXPONENT, K::VIS_SCALE_BINS,
                K::VIS_SCALE_NAME,
            ]);
            black_box(found);
        });
    }
}
