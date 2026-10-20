//! The Rust scanner must produce exactly the output of the C++ scanner.
//!
//! Compares the complete scanner output (symbols with values, errors, line breaks, comments,
//! obfuscated literals, the name registry, and the comment blocks) in the dump format of
//! `dashql_oracle::scan` on:
//!   - every `input` of every snapshot file,
//!   - prefixes of these inputs (scripts are scanned while they are being typed),
//!   - deterministic fuzz inputs built from fragments that exercise the scanner rules.

use dashql_grammar::comment_blocks::group_comments;
use dashql_grammar::keywords::Keyword;
use dashql_grammar::scanner::{scan, ScannedScript, SymbolValue};
use dashql_grammar::symbol_kind;
use dashql_snapshots::corpus::{fragments, prefixes, snapshot_inputs, Rng, CATEGORIES};
use dashql_snapshots::{run, Arguments, Failed, Trial};
use std::fmt::Write as _;

/// Dump a scanned script in the format of `dashql_oracle_scan` (tools/oracle_ffi.cc).
fn dump(scanned: &ScannedScript) -> String {
    let mut out = String::new();
    let str = |out: &mut String, s: &str| {
        let _ = write!(out, "{}:{}", s.len(), s);
    };
    for symbol in &scanned.symbols {
        let _ = write!(out, "T {} {} {}", symbol.kind, symbol.location.offset, symbol.location.length);
        match symbol.value {
            SymbolValue::Name(id) if symbol.kind == symbol_kind::S_IDENT => {
                let _ = write!(out, " {id}");
            }
            SymbolValue::Text(text)
                if symbol.kind == symbol_kind::S_VISUALIZE_LA || Keyword::name_of(symbol.kind).is_some() =>
            {
                out.push(' ');
                str(&mut out, text);
            }
            _ => {}
        }
        out.push('\n');
    }
    for error in &scanned.errors {
        let _ = write!(out, "E {} {} ", error.location.offset, error.location.length);
        str(&mut out, &error.message);
        out.push('\n');
    }
    for span in &scanned.line_breaks {
        let _ = writeln!(out, "L {} {}", span.offset, span.length);
    }
    for span in &scanned.comments {
        let _ = writeln!(out, "C {} {}", span.offset, span.length);
    }
    for literal in &scanned.obfuscated_literals {
        let _ = write!(out, "O {} {} ", literal.location.offset, literal.location.length);
        str(&mut out, &literal.replacement);
        out.push('\n');
    }
    for name in scanned.names.iter() {
        let _ = write!(out, "N {} {} {} {} ", name.name_id, name.location.offset, name.location.length, name.occurrences);
        str(&mut out, &name.text);
        out.push('\n');
    }
    let blocks = group_comments(&scanned.text, &scanned.comments);
    for b in &blocks.blocks {
        let _ = writeln!(
            out,
            "B {} {} {} {} {} {} {} {} {}",
            b.block_type.0,
            b.text_span.offset,
            b.text_span.length,
            b.tag_span.offset,
            b.tag_span.length,
            b.comments_begin,
            b.comments_count,
            b.lines_begin,
            b.lines_count
        );
    }
    for line in &blocks.lines {
        let _ = writeln!(out, "BL {} {}", line.offset, line.length);
    }
    for (span, message) in &blocks.warnings {
        let _ = write!(out, "W {} {} ", span.offset, span.length);
        str(&mut out, message);
        out.push('\n');
    }
    let _ = writeln!(out, "M {}", blocks.metadata_block.unwrap_or(u32::MAX));
    out
}

/// Scan with both scanners and describe the first difference.
fn compare(input: &str) -> Result<(), String> {
    let expected = dashql_oracle::scan(input).map_err(|e| format!("oracle failed on {input:?}: {e}"))?;
    let actual = dump(&scan(input, 0, 2));
    if expected == actual {
        return Ok(());
    }
    let e: Vec<&str> = expected.lines().collect();
    let a: Vec<&str> = actual.lines().collect();
    let i = (0..e.len().max(a.len())).find(|&i| e.get(i) != a.get(i)).unwrap();
    Err(format!(
        "input {input:?}\nfirst difference at line {i}:\n  C++:  {}\n  Rust: {}\n\nC++:\n{expected}\nRust:\n{actual}",
        e.get(i).unwrap_or(&"<none>"),
        a.get(i).unwrap_or(&"<none>"),
    ))
}

/// Fragments that exercise the scanner rules and their interactions.
const FRAGMENTS: &[&str] = &[
    "'", "''", "\"", "\"\"", "`", "``", "-", "--", "---", "/", "*", "/*", "*/", "**/", ".", "..", ". ", ":", "::",
    ":=", "=", "=>", "<", "<=", ">", ">=", "<>", "!", "!=", "+", "?", "$", "e", "E", "e+", "1", "0", "42", "9", "1.",
    ".5", "a", "b", "x", "B'", "X'", "b'", "x'", "_", " ", "  ", "\n", "\r", "\t", "\x0c", "\x0b", "é", "Ä", "~", "@",
    "#", "%", "^", "&", "|", ",", ";", "(", ")", "[", "]", "{", "}", "\\", "\0", "select", "SELECT", "from", "not",
    "in", "between", "nulls", "first", "with", "time", "ordinality", "visualize", "visualise", "using", "vegalite",
    "table", "umap", "markdown", "foo", "Bar", "/*Integer(1A2B)*/", "/*String(00FF)*/", "/*Float(ABCD)*/",
    "/*HexString(0F0F)*/", "/*BitString(8001)*/", "/*Integer(1a2b)*/", "-- @dashql:description ",
    "-- @dashql:end\n", "-- @dashql:metadata", "/* @dashql:metadata {\"a\": 1} */", "@dashql:", "{}", "[1]",
    "description", " * ", "/**", "-- x\n",
];

fn main() {
    let args = Arguments::from_args();
    let mut trials = Vec::new();

    for &category in CATEGORIES {
        for (file, inputs) in snapshot_inputs(category) {
            trials.push(Trial::test(format!("{category}::{file}"), move || {
                for input in &inputs {
                    compare(input)?;
                }
                for input in &inputs {
                    for prefix in prefixes(input, 64) {
                        compare(prefix)?;
                    }
                }
                Ok::<(), Failed>(())
            }));
        }
    }

    for batch in 0..32u64 {
        trials.push(Trial::test(format!("fuzz::batch_{batch:02}"), move || {
            let mut rng = Rng::new(batch + 1);
            for _ in 0..1000 {
                compare(&fragments(&mut rng, FRAGMENTS, 24))?;
            }
            Ok::<(), Failed>(())
        }));
    }

    run(&args, trials).exit();
}
