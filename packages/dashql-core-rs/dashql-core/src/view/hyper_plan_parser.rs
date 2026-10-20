//! Reading Hyper plans into the view model (`hyper_plan_parser.cc`).

use super::plan_view_model::{
    Fragment, OperatorCrossEdge, OperatorEdge, OperatorReference, ParsedOperatorNode, PathComponent, PlanViewModel,
};
use dashql_buffers::parser::SymbolSpan;
use dashql_buffers::status::StatusCode;
use dashql_buffers::view as fb;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

/// A JSON node on the DFS stack.
///
/// The logic is the following:
/// - We do a post-order DFS traversal
/// - Whenever we find an operator, we re-construct the path toward the lowest operator ancestor
struct ParserDfsNode<'a> {
    /// The json value
    json_value: &'a Value,
    /// The DFS visited marker for the post-order traversal
    visited: bool,
    /// The parent index in the DFS
    parent_node_index: Option<usize>,
    /// The reference in the parent
    parent_path: PathComponent,
    /// The operator type (if any)
    operator_type: Option<String>,
    /// The operator label (if any)
    operator_label: Option<String>,
    /// The operator id serialized by Hyper (if any)
    source_operator_id: Option<u64>,
    /// The already emitted children
    child_operators: Vec<usize>,
    /// The source location
    source_location: Option<SymbolSpan>,
}

impl<'a> ParserDfsNode<'a> {
    fn new(json_value: &'a Value, parent_node_index: Option<usize>, parent_path: PathComponent) -> Self {
        Self {
            json_value,
            visited: false,
            parent_node_index,
            parent_path,
            operator_type: None,
            operator_label: None,
            source_operator_id: None,
            child_operators: Vec::new(),
            source_location: None,
        }
    }
}

/// Find the lowest operator ancestor of a DFS node and the path towards it
fn find_ancestor(nodes: &[ParserDfsNode], mut next: usize) -> (Option<usize>, Vec<PathComponent>) {
    let mut path = Vec::new();

    // Check the current node
    let node = &nodes[next];
    match node.parent_node_index {
        Some(parent) => {
            path.push(node.parent_path.clone());
            next = parent;
        }
        None => return (None, Vec::new()),
    }

    // Walk upwards until we hit the root or an operator
    loop {
        let node = &nodes[next];
        if node.operator_type.is_some() {
            path.reverse();
            return (Some(next), path);
        }
        match node.parent_node_index {
            None => {
                path.reverse();
                return (None, path);
            }
            Some(parent) => {
                path.push(node.parent_path.clone());
                next = parent;
            }
        }
    }
}

/// Infer the label of a scan from the relation of the attributes it defines
fn infer_scan_label(object: &Map<String, Value>) -> Option<String> {
    let attributes = object.get("attributes")?.as_array()?;
    let mut relation: Option<&str> = None;
    for attribute in attributes {
        let Some(qualified_id) = attribute.get("defines").and_then(|d| d.get("id")).and_then(Value::as_str) else {
            continue;
        };
        let candidate = match qualified_id.rsplit_once('.') {
            Some((candidate, _)) if !candidate.is_empty() => candidate,
            _ => continue,
        };
        if relation.is_some_and(|relation| relation != candidate) {
            return None;
        }
        relation = Some(candidate);
    }
    relation.map(String::from)
}

/// Read the source location of an operator from its `sqlpos` (`[[begin, end], ...]`)
fn read_source_location(sql_pos: &[Value]) -> Option<SymbolSpan> {
    let [begin, end] = sql_pos.first()?.as_array()?.as_slice() else {
        return None;
    };
    let read = |v: &Value| v.as_u64().and_then(|n| u32::try_from(n).ok()).unwrap_or(0);
    let (begin, end) = (read(begin), read(end));
    Some(SymbolSpan::new(begin, end.max(begin) - begin))
}

/// Is the operator type one of the join operators that may reference a magic set?
fn is_join_operator(operator_type: &str) -> bool {
    matches!(
        operator_type,
        "join"
            | "leftouterjoin"
            | "rightouterjoin"
            | "fullouterjoin"
            | "leftantijoin"
            | "rightantijoin"
            | "leftsemijoin"
            | "rightsemijoin"
            | "leftsinglejoin"
            | "rightsinglejoin"
            | "leftmarkjoin"
            | "rightmarkjoin"
    )
}

/// Serialize an attribute value as compact JSON
fn to_json(value: &Value) -> String {
    serde_json::to_string(value).expect("a JSON value always serializes")
}

