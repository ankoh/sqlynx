//! wasm-bindgen entry point of the Rust core.
//!
//! The JS API arrives with phase 8 of the port (docs/rust-port/README.md). Until then the module
//! only exposes the grammar, which keeps the LALR(1) tables in the release build so that their
//! share of the module size can be tracked.

use dashql_grammar::tables;
use wasm_bindgen::prelude::*;

/// The size of the LALR(1) automaton: `[terminals, nonterminals, rules, states]`.
#[wasm_bindgen(js_name = grammarSize)]
pub fn grammar_size() -> Vec<u32> {
    [tables::YYNTOKENS, tables::YYNNTS, tables::YYNRULES, tables::YYNSTATES]
        .iter()
        .map(|&n| n as u32)
        .collect()
}

/// The name of a grammar symbol as error messages print it.
#[wasm_bindgen(js_name = symbolName)]
pub fn symbol_name(kind: u16) -> Option<String> {
    ((kind as usize) < tables::YYNTOKENS + tables::YYNNTS).then(|| dashql_grammar::symbol_name(kind).into_owned())
}

/// A checksum over all parser tables.
///
/// A size probe: it references every table, so none of them is stripped from the module. The
/// LR driver replaces it once it exists.
#[wasm_bindgen(js_name = tableChecksum)]
pub fn table_checksum() -> u32 {
    fn fold<T: Copy + Into<i64>>(acc: u32, table: &[T]) -> u32 {
        table.iter().fold(acc, |acc, &v| acc.rotate_left(5) ^ (v.into() as u32))
    }
    let mut acc = 0;
    acc = fold(acc, tables::YYPACT);
    acc = fold(acc, tables::YYDEFACT);
    acc = fold(acc, tables::YYPGOTO);
    acc = fold(acc, tables::YYDEFGOTO);
    acc = fold(acc, tables::YYTABLE);
    acc = fold(acc, tables::YYCHECK);
    acc = fold(acc, tables::YYSTOS);
    acc = fold(acc, tables::YYR1);
    acc = fold(acc, tables::YYR2);
    acc
}
