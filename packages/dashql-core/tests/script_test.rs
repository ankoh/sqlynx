//! A port of the C++ `test/script_test.cc`.
//!
//! Not ported: `TextVersionAndAnalysisSnapshotExceed32Bits`, which writes the public C++ field
//! `text_version`; the Rust text version is private and only bumped by edits.

use dashql_buffers::status::StatusCode;
use dashql_core::catalog::Catalog;
use dashql_core::script::Script;
use dashql_parser::span::TextSpan;

#[test]
fn text_version_changes_only_for_successful_text_edits() {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.insert_text_at(100, "");
    script.erase_text_range(0, 100);
    script.replace_text("");
    assert_eq!(script.text_version(), 0);

    script.insert_text_at(100, "a\u{e9}z");
    assert_eq!(script.text_version(), 1);
    script.insert_text_at(1, "");
    script.erase_text_range(1, 0);
    script.erase_text_range(3, 100);
    script.erase_text_range(100, 100);
    script.replace_text("a\u{e9}z");
    assert_eq!(script.text_version(), 1);
    assert_eq!(script.to_text(), "a\u{e9}z");

    // The C++ test passes invalid UTF-8 ("\xFF") and expects std::invalid_argument without a version
    // bump. Rust text is &str, so invalid UTF-8 cannot reach the script.

    script.insert_char_at(100, '!' as u32);
    assert_eq!(script.text_version(), 2);
    assert_eq!(script.to_text(), "a\u{e9}z!");
    script.erase_text_range(1, 100);
    assert_eq!(script.text_version(), 3);
    assert_eq!(script.to_text(), "a");
    script.replace_text("select 1");
    assert_eq!(script.text_version(), 4);
}

#[test]
fn parse_auto_scans() {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.insert_text_at(0, "select 1");
    script.parse();
    assert!(script.parsed.is_some());
}

#[test]
fn analyze_special_function_arguments() {
    let scripts = ["select coalesce(a, b)", "select nullif(a, b)", "select current_time(2)", "select substring(a, 1, 2)"];
    let catalog = Catalog::new();
    for input in scripts {
        let mut script = Script::new(&catalog);
        script.insert_text_at(0, input);
        assert!(script.analyze(&catalog, true).is_ok(), "{input}");
    }
}

#[test]
fn analyze_malformed_query_with_function_arguments() {
    let input = r#"
with events as (
    select *,
      ,
), aggregates_other as (
    select ts_hour, count(*) as metric, 'other' as target
    from events
    where not marker
    group by ts_hour, marker
), aggregates_filtered as (
    select ts_hour, count(*) as metric, 'filtered' as target
    from events
    where marker
    group by ts_hour
)
select * from aggregates_other
union all select * from aggregates_filtered
visualize using vegalite (
    mark => line,
    encoding => (
        x => (field => ts_hour, type => temporal),
        y => (field => metric, type => quantitative, aggregate => 'sum'),
        color => (field => target)
    )
);
"#;
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.insert_text_at(0, input);

    script.analyze(&catalog, true).unwrap();
    let parsed = script.parsed.as_ref().expect("parsed script");
    assert!(!parsed.errors.is_empty());
}

#[test]
fn analyzing_before_parsing() {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    let error = script.analyze(&catalog, false).unwrap_err();
    assert_eq!(error.status, Some(StatusCode::SCRIPT_NOT_PARSED));
}