/// Does a JSON value contain an operator?
fn contains_operator(value: &Value) -> bool {
    match value {
        Value::Object(members) => {
            members.get("operator").is_some_and(Value::is_string) || members.values().any(contains_operator)
        }
        Value::Array(elements) => elements.iter().any(contains_operator),
        _ => false,
    }
}

/// The first of several members that exists
fn find_member<'a>(object: &'a Map<String, Value>, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|name| object.get(*name))
}

/// The first of several members that exists, if it is a number
fn find_number<'a>(object: &'a Map<String, Value>, names: &[&str]) -> Option<&'a serde_json::Number> {
    find_member(object, names).and_then(|member| member.as_number())
}

/// Read the execution statistics of an operator
fn read_execution_statistics(source: &Map<String, Value>) -> fb::PlanExecutionStatistics {
    let mut out = fb::PlanExecutionStatistics::default();
    let runtime = source.get("statistics").and_then(Value::as_object).unwrap_or(source);

    const ROWS_IN_TABLE: &[&str] = &["estimated-rows-in-table", "estimatedRowsInTable"];
    let input_estimated = find_number(source, ROWS_IN_TABLE).or_else(|| find_number(runtime, ROWS_IN_TABLE));
    if let Some(n) = input_estimated.and_then(|n| n.as_f64()) {
        out.set_input_cardinality_estimated(n);
    }

    const ROWS: &[&str] = &["estimated-rows", "estimatedRows", "cardinality"];
    let output_estimated = find_number(source, ROWS).or_else(|| find_number(runtime, ROWS));
    if let Some(n) = output_estimated.and_then(|n| n.as_f64()) {
        out.set_output_cardinality_estimated(n);
    }

    let count = |names: &[&str]| find_number(runtime, names).and_then(|n| n.as_u64());
    if let Some(n) = count(&["processed-rows", "processedRows"]) {
        out.set_input_cardinality_consumed(n);
    }
    if let Some(n) = count(&["output-rows", "outputRows"]) {
        out.set_output_cardinality_produced(n);
    }
    if let Some(n) = count(&["memory-bytes", "memoryBytes"]) {
        out.set_memory_bytes(n);
    }
    out
}

/// The references of an operator to other operators by their Hyper operator ids
fn read_operator_references(operator_type: &str, object: &Map<String, Value>) -> Vec<OperatorReference> {
    let mut references = Vec::new();
    let mut reference = |name: &str, kind: &'static str| {
        if let Some(source_operator_id) = object.get(name).and_then(Value::as_u64) {
            references.push(OperatorReference { source_operator_id, kind, attributes: Vec::new() });
        }
    };
    match operator_type {
        "explicitscan" | "explicit-scan" => reference("input", "input"),
        "iterationincrement" => reference("source", "source"),
        "earlyprobe" => reference("builder", "builder"),
        t if is_join_operator(t) => reference("magic", "magic"),
        _ => {}
    }

    let early_probes = object.get("earlyProbes").or_else(|| object.get("early-probes"));
    for probe in early_probes.and_then(Value::as_array).into_iter().flatten() {
        let Some(probe) = probe.as_object() else {
            continue;
        };
        if let Some(builder) = probe.get("builder").and_then(Value::as_u64) {
            let attributes = probe
                .iter()
                .filter(|(name, _)| *name != "builder" && *name != "kind")
                .map(|(name, value)| (name.clone(), to_json(value)))
                .collect();
            references.push(OperatorReference { source_operator_id: builder, kind: "early-probe", attributes });
        }
    }
    references
}

/// Read the operator from the DFS node of its JSON object
fn read_operator(node: ParserDfsNode, parent_child_path: Vec<PathComponent>) -> ParsedOperatorNode {
    let object = node.json_value.as_object().expect("operators are objects");
    let operator_type = node.operator_type.expect("operators have a type");
    // The attributes are the members that do not contain other operators
    let attributes = object
        .iter()
        .filter(|(_, value)| !contains_operator(value))
        .map(|(name, value)| (name.clone(), to_json(value)))
        .collect();
    ParsedOperatorNode {
        parent_child_path,
        references: read_operator_references(&operator_type, object),
        attributes,
        statistics: read_execution_statistics(object),
        operator_type: Some(operator_type),
        operator_label: node.operator_label,
        source_operator_id: node.source_operator_id,
        child_operators: node.child_operators,
        source_location: node.source_location,
    }
}

