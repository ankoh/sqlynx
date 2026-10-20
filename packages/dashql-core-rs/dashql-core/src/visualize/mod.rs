//! The renderer specs of VISUALIZE statements, a port of `packages/dashql-core/src/visualize`.
//!
//! - `vegalite_generator`: the Vega-Lite JSON of an analyzed visualization (`GenerateVegaLiteSpec`)
//! - `vegalite_parser`: a VISUALIZE statement from Vega-Lite JSON (`ParseVegaLiteToVisualize`)
//! - `markdown`: the Markdown row template compiled into a document tree (`CompileMarkdownSpec`), with a port of
//!   the md4c parser
//! - `umap`: the UMAP spec (`CompileUmapSpec`)
//!
//! The C++ core caches the compiled specs in mutable fields of the visualization spec. The Rust functions are
//! pure, callers cache the results.

mod markdown;
mod pretty_writer;
mod umap;
mod vegalite_generator;
mod vegalite_parser;

pub use markdown::{
    compile_markdown_spec, compile_markdown_template, pack_markdown_spec, MarkdownDocument, MarkdownNode,
};
pub use umap::{compile_umap_spec, pack_umap_spec, UmapDocument, UmapProjectionDocument};
pub use vegalite_generator::generate_vegalite_spec;
pub use vegalite_parser::{parse_vegalite_to_visualize, parse_vegalite_to_visualize_bytes};

use crate::analyzer::AnalyzedScript;
use crate::view::json::c_str;
use dashql_grammar::parser::context::resolve_text_span;

/// The text of a node (`input.substr(span.offset(), span.length())`)
fn node_text(script: &AnalyzedScript, node_id: u32) -> &[u8] {
    let scanned = &script.parsed.scanned;
    let span = resolve_text_span(&scanned.text, &scanned.symbols, *script.parsed.nodes[node_id as usize].symbol_span());
    let text = scanned.text.as_bytes();
    let begin = (span.offset as usize).min(text.len());
    let end = (span.offset as usize + span.length as usize).min(text.len());
    &text[begin..end]
}

/// Strip enclosing single quotes
fn strip_single_quotes(text: &[u8]) -> &[u8] {
    if text.len() >= 2 && text[0] == b'\'' && text[text.len() - 1] == b'\'' {
        &text[1..text.len() - 1]
    } else {
        text
    }
}

/// `std::strtod(text.c_str(), &end)` with the check `*end == '\0'`: the number if the whole C string is one.
///
/// An empty text counts as the number 0, because `strtod` leaves `end` at the terminating NUL when it converts
/// nothing.
fn strtod_c(text: &[u8]) -> Option<f64> {
    if text.is_empty() {
        return Some(0.0);
    }
    let text = std::str::from_utf8(text).ok()?;
    // glibc parses `nan(chars)` only if the chars are alphanumeric or underscores
    let unsigned =
        text.trim_start_matches([' ', '\t', '\n', '\x0b', '\x0c', '\r']).trim_start_matches(['+', '-']).as_bytes();
    if unsigned.len() > 4 && unsigned[..4].eq_ignore_ascii_case(b"nan(") {
        let chars = &unsigned[4..unsigned.len() - 1];
        if unsigned.last() != Some(&b')') || !chars.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_') {
            return None;
        }
    }
    crate::analyzer::strtod_full(text)
}

/// `static_cast<int64_t>(value)` as x86-64 computes it: NaN and values out of range become `INT64_MIN`
fn cvt_f64_i64(value: f64) -> i64 {
    if value.is_nan() || value >= 9_223_372_036_854_775_808.0 || value < -9_223_372_036_854_775_808.0 {
        i64::MIN
    } else {
        value as i64
    }
}

/// A string from bytes that are UTF-8 unless the input was not
fn into_string(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

#[cfg(test)]
mod tests;
