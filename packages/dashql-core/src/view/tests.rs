//! Port of the C++ `test/hyper_plan_test.cc`.

use super::PlanViewModel;
use dashql_buffers::view as fb;

fn default_config() -> fb::PlanLayoutConfig {
    let mut config = fb::PlanLayoutConfig::default();
    config.set_level_height(64.0);
    config.set_node_height(32.0);
    config.set_node_padding_left(8.0);
    config.set_node_padding_right(8.0);
    config.set_max_label_chars(20);
    config.set_width_per_label_char(8.5);
    config
}

fn pack_plan_with(plan: &str, config: &fb::PlanLayoutConfig) -> Vec<u8> {
    let mut model = PlanViewModel::new();
    model.configure(config);
    model.parse_hyper_plan(plan.as_bytes()).expect("plan must parse");
    model.compute_layout();
    model.pack_buffer()
}

fn pack_plan(plan: &str) -> Vec<u8> {
    pack_plan_with(plan, &default_config())
}

fn root(buffer: &[u8]) -> fb::PlanViewModel<'_> {
    flatbuffers::root::<fb::PlanViewModel>(buffer).expect("valid plan view model")
}

fn make_layout_config(margin: f64) -> fb::PlanLayoutConfig {
    let mut config = fb::PlanLayoutConfig::default();
    config.set_level_height(20.0);
    config.set_node_height(8.0);
    config.set_node_margin_horizontal(margin);
    config.set_node_padding_left(0.25);
    config.set_node_padding_right(0.25);
    config.set_max_label_chars(20);
    config.set_width_per_label_char(1.25);
    config
}

fn string<'a>(plan: &fb::PlanViewModel<'a>, id: u32) -> &'a str {
    plan.string_dictionary().unwrap().get(id as usize)
}

fn expect_same_level_nodes_do_not_overlap(plan: &fb::PlanViewModel, margin: f64) {
    let operators = plan.operators().unwrap();
    for i in 0..operators.len() {
        let left = *operators.get(i).layout_rect();
        for j in i + 1..operators.len() {
            let right = *operators.get(j).layout_rect();
            if (left.y() - right.y()).abs() > 0.001 {
                continue;
            }
            let (first, second) = if left.x() > right.x() { (right, left) } else { (left, right) };
            assert!(
                second.x() - second.width() / 2.0 >= first.x() + first.width() / 2.0 + margin - 0.001,
                "operators {i} and {j}"
            );
        }
    }
}

fn expect_bounds_contain_nodes(plan: &fb::PlanViewModel) {
    let bounds = plan.layout_rect().unwrap();
    for op in plan.operators().unwrap() {
        let rect = op.layout_rect();
        assert!(rect.x() - rect.width() / 2.0 >= bounds.x() - 0.001);
        assert!(rect.x() + rect.width() / 2.0 <= bounds.x() + bounds.width() + 0.001);
    }
}

/// The operator id serialized by Hyper, read from the attributes of an operator
fn source_operator_id(plan: &fb::PlanViewModel, operator_id: u32) -> u64 {
    let op = plan.operators().unwrap().get(operator_id as usize);
    for i in 0..op.attribute_count() {
        let attribute = plan.attributes().unwrap().get((op.attributes_begin() + i) as usize);
        let name = string(plan, attribute.name());
        if name == "operatorId" || name == "operator-id" {
            return string(plan, attribute.value_json()).parse().unwrap();
        }
    }
    0
}

#[test]
fn explicit_pipelines_and_properties() {
    let buffer = pack_plan(
        r#"{
        "operator":"executiontarget","operatorId":1,"cardinality":5,
        "input":{"operator":"tablescan","operatorId":2,"metadata":{"cost":1}},
        "pipelines":[{"pipelineId":10,"operators":[2,1]}]
    }"#,
    );
    let plan = root(&buffer);
    assert_eq!(plan.operators().unwrap().len(), 2);
    assert_eq!(plan.pipelines().unwrap().len(), 1);
    assert_eq!(plan.pipelines().unwrap().get(0).operator_count(), 2);
    assert_eq!(plan.pipeline_operators().unwrap().get(0), 0);
    assert_eq!(plan.pipeline_operators().unwrap().get(1), 1);
    assert_eq!(plan.pipelines().unwrap().get(0).edge_count(), 1);
    assert_eq!(plan.pipeline_edges().unwrap().get(0).child_operator(), 0);
    assert_eq!(plan.pipeline_edges().unwrap().get(0).parent_operator(), 1);
    assert!(plan.operators().unwrap().get(0).attribute_count() > 0);
}