impl PlanViewModel {
    /// Parse a Hyper plan
    pub fn parse_hyper_plan(&mut self, plan: &[u8]) -> Result<(), StatusCode> {
        // Reset the current plan view model
        self.reset();

        // Parse the document
        let document: Value =
            serde_json::from_slice(plan).map_err(|_| StatusCode::VIEWMODEL_INPUT_JSON_PARSER_ERROR)?;

        // Run DFS over the json plan.
        // Perform a post-order DFS over all json nodes.
        // Emit operator nodes on our way up and resolve the lowest ancestor through the DFS stack.
        let mut parsed_operators: Vec<ParsedOperatorNode> = Vec::new();
        let mut root_operators: Vec<usize> = Vec::new();
        let mut pending = vec![ParserDfsNode::new(&document, None, PathComponent::None)];
        let mut child_edge_count = 0;
        while !pending.is_empty() {
            let current_index = pending.len() - 1;

            // Already visited?
            if pending[current_index].visited {
                // Is an operator?
                if pending[current_index].operator_type.is_some() {
                    // Build the ancestor path
                    let (ancestor, ancestor_path) = find_ancestor(&pending, current_index);
                    // Then emit the node
                    let current = pending.pop().unwrap();
                    let op = parsed_operators.len();
                    child_edge_count += current.child_operators.len();
                    parsed_operators.push(read_operator(current, ancestor_path));
                    match ancestor {
                        // Register as child operator in ancestor
                        Some(ancestor) => pending[ancestor].child_operators.push(op),
                        // No parent operator, register as root
                        None => root_operators.push(op),
                    }
                } else {
                    // Otherwise do nothing, the attributes are read when emitting the operator
                    pending.pop();
                }
                continue;
            }
            // Mark as visited
            pending[current_index].visited = true;

            match pending[current_index].json_value {
                // Current node is an object:
                // - Add children for DFS
                // - Check if it is an operator
                Value::Object(members) => {
                    let pending_begin = pending.len();
                    for (attribute_name, value) in members {
                        let current = &mut pending[current_index];
                        match (attribute_name.as_str(), value) {
                            // Is the current node an operator?
                            // Mark as such and skip attribute during DFS
                            ("operator", Value::String(operator_type)) => {
                                current.operator_type = Some(operator_type.clone());
                            }
                            // Contains an operator id?
                            ("operatorId" | "operator-id", _) if value.is_u64() => {
                                current.source_operator_id = value.as_u64();
                            }
                            // Contains a debug name? Hyper plans use both camelCase and kebab-case spellings.
                            ("debugName" | "debug-name", Value::Object(debug_name)) => {
                                if let Some(label) = debug_name.get("value").and_then(Value::as_str) {
                                    current.operator_label = Some(label.to_string());
                                }
                            }
                            // Contains a sqlpos?
                            ("sqlpos", Value::Array(sql_pos)) => {
                                if let Some(location) = read_source_location(sql_pos) {
                                    current.source_location = Some(location);
                                }
                            }
                            // Mark pending for DFS traversal
                            _ => pending.push(ParserDfsNode::new(
                                value,
                                Some(current_index),
                                PathComponent::MemberInObject { attribute: attribute_name.clone() },
                            )),
                        }
                    }
                    let current = &mut pending[current_index];
                    if current.operator_label.is_none() && current.operator_type.as_deref() == Some("scan") {
                        current.operator_label = infer_scan_label(members);
                    }
                    // Reverse the order of the attribute nodes on the stack
                    pending[pending_begin..].reverse();
                }
                // Current node is an array:
                // - Add children for DFS
                Value::Array(values) => {
                    for (j, child_value) in values.iter().enumerate().rev() {
                        pending.push(ParserDfsNode::new(
                            child_value,
                            Some(current_index),
                            PathComponent::EntryInArray { index: j },
                        ));
                    }
                }
                // Skip value nodes during DFS traversal
                Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
            }
        }

        // Flatten the Hyper operators
        self.flatten_operators(parsed_operators, root_operators);
        // Resolve non-containment references between flattened operators
        self.identify_operator_cross_edges();
        // Identify fragments introduced by federates
        self.identify_fragments();
        // Identify the operator edges
        self.identify_operator_edges(child_edge_count);
        // Read pipelines if this plan format provides them. Legacy plans render without pipeline overlays.
        if let Some(pipelines) = document.get("pipelines").and_then(Value::as_array) {
            self.parse_hyper_pipelines(pipelines);
        }
        Ok(())
    }

    /// Map the operator ids serialized by Hyper to operators, the first operator wins
    fn source_operator_ids(&self) -> HashMap<u64, u32> {
        let mut operator_ids = HashMap::new();
        for op in &self.operators {
            if let Some(source_operator_id) = op.source_operator_id {
                operator_ids.entry(source_operator_id).or_insert(op.operator_id);
            }
        }
        operator_ids
    }

