//! The Rust parser must produce exactly the output of the C++ parser.
//!
//! Compares the raw parser output (every node field, statements, errors with hints, vis spec spans,
//! feature flags, and the names and obfuscated literals after parsing) in the dump format of
//! `dashql_oracle::parse_raw` on:
//!   - every `input` of every snapshot file and prefixes of these inputs,
//!   - random sentences of the grammar: random walks through the LR automaton that only take tokens
//!     the parser accepts, so they reach deep into the grammar,
//!   - deterministic fuzz inputs of SQL fragments.

// Bison names some symbol kinds in mixed case (S_YYerror, S_Op).
#![allow(non_upper_case_globals)]

use dashql_grammar::keywords::Keyword;
use dashql_grammar::parser::driver::{feed, lac_check};
use dashql_grammar::parser::{parse, ParsedScript};
use dashql_grammar::scanner::scan;
use dashql_grammar::symbol_kind::*;
use dashql_grammar::{tables, SymbolKind};
use dashql_snapshots::corpus::{fragments, prefixes, snapshot_inputs, Rng, CATEGORIES};
use dashql_snapshots::{run, Arguments, Failed, Trial};
use std::fmt::Write as _;
use std::sync::Arc;

/// Dump a parsed script in the format of `dashql_oracle_parse_raw` (tools/oracle_ffi.cc).
fn dump(parsed: &ParsedScript) -> String {
    let mut out = String::new();
    let str = |out: &mut String, s: &str| {
        let _ = write!(out, "{}:{}", s.len(), s);
    };
    for (i, n) in parsed.nodes.iter().enumerate() {
        let _ = writeln!(
            out,
            "N {} {} {} {} {} {} {} {}",
            i,
            n.symbol_span().offset(),
            n.symbol_span().length(),
            n.node_type().0,
            n.attribute_key().0,
            n.parent(),
            n.children_begin_or_value(),
            n.children_count()
        );
    }
    for s in &parsed.statements {
        let _ = writeln!(out, "S {} {} {} {}", s.statement_type.0, s.root, s.nodes_begin, s.node_count);
    }
    for e in &parsed.errors {
        let _ = write!(out, "E {} {} ", e.location.offset(), e.location.length());
        str(&mut out, &e.message);
        out.push(' ');
        str(&mut out, &e.hint);
        out.push('\n');
    }
    for (begin, end) in &parsed.vis_spec_spans {
        let _ = writeln!(out, "V {begin} {end}");
    }
    let _ = writeln!(out, "F {}", parsed.feature_flags);
    for name in parsed.scanned.names.iter() {
        let _ = write!(out, "R {} {} {} {} ", name.name_id, name.location.offset, name.location.length, name.occurrences);
        str(&mut out, &name.text);
        out.push('\n');
    }
    for literal in &parsed.scanned.obfuscated_literals {
        let _ = write!(out, "O {} {} ", literal.location.offset, literal.location.length);
        str(&mut out, &literal.replacement);
        out.push('\n');
    }
    out
}

