//! A port of the C++ `test/completion_test.cc`.

// Bison names some symbol kinds in mixed case (S_Op)
#![allow(non_upper_case_globals)]

use dashql_buffers::analyzer::NameTag;
use dashql_buffers::completion::CandidateTag;
use dashql_core::catalog::Catalog;
use dashql_core::completion::{is_symbol_kind_completable, Candidate, Completion};
use dashql_core::pack::pack_completion;
use dashql_core::script::Script;
use dashql_parser::symbol_kind::*;

/// The default limit of `Script::CompleteAtCursor`
const DEFAULT_LIMIT: usize = 10;

fn find_candidate<'x>(completion: &'x Completion, name: &str) -> Option<&'x Candidate> {
    completion.top_candidates.iter().find(|c| &*c.completion_text == name)
}

fn has_tag(candidate: &Candidate, tag: CandidateTag) -> bool {
    candidate.candidate_tags & tag.0 != 0
}

fn has_name_tag(candidate: &Candidate, tag: NameTag) -> bool {
    candidate.coarse_name_tags & tag.0 != 0
}

/// Create and analyze a script
fn analyze(catalog: &Catalog, text: &str) -> Script {
    let mut script = Script::new(catalog);
    script.insert_text_at(0, text);
    script.analyze(catalog, true).unwrap();
    script
}

/// Create, analyze and load a script into the catalog with rank 0
fn load_schema(catalog: &mut Catalog, text: &str) -> Script {
    let script = analyze(catalog, text);
    catalog.load_script(script.analyzed.clone().unwrap(), 0).unwrap();
    script
}

/// Analyze a script, move the cursor to a text offset and complete with a limit.
/// Calls `check` with the completion.
fn complete_at(catalog: &Catalog, text: &str, offset: usize, limit: usize, check: impl FnOnce(&Completion)) {
    let mut script = analyze(catalog, text);
    let cursor = script.move_cursor(catalog, offset);
    let completion = Script::complete_at_cursor(&cursor, limit).unwrap();
    check(&completion);
}

/// The offset right after the first occurrence of `needle`
fn after(text: &str, needle: &str) -> usize {
    text.find(needle).unwrap() + needle.len()
}

/// The offset right after the last occurrence of `needle`
fn after_last(text: &str, needle: &str) -> usize {
    text.rfind(needle).unwrap() + needle.len()
}

#[test]
fn operators_are_not_completable() {
    for symbol in [S_EQUALS, S_Op, S_EQUALS_GREATER, S_LESS_EQUALS, S_GREATER_EQUALS, S_NOT_EQUALS] {
        assert!(!is_symbol_kind_completable(symbol));
    }
    assert!(is_symbol_kind_completable(S_IDENT));
}

const TPCH_SCHEMA: &str = r#"
create table part (p_partkey integer not null, p_name varchar(55) not null, p_mfgr char(25) not null, p_brand char(10) not null, p_type varchar(25) not null, p_size integer not null, p_container char(10) not null, p_retailprice decimal(12,2) not null, p_comment varchar(23) not null, primary key (p_partkey));
create table supplier (s_suppkey integer not null, s_name char(25) not null, s_address varchar(40) not null, s_nationkey integer not null, s_phone char(15) not null, s_acctbal decimal(12,2) not null, s_comment varchar(101) not null, primary key (s_suppkey));
create table partsupp (ps_partkey integer not null, ps_suppkey integer not null, ps_availqty integer not null, ps_supplycost decimal(12,2) not null, ps_comment varchar(199) not null, primary key (ps_partkey,ps_suppkey));
create table customer (c_custkey integer not null, c_name varchar(25) not null, c_address varchar(40) not null, c_nationkey integer not null, c_phone char(15) not null, c_acctbal decimal(12,2) not null, c_mktsegment char(10) not null, c_comment varchar(117) not null, primary key (c_custkey));
create table orders (o_orderkey integer not null, o_custkey integer not null, o_orderstatus char(1) not null, o_totalprice decimal(12,2) not null, o_orderdate date not null, o_orderpriority char(15) not null, o_clerk char(15) not null, o_shippriority integer not null, o_comment varchar(79) not null, primary key (o_orderkey));
create table lineitem (l_orderkey integer not null, l_partkey integer not null, l_suppkey integer not null, l_linenumber integer not null, l_quantity decimal(12,2) not null, l_extendedprice decimal(12,2) not null, l_discount decimal(12,2) not null, l_tax decimal(12,2) not null, l_returnflag char(1) not null, l_linestatus char(1) not null, l_shipdate date not null, l_commitdate date not null, l_receiptdate date not null, l_shipinstruct char(25) not null, l_shipmode char(10) not null, l_comment varchar(44) not null, primary key (l_orderkey,l_linenumber));
create table nation (n_nationkey integer not null, n_name char(25) not null, n_regionkey integer not null, n_comment varchar(152) not null, primary key (n_nationkey));
create table region (r_regionkey integer not null, r_name char(25) not null, r_comment varchar(152) not null, primary key (r_regionkey));
"#;