    /// Resolve non-containment operator references
    fn identify_operator_cross_edges(&mut self) {
        let operator_ids = self.source_operator_ids();

        let mut pending: Vec<(u32, u32, &'static str, Vec<(String, String)>)> = Vec::new();
        for op in &mut self.operators {
            for reference in std::mem::take(&mut op.references) {
                if let Some(&source) = operator_ids.get(&reference.source_operator_id) {
                    pending.push((source, op.operator_id, reference.kind, reference.attributes));
                }
            }
        }

        pending.sort_by_key(|(source_node, ..)| *source_node);
        self.operator_cross_edges.reserve(pending.len());
        for (source_node, target_node, kind, attributes) in pending {
            let source = &mut self.operators[source_node as usize];
            if source.cross_edge_count == 0 {
                source.cross_edges_begin = self.operator_cross_edges.len();
            }
            source.cross_edge_count += 1;
            self.operator_cross_edges.push(OperatorCrossEdge {
                edge_id: self.operator_cross_edges.len() as u32,
                source_node,
                target_node,
                kind,
                attributes,
            });
        }
    }

    /// Identify fragments introduced by federate operators
    fn identify_fragments(&mut self) {
        let operators = &self.operators;
        let mut boundaries: Vec<u32> = Vec::new();
        let mut root_boundaries: Vec<u32> = Vec::new();
        let mut pending: Vec<u32> = Vec::with_capacity(operators.len());
        for &root in self.root_operators.iter().rev() {
            if operators[root as usize].operator_type.as_deref() == Some("executiontarget") {
                root_boundaries.push(root);
            }
            pending.push(root);
        }
        let push_children = |pending: &mut Vec<u32>, operator_id: u32| {
            let op = &operators[operator_id as usize];
            pending.extend((op.children_begin..op.children_begin + op.children_count).rev().map(|c| c as u32));
        };
        while let Some(operator_id) = pending.pop() {
            if operators[operator_id as usize].operator_type.as_deref() == Some("federate") {
                boundaries.push(operator_id);
            }
            push_children(&mut pending, operator_id);
        }
        boundaries.splice(0..0, root_boundaries);

        for boundary_id in boundaries {
            let mut fragment = Fragment {
                fragment_id: self.fragments.len() as u32,
                anchor_operator: boundary_id,
                operators: vec![boundary_id],
            };
            pending.clear();
            push_children(&mut pending, boundary_id);
            while let Some(operator_id) = pending.pop() {
                fragment.operators.push(operator_id);
                push_children(&mut pending, operator_id);
            }
            self.fragments.push(fragment);
        }
    }

    /// Identify the operator edges
    fn identify_operator_edges(&mut self, child_edge_count: usize) {
        let mut child_edges = Vec::with_capacity(child_edge_count);
        for parent in &self.operators {
            let child_count = parent.children_count;
            for child_id in 0..parent.children_count {
                let child = &self.operators[parent.children_begin + child_id];
                child_edges.push(OperatorEdge {
                    edge_id: child_edges.len() as u32,
                    pipeline: None,
                    parent_operator: parent.operator_id,
                    child_operator: child.operator_id,
                    parent_port_count: child_count,
                    parent_port_index: child_id,
                });
            }
        }
        self.operator_edges = child_edges;
    }

    /// Read explicit Hyper pipelines
    fn parse_hyper_pipelines(&mut self, source_pipelines: &[Value]) {
        let operator_ids = self.source_operator_ids();

        let mut next_edge_id: u64 = 0;
        for source_pipeline in source_pipelines {
            let Some(source_pipeline) = source_pipeline.as_object() else {
                continue;
            };
            let source_pipeline_id = source_pipeline.get("pipelineId").and_then(Value::as_u64);
            let members = source_pipeline.get("operators").and_then(Value::as_array);
            let pipeline = self.register_pipeline(source_pipeline_id);
            let Some(members) = members else {
                continue;
            };
            pipeline.operators =
                members.iter().filter_map(|member| operator_ids.get(&member.as_u64()?).copied()).collect();
            let pipeline_id = pipeline.pipeline_id;

            let membership: HashSet<u32> = pipeline.operators.iter().copied().collect();
            let mut edges = Vec::new();
            for edge in &mut self.operator_edges {
                if !membership.contains(&edge.child_operator) || !membership.contains(&edge.parent_operator) {
                    continue;
                }
                edges.push(fb::PlanPipelineEdge::new(
                    next_edge_id,
                    pipeline_id,
                    edge.child_operator,
                    edge.parent_operator,
                    0,
                ));
                next_edge_id += 1;
                edge.pipeline = Some(pipeline_id);
            }
            self.pipelines.last_mut().unwrap().edges = edges;
        }
    }
}