fn compare(input: &str) -> Result<(), String> {
    let expected = dashql_oracle::parse_raw(input).map_err(|e| format!("oracle failed on {input:?}: {e}"))?;
    let actual = dump(&parse(Arc::new(scan(input, 0, 2))));
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

/// Text that scans as the given terminal
fn token_text(kind: SymbolKind, rng: &mut Rng) -> String {
    if let Some(keyword) = Keyword::name_of(kind) {
        return keyword.to_string();
    }
    let text = match kind {
        S_IDENT => *rng.pick(&["foo", "bar", "a", "b1", "\"Quoted\"", "`tick`"]),
        S_SCONST => *rng.pick(&["'s'", "'it''s'", "''"]),
        S_Op => *rng.pick(&["~~", "@@", "#>", "||/"]),
        S_FCONST => "1.5",
        S_BCONST => "b'01'",
        S_XCONST => "x'1F'",
        S_ICONST => *rng.pick(&["1", "42", "1000"]),
        S_PARAM => "?",
        S_TYPECAST => "::",
        S_DOT | S_DOT_STAR_LA => ".",
        S_DOT_DOT => "..",
        S_DOT_TRAILING => ". ",
        S_COLON_EQUALS => ":=",
        S_EQUALS_GREATER => "=>",
        S_LESS_EQUALS => "<=",
        S_GREATER_EQUALS => ">=",
        S_NOT_EQUALS => "<>",
        S_LRB => "(",
        S_RRB => ")",
        S_LSB => "[",
        S_RSB => "]",
        S_LCB => "{",
        S_RCB => "}",
        S_STAR => "*",
        S_COMMA => ",",
        S_COLON => ":",
        S_QUESTION_MARK => "?",
        S_DOLLAR => "$",
        S_SEMICOLON => ";",
        S_MINUS => "-",
        S_PLUS => "+",
        S_DIVIDE => "/",
        S_MODULO => "%",
        S_LESS_THAN => "<",
        S_GREATER_THAN => ">",
        S_EQUALS => "=",
        S_CIRCUMFLEX => "^",
        S_AMPERSAND => "&",
        S_PIPE => "|",
        S_EXCLAMATION_MARK => "!",
        S_NOT_LA => "not",
        S_NULLS_LA => "nulls",
        S_WITH_LA => "with",
        _ => "",
    };
    text.to_string()
}

/// A random sentence of the grammar: a random walk through the automaton over acceptable tokens.
fn random_sentence(rng: &mut Rng) -> String {
    // After the budget, the walk ends as soon as the automaton accepts EOF (or at a hard cap).
    let budget = 1 + rng.below(48);
    let mut states = vec![0];
    let mut scratch = Vec::new();
    let mut out = String::new();
    for step in 0..400 {
        let acceptable: Vec<SymbolKind> = (0..tables::YYNTOKENS as SymbolKind)
            // DOT_TRAILING always reports an error, and QUESTION_MARK does not survive the space
            // after it (it scans as PARAM).
            .filter(|&t| !matches!(t, S_YYerror | S_YYUNDEF | S_COMPLETE_HERE | S_RAW_CHAR | S_DOT_TRAILING | S_QUESTION_MARK))
            .filter(|&t| lac_check(&states, t, &mut scratch))
            .collect();
        let can_end = acceptable.contains(&S_YYEOF);
        let tokens: Vec<SymbolKind> = acceptable.into_iter().filter(|&t| t != S_YYEOF).collect();
        if tokens.is_empty() || (can_end && (rng.below(8) == 0 || step >= budget)) {
            break;
        }
        let token = *rng.pick(&tokens);
        if !feed(&mut states, token) {
            break;
        }
        let text = token_text(token, rng);
        if !out.is_empty() && !text.is_empty() {
            out.push(' ');
        }
        out.push_str(&text);
    }
    out
}

/// SQL fragments for fuzz inputs that are mostly invalid
const FRAGMENTS: &[&str] = &[
    "select ", "from ", "where ", "group by ", "order by ", "having ", "limit ", "union ", "with ", "as ", "join ",
    "on ", "and ", "or ", "not ", "in ", "between ", "like ", "is ", "null ", "case ", "when ", "then ", "else ",
    "end ", "create table ", "insert into ", "values ", "delete from ", "visualize ", "using ", "vegalite ",
    "a", "b.c", "\"q\"", "'s'", "1", "2.5", "(", ")", ",", ";", "*", "+", "-", "=", "<", ".", ". ", "::", "?", "$1",
    "x ", "y ", "mark ", "encoding ", "{", "}", ":", "[", "]", "/*Integer(1A2B)*/", "/*String(00FF)*/", "\n",
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
                    for prefix in prefixes(input, 32) {
                        compare(prefix)?;
                    }
                }
                Ok::<(), Failed>(())
            }));
        }
    }

    for batch in 0..16u64 {
        trials.push(Trial::test(format!("grammar::batch_{batch:02}"), move || {
            let mut rng = Rng::new(1000 + batch);
            let mut valid = 0;
            let mut tokens = 0;
            let mut examples = Vec::new();
            for _ in 0..200 {
                let sentence = random_sentence(&mut rng);
                compare(&sentence)?;
                let parsed = parse(Arc::new(scan(&sentence, 0, 2)));
                if parsed.errors.is_empty() && !parsed.statements.is_empty() {
                    valid += 1;
                } else if examples.len() < 6 {
                    let message = parsed.errors.first().map(|e| e.message.clone()).unwrap_or_default();
                    examples.push(format!("{sentence:?}: {message}"));
                }
                tokens += parsed.scanned.symbols.len();
            }
            // The generator must produce real statements, not just trivial or broken inputs. Many
            // sentences end in a deliberate error (e.g. `DOT EOF` is a trailing dot).
            if valid < 30 || tokens < 200 * 40 {
                return Err(format!(
                    "weak generator: {valid} of 200 sentences parse cleanly, {tokens} tokens\n{}",
                    examples.join("\n")
                )
                .into());
            }
            Ok::<(), Failed>(())
        }));
    }

    for batch in 0..16u64 {
        trials.push(Trial::test(format!("fuzz::batch_{batch:02}"), move || {
            let mut rng = Rng::new(2000 + batch);
            for _ in 0..500 {
                compare(&fragments(&mut rng, FRAGMENTS, 16))?;
            }
            Ok::<(), Failed>(())
        }));
    }

    run(&args, trials).exit();
}
