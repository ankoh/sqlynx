//! Query the C++ oracle from the command line, for exploring edge cases while porting.
//!
//!   bazel run //packages/dashql-core-rs:oracle -- scan "select 1"
//!   echo "select 1" | bazel run //packages/dashql-core-rs:oracle -- parse -

use std::io::Read;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: oracle <scan|parse> <text|->");
        std::process::exit(2);
    }
    let text = if args[2] == "-" {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text).expect("cannot read stdin");
        text
    } else {
        args[2].clone()
    };
    let result = match args[1].as_str() {
        "scan" => dashql_oracle::scan(&text),
        "parse" => dashql_oracle::parse(&text),
        other => {
            eprintln!("unknown command {other}");
            std::process::exit(2);
        }
    };
    match result {
        Ok(out) => print!("{out}"),
        Err(e) => {
            eprintln!("oracle failed: {e}");
            std::process::exit(1);
        }
    }
}