#[test]
fn tpch_q2() {
    let external_script_text = r#"
create table part (p_partkey integer not null, p_name varchar(55) not null, p_mfgr char(25) not null, p_brand char(10) not null, p_type varchar(25) not null, p_size integer not null, p_container char(10) not null, p_retailprice decimal(12,2) not null, p_comment varchar(23) not null, primary key (p_partkey));
create table supplier (s_suppkey integer not null, s_name char(25) not null, s_address varchar(40) not null, s_nationkey integer not null, s_phone char(15) not null, s_acctbal decimal(12,2) not null, s_comment varchar(101) not null, primary key (s_suppkey));
create table partsupp (ps_partkey integer not null, ps_suppkey integer not null, ps_availqty integer not null, ps_supplycost decimal(12,2) not null, ps_comment varchar(199) not null, primary key (ps_partkey,ps_suppkey));
create table customer (c_custkey integer not null, c_name varchar(25) not null, c_address varchar(40) not null, c_nationkey integer not null, c_phone char(15) not null, c_acctbal decimal(12,2) not null, c_mktsegment char(10) not null, c_comment varchar(117) not null, primary key (c_custkey));
create table orders (o_orderkey integer not null, o_custkey integer not null, o_orderstatus char(1) not null, o_totalprice decimal(12,2) not null, o_orderdate date not null, o_orderpriority char(15) not null, o_clerk char(15) not null, o_shippriority integer not null, o_comment varchar(79) not null, primary key (o_orderkey));
create table lineitem (l_orderkey integer not null, l_partkey integer not null, l_suppkey integer not null, l_linenumber integer not null, l_quantity decimal(12,2) not null, l_extendedprice decimal(12,2) not null, l_discount decimal(12,2) not null, l_tax decimal(12,2) not null, l_returnflag char(1) not null, l_linestatus char(1) not null, l_shipdate date not null, l_commitdate date not null, l_receiptdate date not null, l_shipinstruct char(25) not null, l_shipmode char(10) not null, l_comment varchar(44) not null, primary key (l_orderkey,l_linenumber));
create table nation (n_nationkey integer not null, n_name char(25) not null, n_regionkey integer not null, n_comment varchar(152) not null, primary key (n_nationkey));
create table region (r_regionkey integer not null, r_name char(25) not null, r_comment varchar(152) not null, primary key (r_regionkey));
    "#;

    let main_script_text = r#"
select
    s_acctbal,
    s_name,
    n_name,
    p_partkey,
    p_mfgr,
    s_address,
    s_phone,
    s_comment
from
    part,
    supplier,
    partsupp,
    nation,
    region
where
    p_partkey = ps_partkey
    and s_suppkey = ps_suppkey
    and p_size = 15
    and p_type like '%BRASS'
    and s_nationkey = n_nationkey
    and n_regionkey = r_regionkey
    and r_name = 'EUROPE'
    and ps_supplycost = (
        select
            min(ps_supplycost)
        from
            partsupp,
            supplier,
            nation,
            region
        where
            p_partkey = ps_partkey
            and s_suppkey = ps_suppkey
            and s_nationkey = n_nationkey
            and n_regionkey = r_regionkey
            and r_name = 'EUROPE'
    )
order by
    s_acctbal desc,
    n_name,
    s_name,
    p_partkey
limit 100
    "#;

    let mut catalog = Catalog::new();
    let mut external_script = Script::new(&catalog);
    external_script.insert_text_at(0, external_script_text);
    external_script.scan();
    external_script.parse();
    external_script.analyze(&catalog, true).unwrap();

    let mut main_script = Script::new(&catalog);
    main_script.insert_text_at(0, main_script_text);
    main_script.scan();
    main_script.parse();

    catalog.load_script(external_script.analyzed.clone().unwrap(), 0).unwrap();
    main_script.analyze(&catalog, true).unwrap();
}

#[test]
fn replace_text() {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.insert_text_at(0, "foo");
    assert_eq!(script.to_text(), "foo");
    script.replace_text("bar");
    assert_eq!(script.to_text(), "bar");
}

#[test]
fn converts_text_span_to_string() {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);

    script.replace_text("select 'Grüße'");
    assert_eq!(script.to_text_span(TextSpan { offset: 7, length: 9 }), "'Grüße'");
    assert_eq!(script.to_text_span(TextSpan { offset: 100, length: 1 }), "");
}

fn parsed_script(text: &str) -> Script {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.replace_text(text);
    script.parse();
    script
}

#[test]
fn statement_text_is_the_first_statement_without_separator() {
    assert_eq!(parsed_script("  select 1 ; select 2").statement_text(false).unwrap(), "select 1");
    assert_eq!(parsed_script("").statement_text(false).unwrap(), "");
    assert_eq!(parsed_script("-- only a comment").statement_text(false).unwrap(), "");

    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.replace_text("select 1");
    assert_eq!(script.statement_text(false).unwrap_err().status, Some(StatusCode::SCRIPT_NOT_PARSED));
    assert_eq!(script.statement_text(true).unwrap(), "select 1");
}

#[test]
fn rewrite_dashboard_replaces_or_appends_the_clause() {
    let mut script = parsed_script("select 1 visualize using table ()");
    assert_eq!(
        script.rewrite_dashboard(Some(2), Some(3), 4, 5, false).unwrap(),
        "select 1 visualize using table (dashboard => (row => 2, column => 3, width => 4, height => 5))"
    );
    // Existing clauses are replaced, other fields stay
    let mut script = parsed_script("select 1 visualize using vegalite (mark => bar, dashboard => (row => 9, width => 1))");
    assert_eq!(
        script.rewrite_dashboard(None, None, 6, 3, false).unwrap(),
        "select 1 visualize using vegalite (mark => bar, dashboard => (width => 6, height => 3))"
    );
    // Fields are appended to a spec with other fields
    let mut script = parsed_script("select 1 visualize using vegalite (mark => bar)");
    assert_eq!(
        script.rewrite_dashboard(Some(0), None, 12, 1, false).unwrap(),
        "select 1 visualize using vegalite (mark => bar, dashboard => (row => 0, width => 12, height => 1))"
    );
}