#[test]
fn tpch_q2() {
    let main_script_text = "\nSELECT s_co\n    ";

    let mut catalog = Catalog::new();
    let mut external_script = Script::new(&catalog);
    external_script.insert_text_at(0, TPCH_SCHEMA);
    external_script.scan();
    external_script.parse();
    external_script.analyze(&catalog, true).unwrap();
    catalog.load_script(external_script.analyzed.clone().unwrap(), 0).unwrap();

    let mut main_script = Script::new(&catalog);
    main_script.insert_text_at(0, main_script_text);
    main_script.scan();
    main_script.parse();
    main_script.analyze(&catalog, true).unwrap();

    // Move the cursor
    let cursor_ofs = main_script_text.find("s_co").unwrap();
    assert_eq!(cursor_ofs, 8);
    let cursor = main_script.move_cursor(&catalog, cursor_ofs + "s_co".len());

    // Compute completion
    let completion = Script::complete_at_cursor(&cursor, DEFAULT_LIMIT).unwrap();
    let names: Vec<String> = completion
        .top_candidates
        .iter()
        .map(|candidate| match candidate.keyword_continuation.filter(|k| !k.is_empty()) {
            Some(continuation) => format!("{} {}", candidate.completion_text, continuation),
            None => candidate.completion_text.to_string(),
        })
        .collect();
    let expected_names = ["s_co", "s_comment", "ps_comment", "from", "where", "group by", "order by", "by", "case", "cast"];
    assert_eq!(names, expected_names);
}

#[test]
fn dot_completion_before_later_cte_lines() {
    let mut catalog = Catalog::new();
    let _schema = load_schema(
        &mut catalog,
        "CREATE TABLE uip_iceberg.cdp_usage_nonprod_events.hyperdb_queries(event_id BIGINT, processed_rows BIGINT);",
    );

    let text = "with foo as (\nselect * from uip_iceberg.cdp_usage_nonprod_events.hyperdb_queries q where q.\n\n) ";
    let mut script = analyze(&catalog, text);
    let cursor_offset = text.find("q.\n").unwrap() + 2;
    let cursor = script.move_cursor(&catalog, cursor_offset);
    let location = cursor.scanner_location.expect("scanner location");
    assert!(location.current.is_trailing_dot() || location.previous.is_some_and(|p| p.is_trailing_dot()));
    assert!(!cursor.name_scopes.is_empty());
    assert!(matches!(cursor.context, dashql_core::cursor::CursorContext::ColumnRef { .. }));

    let completion = Script::complete_at_cursor(&cursor, 50).unwrap();
    assert!(find_candidate(&completion, "event_id").is_some());
    assert!(find_candidate(&completion, "processed_rows").is_some());
}

