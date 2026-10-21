//! A port of the C++ `test/name_tagging_test.cc`.
//!
//! The C++ test reads the tags from the scanned names, which the C++ analyzer modifies. The Rust
//! analyzer leaves the scan untouched and keeps the names and their tags in the analyzed script.

use dashql_buffers::analyzer::NameTag;
use dashql_core::analyzer::analyze;
use dashql_core::catalog::Catalog;
use dashql_grammar::parser::parse;
use dashql_grammar::scanner::scan;
use std::sync::Arc;

const COLUMN_NAME: u8 = NameTag::COLUMN_NAME.0;
const TABLE_NAME: u8 = NameTag::TABLE_NAME.0;
const TABLE_ALIAS: u8 = NameTag::TABLE_ALIAS.0;
const SCHEMA_NAME: u8 = NameTag::SCHEMA_NAME.0;
const DATABASE_NAME: u8 = NameTag::DATABASE_NAME.0;

fn test(script: &str, expected: &[(&str, u8)]) {
    // The analyzer registers the empty name for unqualified table names
    let mut expected = expected.to_vec();
    expected.push(("", DATABASE_NAME | SCHEMA_NAME));

    let scanned = Arc::new(scan(script, 0, 0));
    let parsed = Arc::new(parse(scanned));
    assert!(parsed.errors.is_empty(), "{}", parsed.errors[0].message);
    let catalog = Catalog::new();
    let analyzed = analyze(parsed, &catalog).unwrap();

    let names: Vec<&str> = analyzed.names.iter().map(|n| n.text.as_str()).collect();
    assert_eq!(names.len(), expected.len(), "{names:?}");
    for (i, (name, tags)) in expected.iter().enumerate() {
        let have = analyzed.names.get(i as u32);
        assert_eq!(have.text, *name, "{i}");
        assert_eq!(analyzed.name_tags[i].0, *tags, "{i}");
    }
}

#[test]
fn select_1() {
    test("select 1", &[]);
}

#[test]
fn select_foo() {
    test("select foo", &[("foo", COLUMN_NAME)]);
}

#[test]
fn select_foo_from_bar() {
    test("select foo from bar", &[("foo", COLUMN_NAME), ("bar", TABLE_NAME)]);
}

#[test]
fn select_foo_from_foo() {
    test("select foo from foo", &[("foo", COLUMN_NAME | TABLE_NAME)]);
}

#[test]
fn select_foo_from_foo_foo() {
    test("select foo from foo foo", &[("foo", COLUMN_NAME | TABLE_NAME | TABLE_ALIAS)]);
}

#[test]
fn select_foo_from_foo_bar() {
    test("select foo from foo bar", &[("foo", COLUMN_NAME | TABLE_NAME), ("bar", TABLE_ALIAS)]);
}

#[test]
fn select_foo_bar_from_the_foo() {
    test("select foo.bar from the foo", &[("foo", TABLE_ALIAS), ("bar", COLUMN_NAME), ("the", TABLE_NAME)]);
}

#[test]
fn select_foo_bar_from_the_real_foo() {
    test(
        "select foo.bar from the.real foo",
        &[("foo", TABLE_ALIAS), ("bar", COLUMN_NAME), ("the", SCHEMA_NAME), ("real", TABLE_NAME)],
    );
}

#[test]
fn select_foo_bar_from_the_actually_real_foo() {
    test(
        "select foo.bar from the.actually.real foo",
        &[
            ("foo", TABLE_ALIAS),
            ("bar", COLUMN_NAME),
            ("the", DATABASE_NAME),
            ("actually", SCHEMA_NAME),
            ("real", TABLE_NAME),
        ],
    );
}

#[test]
fn quoted_identifier() {
    test("select * from \"SomeQuotedString\"", &[("SomeQuotedString", TABLE_NAME)]);
}
