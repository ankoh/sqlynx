//! The DashQL SQL grammar.
//!
//! [`tables`] holds the LALR(1) automaton and the actions that bison computes from the Rust rule
//! set of `//grammar` (`grammar/rules_rs`), emitted through `//grammar/rust:tables.rs.m4`. It is the
//! very automaton the C++ parser runs (`tests/table_parity.rs` asserts that), which keeps parse
//! trees, error messages, error recovery and the completion probes of the Rust core identical by
//! construction.
//!
//! [`scanner`] is a port of the flex scanner `grammar/scanner.l` that reproduces its output
//! exactly. [`parser`] runs the automaton with the Rust actions of `grammar/rules_rs`.

use std::borrow::Cow;

pub mod attributes;
pub mod comment_blocks;
pub mod keywords;
pub mod names;
pub mod parser;
pub mod scanner;
pub mod span;

#[allow(dead_code, non_upper_case_globals, unused_braces, unused_parens, unused_variables, unused_mut)]
#[allow(clippy::all)]
#[rustfmt::skip]
pub mod tables;

pub use tables::symbol_kind;

/// A bison symbol kind: terminals in `0..YYNTOKENS`, nonterminals after them.
pub type SymbolKind = u16;

/// Is the symbol a terminal?
pub fn is_terminal(kind: SymbolKind) -> bool {
    (kind as usize) < tables::YYNTOKENS
}

/// The name of a symbol as bison's verbose error messages print it.
///
/// Mirrors bison's `yytnamerr_`: a quoted alias such as `"identifier literal"` loses its
/// double quotes unless it contains an apostrophe, a comma or a backslash.
pub fn symbol_name(kind: SymbolKind) -> Cow<'static, str> {
    let name = tables::YYTNAME[kind as usize];
    let Some(quoted) = name.strip_prefix('"') else {
        return Cow::Borrowed(name);
    };
    let mut unquoted = String::with_capacity(quoted.len());
    let mut chars = quoted.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' | ',' => break,
            '\\' => match chars.next() {
                Some('\\') => unquoted.push('\\'),
                _ => break,
            },
            '"' => return Cow::Owned(unquoted),
            c => unquoted.push(c),
        }
    }
    Cow::Borrowed(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automaton_size() {
        assert_eq!(tables::YYNTOKENS, 639);
        assert_eq!(tables::YYPACT.len(), tables::YYNSTATES);
        assert_eq!(tables::YYDEFACT.len(), tables::YYNSTATES);
        assert_eq!(tables::YYSTOS.len(), tables::YYNSTATES);
        assert_eq!(tables::YYR1.len(), tables::YYNRULES + 1);
        assert_eq!(tables::YYR2.len(), tables::YYNRULES + 1);
        assert_eq!(tables::YYPGOTO.len(), tables::YYNNTS);
        assert_eq!(tables::YYDEFGOTO.len(), tables::YYNNTS);
        assert_eq!(tables::YYTABLE.len(), tables::YYLAST as usize + 1);
        assert_eq!(tables::YYCHECK.len(), tables::YYLAST as usize + 1);
        // The symbol names end with bison's YY_NULLPTR sentinel.
        assert_eq!(tables::YYTNAME.len(), tables::YYNTOKENS + tables::YYNNTS + 1);
    }

    #[test]
    fn symbol_kinds() {
        assert_eq!(symbol_kind::S_YYEOF, 0);
        assert_eq!(symbol_kind::S_YYerror, 1);
        assert_eq!(symbol_kind::S_YYUNDEF, 2);
        assert_eq!(symbol_kind::S_IDENT, 3);
        assert!(is_terminal(symbol_kind::S_SELECT));
        assert!(!is_terminal(symbol_kind::S_sql_select_stmt));
    }

    #[test]
    fn symbol_names() {
        assert_eq!(symbol_name(symbol_kind::S_YYEOF), "EOF");
        assert_eq!(symbol_name(symbol_kind::S_IDENT), "identifier literal");
        assert_eq!(symbol_name(symbol_kind::S_SCONST), "string literal");
        assert_eq!(symbol_name(symbol_kind::S_YYUNDEF), "invalid token");
        assert_eq!(symbol_name(symbol_kind::S_SELECT), "SELECT");
        assert_eq!(symbol_name(symbol_kind::S_RRB), "RRB");
    }
}