#[test]
fn completes_qualified_columns_in_explicit_join() {
    let mut catalog = Catalog::new();
    let _schema = load_schema(&mut catalog, "CREATE TABLE test1(a int, a_value int); CREATE TABLE test2(b int, b_value int);");

    for (qualifier, expected_column) in [("a.", "a_value"), ("b.", "b_value")] {
        let text = format!("select * from test1 a left outer join test2 b on {qualifier}");
        let mut script = analyze(&catalog, &text);
        let cursor = script.move_cursor(&catalog, text.len());
        assert!(!cursor.name_scopes.is_empty(), "{qualifier}");
        let analyzed = cursor.script.analyzed.unwrap();
        let scope = &analyzed.name_scopes[cursor.name_scopes[0] as usize];
        assert!(scope.referenced_tables_by_name.contains("a"));
        assert!(scope.referenced_tables_by_name.contains("b"));
        assert!(matches!(cursor.context, dashql_core::cursor::CursorContext::ColumnRef { .. }), "{qualifier}");

        let completion = Script::complete_at_cursor(&cursor, 50).unwrap();
        assert!(find_candidate(&completion, expected_column).is_some(), "{qualifier}");
    }
}

#[test]
fn insert_target_columns_are_in_scope() {
    let mut catalog = Catalog::new();
    let _schema = load_schema(&mut catalog, "CREATE TABLE target(id int, label text);");

    let text = "insert into target(la) values (1)";
    complete_at(&catalog, text, text.find("la)").unwrap() + 2, DEFAULT_LIMIT, |completion| {
        let candidate = find_candidate(completion, "label").expect("label");
        assert!(has_tag(candidate, CandidateTag::IN_NAME_SCOPE));
    });
}

#[test]
fn insert_returning_columns_are_in_scope() {
    let mut catalog = Catalog::new();
    let _schema = load_schema(&mut catalog, "CREATE TABLE target(id int, label text);");

    let text = "insert into target values (1, 'one') returning la";
    complete_at(&catalog, text, text.len(), DEFAULT_LIMIT, |completion| {
        let candidate = find_candidate(completion, "label").expect("label");
        assert!(has_tag(candidate, CandidateTag::IN_NAME_SCOPE));
    });
}

#[test]
fn insert_source_does_not_see_write_target_columns() {
    let mut catalog = Catalog::new();
    let _schema = load_schema(&mut catalog, "CREATE TABLE target(id int, label text); CREATE TABLE source(source_id int);");

    let text = "insert into target select la from source";
    complete_at(&catalog, text, text.find("la from").unwrap() + 2, DEFAULT_LIMIT, |completion| {
        if let Some(candidate) = find_candidate(completion, "label") {
            assert!(!has_tag(candidate, CandidateTag::IN_NAME_SCOPE));
        }
    });
}

#[test]
fn insert_source_completes_leading_cte() {
    let mut catalog = Catalog::new();
    let _schema = load_schema(&mut catalog, "CREATE TABLE target(id int);");

    let text = "with source as (select 1 as id) insert into target select * from sou";
    complete_at(&catalog, text, text.len(), DEFAULT_LIMIT, |completion| {
        let candidate = find_candidate(completion, "source").expect("source");
        assert!(has_tag(candidate, CandidateTag::IN_NAME_SCOPE));
    });
}

#[test]
fn insert_source_does_not_dot_complete_write_target() {
    let mut catalog = Catalog::new();
    let _schema = load_schema(&mut catalog, "CREATE TABLE target(id int, label text);");

    let text = "insert into target select target.la";
    complete_at(&catalog, text, text.len(), DEFAULT_LIMIT, |completion| {
        assert!(find_candidate(completion, "label").is_none());
    });
}

