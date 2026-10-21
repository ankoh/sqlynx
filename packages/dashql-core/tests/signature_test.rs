//! Tests of the script signatures, the cache keys of compiled queries.

use dashql_buffers::status::StatusCode;
use dashql_core::catalog::Catalog;
use dashql_core::script::Script;
use dashql_core::signature::compute_signature;

fn signature(text: &str) -> String {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.replace_text(text);
    script.parse();
    compute_signature(script.parsed.as_ref().unwrap()).unwrap()
}

fn signature_error(text: &str) -> StatusCode {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.replace_text(text);
    script.parse();
    compute_signature(script.parsed.as_ref().unwrap()).unwrap_err().status.unwrap()
}

#[test]
fn signatures_are_128_bit_hex_strings() {
    let s = signature("select 1");
    assert_eq!(s.len(), 32);
    assert!(s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    assert_eq!(s, signature("select 1"));
}

#[test]
fn empty_script_has_a_signature() {
    assert_eq!(signature(""), signature("  -- nothing\n"));
    assert_ne!(signature(""), signature("select 1"));
}

#[test]
fn layout_and_comments_are_ignored() {
    assert_eq!(signature("select 1"), signature("  select   1 ;"));
    assert_eq!(signature("select a from t"), signature("select\n  a\nfrom /* x */ t -- y"));
    assert_eq!(signature("SELECT a FROM t"), signature("select a from t"));
}

#[test]
fn literals_names_and_operators_matter() {
    let base = signature("select a + 1 from t where b = 'x'");
    assert_ne!(base, signature("select a + 2 from t where b = 'x'"));
    assert_ne!(base, signature("select a - 1 from t where b = 'x'"));
    assert_ne!(base, signature("select c + 1 from t where b = 'x'"));
    assert_ne!(base, signature("select a + 1 from u where b = 'x'"));
    assert_ne!(base, signature("select a + 1 from t where b = 'y'"));
    assert_ne!(signature("select 1.5"), signature("select 1.6"));
    assert_ne!(signature("select 1"), signature("select 1.0"));
    assert_ne!(signature("select interval '1 day'"), signature("select interval '2 day'"));
    assert_ne!(signature("select null"), signature("select 1"));
}

#[test]
fn booleans_and_enums_matter() {
    assert_ne!(signature("select distinct a from t"), signature("select a from t"));
    assert_ne!(signature("select a from t order by a asc"), signature("select a from t order by a desc"));
    assert_ne!(signature("select a from t order by a nulls first"), signature("select a from t order by a nulls last"));
}

#[test]
fn statement_count_and_order_matter() {
    assert_ne!(signature("select 1; select 2"), signature("select 1"));
    assert_ne!(signature("select 1; select 2"), signature("select 2; select 1"));
    assert_ne!(signature("create table t (a int); select a from t"), signature("select a from t"));
}

#[test]
fn trailing_visualize_is_signed_like_its_select() {
    let plain = signature("select a from t");
    assert_eq!(plain, signature("select a from t visualize using table ()"));
    assert_eq!(plain, signature("select a from t visualize using vegalite (mark => bar)"));
    // The source of the VISUALIZE statement still counts
    assert_ne!(plain, signature("select b from t visualize using table ()"));
    // Prefix statements stay part of the signature
    assert_eq!(
        signature("create table t (a int); select a from t"),
        signature("create table t (a int); select a from t visualize using table ()")
    );
}

#[test]
fn scripts_with_errors_have_no_signature() {
    assert_eq!(signature_error("select 1 +;"), StatusCode::SCRIPT_NOT_PARSED);
    assert_eq!(signature_error("select 'unterminated"), StatusCode::SCRIPT_NOT_PARSED);
}

#[test]
fn script_api_signs_with_and_without_reparsing() {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    // Without a parse there is nothing to sign
    script.replace_text("select 1");
    assert_eq!(script.compute_signature(false).unwrap_err().status, Some(StatusCode::SCRIPT_NOT_PARSED));
    let first = script.compute_signature(true).unwrap();
    assert_eq!(first, signature("select 1"));
    script.replace_text("select 2");
    // An outdated parse is refreshed on request only
    assert_eq!(script.compute_signature(false).unwrap(), first);
    assert_eq!(script.compute_signature(true).unwrap(), signature("select 2"));
}