#[test]
fn resolves_operator_cross_edges() {
    let buffer = pack_plan(
        r#"{
        "operator":"executiontarget","operatorId":1,
        "input":{"operator":"unionall","operatorId":2,"input":[
            {"operator":"explicitscan","operatorId":3,
             "input":{"operator":"groupby","operatorId":4,"input":{"operator":"tablescan","operatorId":5}}},
            {"operator":"explicitscan","operatorId":6,"input":4},
            {"operator":"leftouterjoin","operatorId":7,"magic":4,
             "left":{"operator":"tablescan","operatorId":8,"earlyProbes":[
                 {"builder":7,"attributes":[0],"type":"lookup"},
                 {"builder":4,"attributes":[1],"type":"minmaxonly"}
             ]},
             "right":{"operator":"earlyprobe","operatorId":9,"builder":7}},
            {"operator":"iteration","operator-id":10,
             "input":{"operator":"iterationincrement","operator-id":11,"source":10}}
        ]}
    }"#,
    );
    let plan = root(&buffer);

    let cross_edges = plan.operator_cross_edges().unwrap();
    assert_eq!(cross_edges.len(), 6);
    let attributes = plan.attributes().unwrap();

    let mut kinds = Vec::new();
    let mut edges_by_kind = std::collections::HashMap::new();
    for edge in cross_edges {
        assert!((edge.source_node() as usize) < plan.operators().unwrap().len());
        assert!((edge.target_node() as usize) < plan.operators().unwrap().len());
        assert!(edge.attribute_count() >= 1);
        let attribute = attributes.get(edge.attributes_begin() as usize);
        assert_eq!(string(&plan, attribute.name()), "kind");
        let kind = string(&plan, attribute.value_json());
        kinds.push(kind);
        edges_by_kind.entry(kind).or_insert(edge);
    }
    let count = |kind: &str| kinds.iter().filter(|k| **k == kind).count();
    assert_eq!(count(r#""input""#), 1);
    assert_eq!(count(r#""magic""#), 1);
    assert_eq!(count(r#""early-probe""#), 2);
    assert_eq!(count(r#""builder""#), 1);
    assert_eq!(count(r#""source""#), 1);
    assert_eq!(source_operator_id(&plan, edges_by_kind[r#""input""#].source_node()), 4);
    assert_eq!(source_operator_id(&plan, edges_by_kind[r#""input""#].target_node()), 6);
    assert_eq!(source_operator_id(&plan, edges_by_kind[r#""source""#].source_node()), 10);
    assert_eq!(source_operator_id(&plan, edges_by_kind[r#""source""#].target_node()), 11);

    for op in plan.operators().unwrap() {
        for i in 0..op.cross_edge_count() {
            assert_eq!(cross_edges.get((op.cross_edges_begin() + i) as usize).source_node(), op.operator_id());
        }
    }
    assert_eq!(plan.operator_edges().unwrap().len(), plan.operators().unwrap().len() - 1);
    assert_eq!(plan.root_operators().unwrap().len(), 1);
}

#[test]
fn resolves_hyphenated_explicit_scan_input_cross_edge() {
    let buffer = pack_plan(
        r#"{
        "operator":"result-sink","operator-id":1,"inputs":[
            {"operator":"explicit-scan","operator-id":4,
             "input":{"operator":"share","operator-id":5,
                      "inputs":[{"operator":"scan","operator-id":6}]}},
            {"operator":"explicit-scan","operator-id":8,"input":5}
        ]
    }"#,
    );
    let plan = root(&buffer);
    let cross_edges = plan.operator_cross_edges().unwrap();
    assert_eq!(cross_edges.len(), 1);
    let edge = cross_edges.get(0);
    assert_eq!(source_operator_id(&plan, edge.source_node()), 5);
    assert_eq!(source_operator_id(&plan, edge.target_node()), 8);
}

#[test]
fn ignores_unknown_and_unrelated_numeric_properties() {
    let buffer = pack_plan(
        r#"{
        "operator":"executiontarget","operatorId":1,"cardinality":42,
        "input":{"operator":"explicitscan","operatorId":2,"input":999,"relationId":1}
    }"#,
    );
    let plan = root(&buffer);
    assert_eq!(plan.operator_cross_edges().unwrap().len(), 0);
}

#[test]
fn execution_target_creates_root_fragment_but_does_not_infer_pipelines() {
    let buffer = pack_plan(
        r#"{
        "operator":"executiontarget","operatorId":1,
        "input":{"operator":"tablescan","operatorId":2}
    }"#,
    );
    let plan = root(&buffer);
    assert_eq!(plan.operators().unwrap().len(), 2);
    assert_eq!(plan.fragments().unwrap().len(), 1);
    let fragment = plan.fragments().unwrap().get(0);
    assert_eq!(fragment.anchor_operator(), 1);
    assert_eq!(fragment.operator_count(), 2);
    let fragment_operators = plan.fragment_operators().unwrap();
    assert_eq!(fragment_operators.get(fragment.operators_begin() as usize), 1);
    assert_eq!(fragment_operators.get(fragment.operators_begin() as usize + 1), 0);
    assert_eq!(plan.pipelines().unwrap().len(), 0);
}

/// The operators of a fragment
fn fragment_operators(plan: &fb::PlanViewModel, fragment: &fb::PlanFragment) -> Vec<u32> {
    let operators = plan.fragment_operators().unwrap();
    (0..fragment.operator_count()).map(|i| operators.get((fragment.operators_begin() + i) as usize)).collect()
}

#[test]
fn federate_creates_fragment_from_reachable_children() {
    let buffer = pack_plan(
        r#"{
        "operator":"output",
        "inputs":[{
            "inputs":[{
                "operator":"join",
                "left":{"operator":"scan"},
                "right":{"operator":"scan"}
            }],
            "operator":"federate"
        }]
    }"#,
    );
    let plan = root(&buffer);
    assert_eq!(plan.fragments().unwrap().len(), 1);
    let fragment = plan.fragments().unwrap().get(0);
    assert_eq!(fragment.fragment_id(), 0);
    assert_eq!(fragment.anchor_operator(), 3);
    assert_eq!(fragment_operators(&plan, fragment), vec![3, 2, 0, 1]);
}

#[test]
fn execution_target_root_fragment_contains_federated_fragments() {
    let buffer = pack_plan(
        r#"{
        "operator":"executiontarget",
        "input":{"operator":"federate","inputs":[{"operator":"scan"}]}
    }"#,
    );
    let plan = root(&buffer);
    assert_eq!(plan.fragments().unwrap().len(), 2);
    let root_fragment = plan.fragments().unwrap().get(0);
    assert_eq!(root_fragment.fragment_id(), 0);
    assert_eq!(root_fragment.anchor_operator(), 2);
    assert_eq!(fragment_operators(&plan, root_fragment), vec![2, 1, 0]);
    let federated = plan.fragments().unwrap().get(1);
    assert_eq!(federated.fragment_id(), 1);
    assert_eq!(federated.anchor_operator(), 1);
    assert_eq!(federated.operator_count(), 2);
}

#[test]
fn sibling_federates_create_distinct_fragments() {
    let buffer = pack_plan(
        r#"{
        "operator":"join",
        "left":{"operator":"federate","inputs":[{"operator":"scan"}]},
        "right":{"operator":"federate","inputs":[{"operator":"map","input":{"operator":"scan"}}]}
    }"#,
    );
    let plan = root(&buffer);
    assert_eq!(plan.fragments().unwrap().len(), 2);
    let left = plan.fragments().unwrap().get(0);
    assert_eq!(left.anchor_operator(), 3);
    assert_eq!(fragment_operators(&plan, left), vec![3, 0]);
    let right = plan.fragments().unwrap().get(1);
    assert_eq!(right.anchor_operator(), 4);
    assert_eq!(fragment_operators(&plan, right), vec![4, 2, 1]);
}

#[test]
fn nested_federates_have_overlapping_fragments() {
    let buffer = pack_plan(
        r#"{
        "operator":"federate",
        "inputs":[{
            "operator":"map",
            "input":{"operator":"federate","inputs":[{"operator":"scan"}]}
        }]
    }"#,
    );
    let plan = root(&buffer);
    assert_eq!(plan.fragments().unwrap().len(), 2);
    let outer = plan.fragments().unwrap().get(0);
    assert_eq!(outer.anchor_operator(), 3);
    assert_eq!(fragment_operators(&plan, outer), vec![3, 2, 1, 0]);
    let inner = plan.fragments().unwrap().get(1);
    assert_eq!(inner.anchor_operator(), 1);
    assert_eq!(fragment_operators(&plan, inner), vec![1, 0]);
}

#[test]
fn infers_scan_label_from_defined_attributes() {
    let buffer = pack_plan(
        r#"{
        "operator":"output",
        "operator-id":1,
        "inputs":[{
            "operator":"scan",
            "operator-id":2,
            "type":"parquet",
            "attributes":[
                {"defines":{"id":"partsupp.partkey","type":{"type":"bigint"}},"name":"ps_partkey"},
                {"defines":{"id":"partsupp.suppkey","type":{"type":"bigint"}},"name":"ps_suppkey"}
            ]
        }]
    }"#,
    );
    let plan = root(&buffer);
    assert_eq!(plan.operators().unwrap().len(), 2);
    let scan = plan.operators().unwrap().get(0);
    assert_ne!(scan.operator_label(), u32::MAX);
    assert_eq!(string(&plan, scan.operator_label()), "partsupp");
}

#[test]
fn reads_kebab_case_debug_name() {
    let buffer = pack_plan(
        r#"{
        "operator":"parquetscan",
        "operator-id":15,
        "attributes":[
            {"col-id":0,"name":"s_suppkey","iu":["supplier.suppkey",["BigInt","nullable"]]},
            {"col-id":3,"name":"s_nationkey","iu":["supplier.nationke",["Integer","nullable"]]}
        ],
        "debug-name":{"classification":"customer","value":"supplier"}
    }"#,
    );
    let plan = root(&buffer);
    assert_eq!(plan.operators().unwrap().len(), 1);
    let scan = plan.operators().unwrap().get(0);
    assert_ne!(scan.operator_label(), u32::MAX);
    assert_eq!(string(&plan, scan.operator_label()), "supplier");
}

#[test]
fn exposes_operator_statistics() {
    let buffer = pack_plan(
        r#"{
        "operator":"parquetscan",
        "operator-id":15,
        "estimated-rows":10000.5,
        "estimated-rows-in-table":12000.25,
        "statistics":{
            "pipeline":8,
            "column-count":2,
            "memory-bytes":4294967297,
            "output-rows":1987,
            "processed-rows":10000,
            "rows-matching-restrictions":1987,
            "running":false
        }
    }"#,
    );
    let plan = root(&buffer);
    assert_eq!(plan.operators().unwrap().len(), 1);
    let op = plan.operators().unwrap().get(0);
    let statistics = op.execution_statistics();
    assert_eq!(statistics.input_cardinality_estimated(), 12000.25);
    assert_eq!(statistics.input_cardinality_consumed(), 10000);
    assert_eq!(statistics.output_cardinality_estimated(), 10000.5);
    assert_eq!(statistics.output_cardinality_produced(), 1987);
    assert_eq!(statistics.memory_bytes(), 4294967297);

    let mut found_raw_statistics = false;
    for i in 0..op.attribute_count() {
        let attribute = plan.attributes().unwrap().get((op.attributes_begin() + i) as usize);
        found_raw_statistics |= string(&plan, attribute.name()) == "statistics";
    }
    assert!(found_raw_statistics);
}

#[test]
fn reads_nested_estimated_statistics() {
    let buffer = pack_plan(
        r#"{
        "operator":"scan",
        "statistics":{"estimated-rows":4.8375,"estimated-rows-in-table":25}
    }"#,
    );
    let plan = root(&buffer);
    let statistics = plan.operators().unwrap().get(0).execution_statistics();
    assert_eq!(statistics.input_cardinality_estimated(), 25.0);
    assert_eq!(statistics.output_cardinality_estimated(), 4.8375);
}

#[test]
fn reads_camel_case_memory_bytes() {
    let buffer = pack_plan(
        r#"{
        "operator":"scan",
        "statistics":{"memoryBytes":2048}
    }"#,
    );
    let plan = root(&buffer);
    assert_eq!(plan.operators().unwrap().get(0).execution_statistics().memory_bytes(), 2048);
}

#[test]
fn reads_standard_json_only() {
    use dashql_buffers::status::StatusCode;
    for plan in
        ["", "{\"operator\":\"scan\",}", "/* c */ {\"operator\":\"scan\"}", "{\"operator\":\"scan\"}\0", "[NaN]"]
    {
        let mut model = PlanViewModel::new();
        assert_eq!(
            model.parse_hyper_plan(plan.as_bytes()),
            Err(StatusCode::VIEWMODEL_INPUT_JSON_PARSER_ERROR),
            "{plan:?}"
        );
    }
}

#[test]
fn serializes_attributes_and_ignores_counts_that_are_not_unsigned() {
    let buffer = pack_plan(
        r#"{
        "operator":"scan",
        "values":[1, -0.0, 1.5e3, "a\u0000\"b\/"],
        "sqlpos":[[-1, 4294967296]],
        "statistics":{"processed-rows":-1,"output-rows":2.5,"memory-bytes":7}
    }"#,
    );
    let plan = root(&buffer);
    let op = plan.operators().unwrap().get(0);
    let attribute = |name: &str| {
        (op.attributes_begin()..op.attributes_begin() + op.attribute_count())
            .map(|i| plan.attributes().unwrap().get(i as usize))
            .find(|a| string(&plan, a.name()) == name)
            .map(|a| string(&plan, a.value_json()))
    };
    assert_eq!(attribute("operator"), Some(r#""scan""#));
    assert_eq!(attribute("values"), Some(r#"[1,-0.0,1500.0,"a\u0000\"b/"]"#));
    assert_eq!(op.source_location().offset(), 0);
    assert_eq!(op.source_location().length(), 0);
    let statistics = op.execution_statistics();
    assert_eq!(statistics.input_cardinality_consumed(), 0);
    assert_eq!(statistics.output_cardinality_produced(), 0);
    assert_eq!(statistics.memory_bytes(), 7);
}

#[test]
fn variable_width_nodes_do_not_overlap() {
    let margin = 0.25;
    let config = make_layout_config(margin);
    let buffer = pack_plan_with(
        r#"{
        "operator":"unionall",
        "input":[
            {"operator":"map","input":{"operator":"map","input":{"operator":"tablescan","debugName":{"value":"a_very_long_table"}}}},
            {"operator":"map","input":{"operator":"tablescan","debugName":{"value":"x"}}},
            {"operator":"tablescan","debugName":{"value":"medium_table"}}
        ]
    }"#,
        &config,
    );
    let plan = root(&buffer);
    expect_same_level_nodes_do_not_overlap(&plan, margin);
    expect_bounds_contain_nodes(&plan);
}

#[test]
fn unary_child_remains_centered_across_uneven_sibling_contours() {
    let buffer = pack_plan(
        r#"{
        "operator":"result-sink","operator-id":1,"inputs":[
            {"operator":"map","input":
                {"operator":"explicit-scan","operator-id":4,"input":
                    {"operator":"share","operator-id":5,"inputs":[
                        {"operator":"scan","operator-id":6}
                    ]}
                }
            },
            {"operator":"map","input":
                {"operator":"explicit-scan","operator-id":8,"input":5}
            }
        ]
    }"#,
    );
    let plan = root(&buffer);
    let mut explicit_scan = None;
    let mut share = None;
    for op in plan.operators().unwrap() {
        for i in 0..op.attribute_count() {
            let attribute = plan.attributes().unwrap().get((op.attributes_begin() + i) as usize);
            if string(&plan, attribute.name()) != "operator-id" {
                continue;
            }
            match string(&plan, attribute.value_json()).parse::<u64>().unwrap() {
                4 => explicit_scan = Some(op),
                5 => share = Some(op),
                _ => {}
            }
        }
    }
    let (explicit_scan, share) = (explicit_scan.unwrap(), share.unwrap());
    assert!((explicit_scan.layout_rect().x() - share.layout_rect().x()).abs() <= 0.001);
}

#[test]
fn independent_roots_are_packed_without_overlap() {
    let margin = 0.5;
    let config = make_layout_config(margin);
    let buffer = pack_plan_with(
        r#"[
        {"operator":"tablescan","debugName":{"value":"first_table"}},
        {"operator":"tablescan","debugName":{"value":"second_table_is_wider"}}
    ]"#,
        &config,
    );
    let plan = root(&buffer);
    assert_eq!(plan.root_operators().unwrap().len(), 2);
    expect_same_level_nodes_do_not_overlap(&plan, margin);
    expect_bounds_contain_nodes(&plan);
}

fn tpch_config() -> fb::PlanLayoutConfig {
    let mut config = fb::PlanLayoutConfig::default();
    config.set_level_height(20.0);
    config.set_node_height(8.0);
    config.set_node_padding_left(2.0);
    config.set_node_padding_right(2.0);
    config.set_max_label_chars(20);
    config.set_width_per_label_char(2.0);
    config.set_node_min_width(8.0);
    config
}

#[test]
fn tpch_q18() {
    let mut model = PlanViewModel::new();
    model.configure(&tpch_config());
    model.parse_hyper_plan(super::tests_tpch::TPCH_Q18.as_bytes()).expect("plan must parse");
    model.compute_layout();
}

#[test]
fn tpch_q22() {
    let mut model = PlanViewModel::new();
    model.configure(&tpch_config());
    model.parse_hyper_plan(super::tests_tpch::TPCH_Q22.as_bytes()).expect("plan must parse");
    model.compute_layout();
}