/// Scan, parse and analyze a script, complete at the end of `needle`, and return the candidate with
/// the completion text `name` (`None` if missing) and its keyword continuation
fn continuation_of(catalog: &Catalog, text: &str, needle: &str, name: &str) -> Option<Option<&'static str>> {
    let mut script = Script::new(catalog);
    script.insert_text_at(0, text);
    script.scan();
    script.parse();
    script.analyze(catalog, true).unwrap();
    let cursor = script.move_cursor(catalog, after(text, needle));
    let completion = Script::complete_at_cursor(&cursor, DEFAULT_LIMIT).unwrap();
    find_candidate(&completion, name).map(|c| c.keyword_continuation.filter(|k| !k.is_empty()))
}

#[test]
fn keyword_continuation_group_by() {
    let catalog = Catalog::new();
    let continuation = continuation_of(&catalog, "\nSELECT * FROM supplier gro\n    ", "gro", "group");
    assert_eq!(continuation, Some(Some("by")), "Expected 'group' candidate with continuation");
}

#[test]
fn keyword_continuation_order_by() {
    let catalog = Catalog::new();
    let continuation = continuation_of(&catalog, "\nSELECT * FROM supplier ord\n    ", "ord", "order");
    assert_eq!(continuation, Some(Some("by")), "Expected 'order' candidate with continuation");
}

#[test]
fn keyword_continuation_no_ambiguous() {
    let catalog = Catalog::new();
    // "select" has many possible continuations, should NOT have a keyword_continuation
    if let Some(continuation) = continuation_of(&catalog, "\nSELECT sel\n    ", "sel", "select") {
        assert_eq!(continuation, None, "'select' should not have a continuation (ambiguous)");
    }
}

#[test]
fn keyword_continuation_cte_identifier() {
    let mut catalog = Catalog::new();
    let mut external_script = Script::new(&catalog);
    external_script.insert_text_at(0, "create table foo(a int);");
    external_script.scan();
    external_script.parse();
    external_script.analyze(&catalog, true).unwrap();
    catalog.load_script(external_script.analyzed.clone().unwrap(), 0).unwrap();

    // Identifier candidate "foo" in CTE position should get "as" continuation
    let continuation = continuation_of(&catalog, "\nWITH fo\n    ", "fo", "foo");
    assert_eq!(continuation, Some(Some("as")), "'foo' should have 'as' continuation in CTE position");
}

#[test]
fn completes_prior_cte_in_later_from() {
    let text = "\nWITH events AS (SELECT 1 AS event_id),\nfiltered AS (SELECT * FROM eve)\nSELECT * FROM filtered\n";
    let catalog = Catalog::new();
    complete_at(&catalog, text, text.find("eve)").unwrap() + "eve".len(), DEFAULT_LIMIT, |completion| {
        let candidate = find_candidate(completion, "events").expect("events");
        assert!(has_name_tag(candidate, NameTag::TABLE_NAME));
        assert!(has_tag(candidate, CandidateTag::IN_NAME_SCOPE));
        assert!(candidate.score > 50);
    });
}

#[test]
fn completes_cte_output_column_in_later_cte() {
    let text = "\nWITH events AS (SELECT 1 AS event_timestamp, 2 AS cpu_time),\nfiltered AS (SELECT event_t FROM events)\nSELECT * FROM filtered\n";
    let catalog = Catalog::new();
    complete_at(&catalog, text, text.find("event_t FROM").unwrap() + "event_t".len(), DEFAULT_LIMIT, |completion| {
        let candidate = find_candidate(completion, "event_timestamp").expect("event_timestamp");
        assert!(has_name_tag(candidate, NameTag::COLUMN_NAME));
        assert!(has_tag(candidate, CandidateTag::IN_NAME_SCOPE));
        assert!(candidate.score > 59);
    });
}

#[test]
fn completes_cte_output_column_after_dot() {
    let text = "\nWITH events AS (SELECT 1 AS event_timestamp, 2 AS cpu_time)\nSELECT events.event_t FROM events\n";
    let catalog = Catalog::new();
    complete_at(&catalog, text, text.find("event_t FROM").unwrap() + "event_t".len(), DEFAULT_LIMIT, |completion| {
        let candidate = find_candidate(completion, "event_timestamp").expect("event_timestamp");
        assert!(has_tag(candidate, CandidateTag::DOT_RESOLUTION_COLUMN));
        assert!(has_tag(candidate, CandidateTag::IN_NAME_SCOPE));
    });
}

