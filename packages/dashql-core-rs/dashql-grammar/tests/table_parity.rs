//! The Rust tables must be the automaton of the C++ parser.
//!
//! Reads the tables out of the bison lalr1.cc output of the C++ rule set (`//grammar:parser_generated`)
//! and compares them entry by entry with the tables of the Rust rule set (`grammar/rules_rs`). Both rule
//! sets must describe the same automaton; a grammar change has to be made in both.

use dashql_grammar::tables;
use std::fs;

struct CxxParser {
    source: String,
    header: String,
}

impl CxxParser {
    fn load() -> Self {
        let read = |var: &str| {
            let path = std::env::var(var).unwrap_or_else(|_| panic!("{var} is not set"));
            fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"))
        };
        Self {
            source: read("CXX_PARSER_GENERATED_CC"),
            header: read("CXX_PARSER_GENERATED_H"),
        }
    }

    /// The body of `ParserBase::<name>[] = { ... };`.
    fn array_body(&self, name: &str) -> &str {
        let marker = format!("ParserBase::{name}[] =");
        let start = self.source.find(&marker).unwrap_or_else(|| panic!("missing table {name}"));
        let rest = &self.source[start + marker.len()..];
        let open = rest.find('{').unwrap();
        let close = rest.find("};").unwrap();
        &rest[open + 1..close]
    }

    fn int_table(&self, name: &str) -> Vec<i64> {
        self.array_body(name)
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(|v| v.parse().unwrap_or_else(|e| panic!("{name}: bad value {v:?}: {e}")))
            .collect()
    }

    /// The C string literals of `yytname_`, `YY_NULLPTR` reads as an empty string.
    fn name_table(&self) -> Vec<String> {
        let body = self.array_body("yytname_");
        let mut names = Vec::new();
        let mut chars = body.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '"' => {
                    let mut name = String::new();
                    while let Some(c) = chars.next() {
                        match c {
                            '\\' => name.push(chars.next().unwrap()),
                            '"' => break,
                            c => name.push(c),
                        }
                    }
                    names.push(name);
                }
                'Y' => {
                    let ident: String = std::iter::once(c)
                        .chain(std::iter::from_fn(|| chars.next_if(|c| c.is_ascii_alphanumeric() || *c == '_')))
                        .collect();
                    assert_eq!(ident, "YY_NULLPTR");
                    names.push(String::new());
                }
                _ => {}
            }
        }
        names
    }

    /// A constant like `yylast_ = 69019,` or `yypact_ninf_ = -2374;`.
    fn constant(&self, name: &str) -> i64 {
        for text in [&self.header, &self.source] {
            if let Some(start) = text.find(&format!("{name} = ")) {
                let value = &text[start + name.len() + 3..];
                let end = value.find(|c: char| c != '-' && !c.is_ascii_digit()).unwrap();
                return value[..end].parse().unwrap();
            }
        }
        panic!("missing constant {name}");
    }
}

fn widen<T: Copy + Into<i64>>(table: &[T]) -> Vec<i64> {
    table.iter().map(|&v| v.into()).collect()
}

#[test]
fn constants_match() {
    let cxx = CxxParser::load();
    assert_eq!(cxx.constant("YYNTOKENS"), tables::YYNTOKENS as i64);
    assert_eq!(cxx.constant("yynnts_"), tables::YYNNTS as i64);
    assert_eq!(cxx.constant("yylast_"), tables::YYLAST as i64);
    assert_eq!(cxx.constant("yyfinal_"), tables::YYFINAL as i64);
    assert_eq!(cxx.constant("yypact_ninf_"), tables::YYPACT_NINF as i64);
    assert_eq!(cxx.constant("yytable_ninf_"), tables::YYTABLE_NINF as i64);
}

#[test]
fn tables_match() {
    let cxx = CxxParser::load();
    // yyrline_ (the source line of each rule, for debug output) differs between the rule sets.
    let rust: [(&str, Vec<i64>); 9] = [
        ("yypact_", widen(tables::YYPACT)),
        ("yydefact_", widen(tables::YYDEFACT)),
        ("yypgoto_", widen(tables::YYPGOTO)),
        ("yydefgoto_", widen(tables::YYDEFGOTO)),
        ("yytable_", widen(tables::YYTABLE)),
        ("yycheck_", widen(tables::YYCHECK)),
        ("yystos_", widen(tables::YYSTOS)),
        ("yyr1_", widen(tables::YYR1)),
        ("yyr2_", widen(tables::YYR2)),
    ];
    for (name, table) in rust {
        let expected = cxx.int_table(name);
        assert_eq!(expected.len(), table.len(), "{name}: length");
        if let Some(i) = (0..table.len()).find(|&i| expected[i] != table[i]) {
            panic!("{name}[{i}]: C++ has {}, Rust has {}", expected[i], table[i]);
        }
    }
}

#[test]
fn symbol_names_match() {
    let cxx = CxxParser::load();
    let rust: Vec<String> = tables::YYTNAME.iter().map(|s| s.to_string()).collect();
    assert_eq!(cxx.name_table(), rust);
}