#[test]
fn rewrite_dashboard_clamps_the_grid() {
    let mut script = parsed_script("select 1 visualize using table ()");
    // Negative rows are dropped, the width is limited to the 12 columns, the column to the free space
    assert_eq!(
        script.rewrite_dashboard(Some(-1), Some(20), 40, -3, false).unwrap(),
        "select 1 visualize using table (dashboard => (column => 0, width => 12, height => 1))"
    );
    assert_eq!(
        script.rewrite_dashboard(None, Some(20), 4, 1, false).unwrap(),
        "select 1 visualize using table (dashboard => (column => 8, width => 4, height => 1))"
    );
    assert_eq!(
        script.rewrite_dashboard(None, Some(-5), 0, 2, false).unwrap(),
        "select 1 visualize using table (dashboard => (column => 0, width => 1, height => 2))"
    );
}

#[test]
fn rewrite_dashboard_needs_a_terminal_visualize_statement() {
    let not_parsed = Some(StatusCode::SCRIPT_NOT_PARSED);
    assert_eq!(parsed_script("select 1").rewrite_dashboard(None, None, 6, 3, false).unwrap_err().status, not_parsed);
    assert_eq!(parsed_script("").rewrite_dashboard(None, None, 6, 3, false).unwrap_err().status, not_parsed);
    assert_eq!(
        parsed_script("select 1 visualize using table (; ").rewrite_dashboard(None, None, 6, 3, false).unwrap_err().status,
        not_parsed
    );
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.replace_text("select 1 visualize using table ()");
    assert_eq!(script.rewrite_dashboard(None, None, 6, 3, false).unwrap_err().status, not_parsed);
    assert!(script.rewrite_dashboard(None, None, 6, 3, true).is_ok());
}

#[test]
fn rewrite_dashboard_applies_spans_to_the_current_text() {
    // The spans of the outdated parse are spliced into the new text like in C++
    let mut script = parsed_script("select 1 visualize using table ()");
    script.replace_text("select 1 visualize using table ()");
    assert!(script.rewrite_dashboard(None, None, 6, 3, false).is_ok());
    script.replace_text("x");
    let error = script.rewrite_dashboard(None, None, 6, 3, false);
    assert!(error.is_err(), "{error:?}");
}

#[test]
fn formatting_needs_a_parse_unless_requested() {
    use dashql_buffers::formatting::{FormattingConfigT, FormattingDialect, FormattingMode};
    let mut config = FormattingConfigT::default();
    config.dialect = FormattingDialect::HYPER;
    config.mode = FormattingMode::INLINE;
    config.max_width = 80;
    config.indentation_width = 4;

    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.replace_text("select   a ,b from   t");
    assert_eq!(script.format(&config, false).unwrap_err().status, Some(StatusCode::SCRIPT_NOT_PARSED));
    assert_eq!(script.format(&config, true).unwrap(), "select a, b from t;");
    assert_eq!(script.format_bytes(&config, false).unwrap(), b"select a, b from t;");
    assert!(script.is_fully_formattable(&config, false).unwrap());
    assert!(script.unformattable_nodes(&config, false).unwrap().is_empty());

    // A format of an outdated parse is refreshed on request
    script.replace_text("select 2");
    assert_eq!(script.format(&config, false).unwrap(), "select a, b from t;");
    assert_eq!(script.format(&config, true).unwrap(), "select 2;");
}

#[test]
fn statistics_describe_the_latest_analysis() {
    let catalog = Catalog::new();
    let mut script = Script::new(&catalog);
    script.replace_text("create table t (a int); select a from t;");
    // Before the first analysis only the rope has a size
    let memory = script.memory_statistics();
    assert_eq!(memory.rope_bytes as usize, script.to_text().len());
    assert_eq!(memory.latest_script.scanner_input_bytes, 0);

    script.analyze(&catalog, true).unwrap();
    let statistics = script.statistics();
    let memory = statistics.memory.unwrap();
    assert_eq!(memory.rope_bytes as usize, script.to_text().len());
    assert_eq!(memory.latest_script.scanner_input_bytes as usize, script.to_text().len());
    assert!(memory.latest_script.scanner_symbol_bytes > 0);
    assert!(memory.latest_script.scanner_name_dictionary_bytes > 0);
    assert!(memory.latest_script.parser_ast_bytes > 0);
    assert!(memory.latest_script.analyzer_description_bytes > 0);
    assert!(statistics.timings.is_some());
    assert_eq!(&script.timings().clone(), statistics.timings.as_ref().unwrap());
}