#[test]
fn local_cte_column_shadows_catalog_objects() {
    let text = "\nWITH events AS (SELECT 1 AS event_timestamp)\nSELECT event_t FROM events\n";
    let mut catalog = Catalog::new();
    let _catalog_script = load_schema(&mut catalog, "CREATE TABLE unrelated(event_timestamp int);");

    complete_at(&catalog, text, text.find("event_t FROM").unwrap() + "event_t".len(), DEFAULT_LIMIT, |completion| {
        let candidate = find_candidate(completion, "event_timestamp").expect("event_timestamp");
        assert!(has_tag(candidate, CandidateTag::IN_NAME_SCOPE));
        assert!(candidate.catalog_objects.is_empty());
    });
}

#[test]
fn does_not_complete_later_or_self_cte() {
    let text = "\nWITH first AS (SELECT * FROM la),\nlater AS (SELECT 1 AS value)\nSELECT * FROM first\n";
    let catalog = Catalog::new();
    complete_at(&catalog, text, text.find("la)").unwrap() + "la".len(), DEFAULT_LIMIT, |completion| {
        if let Some(candidate) = find_candidate(completion, "later") {
            assert!(!has_tag(candidate, CandidateTag::IN_NAME_SCOPE));
        }
    });
}

#[test]
fn completes_self_cte_only_when_recursive() {
    for (query, expect_in_scope) in [
        ("WITH items AS (SELECT * FROM ite) SELECT * FROM items", false),
        ("WITH RECURSIVE items AS (SELECT * FROM ite) SELECT * FROM items", true),
    ] {
        let catalog = Catalog::new();
        complete_at(&catalog, query, query.find("ite)").unwrap() + "ite".len(), DEFAULT_LIMIT, |completion| {
            let candidate = find_candidate(completion, "items").expect("items");
            assert_eq!(has_tag(candidate, CandidateTag::IN_NAME_SCOPE), expect_in_scope, "{query}");
        });
    }
}

/// Scan, parse and analyze a script and complete at its end
fn complete_at_end(text: &str, check: impl FnOnce(&Completion)) {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.insert_text_at(0, text);
    script.scan();
    script.parse();
    script.analyze(&catalog, true).unwrap();
    let cursor = script.move_cursor(&catalog, text.len());
    let completion = Script::complete_at_cursor(&cursor, DEFAULT_LIMIT).unwrap();
    check(&completion);
}

#[test]
fn passive_hint_select_star() {
    // Should suggest FROM as the top candidate (not WHERE)
    complete_at_end("select * ", |completion| {
        assert!(!completion.top_candidates.is_empty());
        assert_eq!(&*completion.top_candidates[0].completion_text, "from");
    });
}

#[test]
fn function_call_is_atomic() {
    let mut catalog = Catalog::new();
    let _schema = load_schema(&mut catalog, "create function mysum(x int) returns int;");

    let text = "select mys";
    complete_at(&catalog, text, text.len(), 10, |completion| {
        let packed = pack_completion(completion, false);
        let candidate = packed
            .candidates
            .as_ref()
            .unwrap()
            .iter()
            .find(|c| c.display_text.as_deref() == Some("mysum"))
            .expect("mysum");
        assert_eq!(candidate.completion_text.as_deref(), Some("mysum()"));
        assert_eq!(candidate.completion_cursor_offset as usize, "mysum(".len());
    });
}

#[test]
fn passive_hint_suppress_after_from() {
    // Should produce no passive hint after FROM
    complete_at_end("select * from ", |completion| assert!(completion.top_candidates.is_empty()));
}

#[test]
fn passive_hint_suppress_after_where() {
    // Should produce no passive hint after WHERE
    complete_at_end("select * from foo where ", |completion| assert!(completion.top_candidates.is_empty()));
}

#[test]
fn passive_hint_after_from_table() {
    // After a table name, should suggest WHERE (not suppressed)
    complete_at_end("select * from foo ", |completion| {
        assert!(!completion.top_candidates.is_empty());
        assert_eq!(&*completion.top_candidates[0].completion_text, "where");
    });
}

#[test]
fn inline_visualize_source_output_alias() {
    let text = r#"
SELECT category AS chart_category, SUM(amount) AS chart_total
FROM sales
GROUP BY category
 VISUALIZE USING vegalite (
    encoding => (y => (field => chart_t, type => quantitative))
)
"#;
    let catalog = Catalog::new();
    complete_at(&catalog, text, after_last(text, "chart_t"), DEFAULT_LIMIT, |completion| {
        let mut found = false;
        for candidate in completion.top_candidates.iter().filter(|c| &*c.completion_text == "chart_total") {
            found = true;
            assert!(has_name_tag(candidate, NameTag::COLUMN_NAME));
            assert!(has_tag(candidate, CandidateTag::IN_NAME_SCOPE));
            assert!(candidate.score > 59);
        }
        assert!(found);
    });
}

#[test]
fn cte_visualize_source_output_alias() {
    let text = r#"
WITH events AS (
    SELECT 1 AS ts_hour, 2 AS cpu_time, true AS marker
), filtered AS (
    SELECT * FROM events
), aggregates_other AS (
    SELECT ts_hour, SUM(cpu_time) AS metric, 'other' AS marker
    FROM filtered
    WHERE NOT marker
    GROUP BY ts_hour
)
SELECT * FROM aggregates_other
 VISUALIZE USING vegalite (
    mark => bar,
    encoding => (y => (field => met, type => quantitative))
)
"#;
    let catalog = Catalog::new();
    complete_at(&catalog, text, after_last(text, "met"), DEFAULT_LIMIT, |completion| {
        let candidate = find_candidate(completion, "metric").expect("metric");
        assert!(has_tag(candidate, CandidateTag::IN_NAME_SCOPE));
        assert!(candidate.score > 59);
    });
}

#[test]
fn visualize_outputs_do_not_leak_into_source() {
    let text = r#"
SELECT amount AS chart_total
FROM chart_t
 VISUALIZE USING vegalite (
    encoding => (y => (field => chart_total))
)
"#;
    let catalog = Catalog::new();
    complete_at(&catalog, text, text.find("chart_t\n").unwrap() + "chart_t".len(), DEFAULT_LIMIT, |completion| {
        if let Some(candidate) = find_candidate(completion, "chart_total") {
            assert!(!has_tag(candidate, CandidateTag::IN_NAME_SCOPE));
        }
    });
}

#[test]
fn visualize_fields_do_not_promote_tables_in_source() {
    let text = r#"
SELECT amount
FROM chart_t
 VISUALIZE USING vegalite (
    encoding => (y => (field => chart_total))
)
"#;
    let mut catalog = Catalog::new();
    let _catalog_script = load_schema(&mut catalog, "CREATE TABLE measurements(chart_total int, spec_only_peer int);");

    complete_at(&catalog, text, text.find("chart_t\n").unwrap() + "chart_t".len(), DEFAULT_LIMIT, |completion| {
        if let Some(candidate) = find_candidate(completion, "chart_total") {
            assert!(!has_tag(candidate, CandidateTag::UNRESOLVED_PEER));
        }
    });
}

/// Scan, parse and analyze a script and complete at the end of `needle`
fn complete_after(text: &str, needle: &str, check: impl FnOnce(&Completion)) {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.insert_text_at(0, text);
    script.scan();
    script.parse();
    script.analyze(&catalog, true).unwrap();
    let cursor = script.move_cursor(&catalog, after(text, needle));
    let completion = Script::complete_at_cursor(&cursor, DEFAULT_LIMIT).unwrap();
    check(&completion);
}

#[test]
fn no_completion_inside_line_comment() {
    // Cursor at the end of "sel" inside the line comment.
    complete_after("\nSELECT 1 -- sel\n    ", "sel", |completion| {
        assert!(
            completion.top_candidates.is_empty(),
            "Expected no completion inside a line comment, got {}",
            completion.top_candidates.len()
        );
    });
}

#[test]
fn no_completion_inside_block_comment() {
    // Cursor at the end of "sel" inside the block comment.
    complete_after("\nSELECT 1 /* sel */ FROM x\n    ", "sel", |completion| {
        assert!(
            completion.top_candidates.is_empty(),
            "Expected no completion inside a block comment, got {}",
            completion.top_candidates.len()
        );
    });
}

#[test]
fn completion_right_before_comment() {
    // Cursor at the end of "gro", immediately before the `--` comment start.
    // The comment right after the cursor must not suppress completion: "group" is still offered.
    complete_after("\nSELECT * FROM supplier gro-- comment\n    ", "gro", |completion| {
        assert!(find_candidate(completion, "group").is_some(), "Expected completion right before a comment");
    });
}

#[test]
fn identity_candidate_reproduces_quoted_input_verbatim() {
    // A delimited identifier in a projection whose schema is unknown (e.g. an external() table)
    // has no matching catalog name, so the identity candidate is what the user accepts. It must
    // reproduce the typed text verbatim, so completing it is a no-op instead of a visible
    // delete-and-reinsert. Two failure modes we guard against:
    //   - `"Year"` re-quoted a second time by Pack() -> `"""Year"""`
    //   - `"year"` re-emitted unquoted -> `year` (dropping the quotes the user typed)
    for typed in ["\"Year\"", "\"year\""] {
        let text = format!("SELECT {typed}");
        let catalog = Catalog::new();
        let mut script = Script::new(&catalog);
        script.insert_text_at(0, &text);
        script.scan();
        script.parse();
        script.analyze(&catalog, true).unwrap();

        // Cursor just before the closing quote of the delimited identifier.
        let cursor = script.move_cursor(&catalog, text.len() - 1);
        let completion = Script::complete_at_cursor(&cursor, DEFAULT_LIMIT).unwrap();

        let mut found_identity = false;
        for candidate in &completion.top_candidates {
            if has_tag(candidate, CandidateTag::IDENTITY) {
                found_identity = true;
                // The identity candidate must equal the typed text, quotes and all.
                assert_eq!(&*candidate.completion_text, typed, "Identity candidate must reproduce the typed text verbatim");
            }
        }
        assert!(found_identity, "Expected an identity candidate for {typed}");
    }
}

#[test]
fn completes_inserted_cte_name_before_long_suffix() {
    let main_script_text = r#"with  as (
    select
      *,
      date_trunc('hour', event_timestamp) ts_hour
    from uip_iceberg.cdp_usage_prod_events.hyperdb_queries
    where tenant = 'a360/prod/1e51a99248ee43beb982c09ea3ed8786'
    and event_timestamp >= current_timestamp - interval '30' day
), windowed as (
  select
    *,
    ts_hour,
    row_number() over (partition by tenant order by processed_rows desc) as rnk_processed_rows
  from d
)
select *
from windowed
where rnk_processed_rows < 10
"#;
    let catalog = Catalog::new();
    let mut main_script = analyze(&catalog, main_script_text);

    let cursor_offset = "with ".len();
    main_script.move_cursor(&catalog, cursor_offset);
    main_script.insert_text_at(cursor_offset, "q");
    main_script.analyze(&catalog, true).unwrap();
    let cursor = main_script.move_cursor(&catalog, cursor_offset + 1);
    assert!(Script::complete_at_cursor(&cursor, DEFAULT_LIMIT).is_ok());
}
