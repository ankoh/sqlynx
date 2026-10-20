//! Reading Hyper plans into the view model (`hyper_plan_parser.cc`).

use super::json::{c_str, Document, Value, ValueId};
use super::plan_view_model::{
    Fragment, OperatorCrossEdge, OperatorEdge, ParsedOperatorNode, PathComponent, PlanViewModel,
};
use dashql_buffers::parser::SymbolSpan;
use dashql_buffers::status::StatusCode;
use dashql_buffers::view as fb;
use std::collections::{HashMap, HashSet};

/// A JSON node on the DFS stack.
///
/// The logic is the following:
/// - We do a post-order DFS traversal
/// - Whenever we find an operator, we re-construct the path toward the lowest operator ancestor
struct ParserDfsNode {
    /// The json value
    json_value: ValueId,
    /// The DFS visited marker for the post-order traversal
    visited: bool,
    /// The parent index in the DFS
    parent_node_index: Option<usize>,
    /// The reference in the parent
    parent_path: PathComponent,
    /// The operator type (if any)
    operator_type: Option<Box<[u8]>>,
    /// The operator label (if any)
    operator_label: Option<Box<[u8]>>,
    /// The operator id serialized by Hyper (if any)
    source_operator_id: Option<u64>,
    /// The already emitted children
    child_operators: Vec<usize>,
    /// The source location
    source_location: Option<SymbolSpan>,
}

impl ParserDfsNode {
    fn new(json_value: ValueId, parent_node_index: Option<usize>, parent_path: PathComponent) -> Self {
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
fn infer_scan_label(doc: &Document, object: ValueId) -> Option<Box<[u8]>> {
    let attributes = doc.find_member(object, b"attributes")?;
    let Value::Array(attributes) = doc.get(attributes) else {
        return None;
    };

    let mut relation: Option<&[u8]> = None;
    for &attribute in attributes {
        let Some(defines) = doc.find_member(attribute, b"defines") else {
            continue;
        };
        let Some(id) = doc.find_member(defines, b"id") else {
            continue;
        };
        let Some(qualified_id) = doc.string(id) else {
            continue;
        };
        let separator = match qualified_id.iter().rposition(|c| *c == b'.') {
            None | Some(0) => continue,
            Some(separator) => separator,
        };
        let candidate = &qualified_id[..separator];
        if relation.is_some_and(|relation| relation != candidate) {
            return None;
        }
        relation = Some(candidate);
    }
    relation.map(Box::from)
}

/// Is the operator type one of the join operators that may reference a magic set?
fn is_join_operator(operator_type: &[u8]) -> bool {
    const JOIN_OPERATORS: &[&[u8]] = &[
        b"join",
        b"leftouterjoin",
        b"rightouterjoin",
        b"fullouterjoin",
        b"leftantijoin",
        b"rightantijoin",
        b"leftsemijoin",
        b"rightsemijoin",
        b"leftsinglejoin",
        b"rightsinglejoin",
        b"leftmarkjoin",
        b"rightmarkjoin",
    ];
    JOIN_OPERATORS.contains(&operator_type)
}

impl PlanViewModel {
    /// Parse a Hyper plan
    pub fn parse_hyper_plan(&mut self, plan: &[u8]) -> Result<(), StatusCode> {
        // Reset the current plan view model
        self.reset();

        // Parse the document
        let Some(document) = Document::parse(plan) else {
            return Err(StatusCode::VIEWMODEL_INPUT_JSON_PARSER_ERROR);
        };
        self.document = document;
        let doc = &self.document;

        // Run DFS over the json plan.
        // Perform a post-order DFS over all json nodes.
        // Emit operator nodes on our way up and resolve the lowest ancestor through the DFS stack.
        let mut parsed_operators: Vec<ParsedOperatorNode> = Vec::new();
        let mut root_operators: Vec<usize> = Vec::new();
        let mut pending = vec![ParserDfsNode::new(doc.root(), None, PathComponent::None)];
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
                    parsed_operators.push(ParsedOperatorNode {
                        parent_child_path: ancestor_path,
                        source_value: current.json_value,
                        operator_type: current.operator_type,
                        operator_label: current.operator_label,
                        source_operator_id: current.source_operator_id,
                        child_operators: current.child_operators,
                        source_location: current.source_location,
                    });
                    match ancestor {
                        // Register as child operator in ancestor
                        Some(ancestor) => pending[ancestor].child_operators.push(op),
                        // No parent operator, register as root
                        None => root_operators.push(op),
                    }
                } else {
                    // Otherwise do nothing, we're serializing the attributes later
                    pending.pop();
                }
                continue;
            }
            // Mark as visited
            pending[current_index].visited = true;

            let json_value = pending[current_index].json_value;
            match doc.get(json_value) {
                // Current node is an object:
                // - Add children for DFS
                // - Check if it is an operator
                Value::Object(members) => {
                    let pending_begin = pending.len();
                    for member in members {
                        // The C++ code reads attribute names as C strings
                        let attribute_name = c_str(&member.name);
                        let value = member.value;
                        let current = &mut pending[current_index];

                        // Is the current node an operator?
                        if attribute_name == b"operator" && doc.string(value).is_some() {
                            // Mark as such and skip attribute during DFS
                            current.operator_type = Some(c_str(doc.string(value).unwrap()).into());
                        }
                        // Contains an operator id?
                        else if (attribute_name == b"operatorId" || attribute_name == b"operator-id")
                            && doc.uint64(value).is_some()
                        {
                            current.source_operator_id = doc.uint64(value);
                        }
                        // Contains a debug name? Hyper plans use both camelCase and kebab-case spellings.
                        else if (attribute_name == b"debugName" || attribute_name == b"debug-name")
                            && doc.is_object(value)
                        {
                            if let Some(label) = doc.find_member(value, b"value").and_then(|v| doc.string(v)) {
                                current.operator_label = Some(c_str(label).into());
                            }
                        }
                        // Contains a sqlpos?
                        else if attribute_name == b"sqlpos" && doc.is_array(value) {
                            let Value::Array(sql_pos) = doc.get(value) else { unreachable!() };
                            if let Some(&first) = sql_pos.first() {
                                if let Value::Array(sql_pos_array) = doc.get(first) {
                                    if sql_pos_array.len() == 2 {
                                        let read = |v: ValueId| doc.number(v).map(|n| n.get_uint()).unwrap_or(0);
                                        let pos_begin = read(sql_pos_array[0]);
                                        let pos_end = read(sql_pos_array[1]);
                                        current.source_location =
                                            Some(SymbolSpan::new(pos_begin, pos_end.max(pos_begin) - pos_begin));
                                    }
                                }
                            }
                        } else {
                            // Mark pending for DFS traversal
                            pending.push(ParserDfsNode::new(
                                value,
                                Some(current_index),
                                PathComponent::MemberInObject { attribute: attribute_name.into() },
                            ));
                        }
                    }
                    let current = &mut pending[current_index];
                    if current.operator_label.is_none() && current.operator_type.as_deref() == Some(b"scan") {
                        current.operator_label = infer_scan_label(doc, json_value);
                    }
                    // Reverse the order of the attribute nodes on the stack
                    pending[pending_begin..].reverse();
                }
                // Current node is an array:
                // - Add children for DFS
                Value::Array(values) => {
                    for (j, child_value) in values.iter().enumerate().rev() {
                        pending.push(ParserDfsNode::new(
                            *child_value,
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
        self.parse_hyper_pipelines();
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
        let doc = &self.document;

        struct PendingCrossEdge {
            source_node: u32,
            target_node: u32,
            kind: &'static [u8],
            attributes: Vec<(Box<[u8]>, Vec<u8>)>,
        }
        let mut pending: Vec<PendingCrossEdge> = Vec::new();

        for op in &self.operators {
            let value = op.source_value;
            if !doc.is_object(value) {
                continue;
            }
            let mut append = |source_id: u64, kind: &'static [u8], attributes: Vec<(Box<[u8]>, Vec<u8>)>| {
                if let Some(source) = operator_ids.get(&source_id) {
                    let target_node = op.operator_id;
                    pending.push(PendingCrossEdge { source_node: *source, target_node, kind, attributes });
                }
            };
            let member_id = |name: &[u8]| doc.find_member(value, name).and_then(|m| doc.uint64(m));

            let operator_type = op.operator_type.as_deref();
            if operator_type == Some(b"explicitscan") || operator_type == Some(b"explicit-scan") {
                if let Some(id) = member_id(b"input") {
                    append(id, b"input", Vec::new());
                }
            }
            if operator_type == Some(b"iterationincrement") {
                if let Some(id) = member_id(b"source") {
                    append(id, b"source", Vec::new());
                }
            }
            if operator_type == Some(b"earlyprobe") {
                if let Some(id) = member_id(b"builder") {
                    append(id, b"builder", Vec::new());
                }
            }
            if operator_type.is_some_and(is_join_operator) {
                if let Some(id) = member_id(b"magic") {
                    append(id, b"magic", Vec::new());
                }
            }

            let early_probes =
                doc.find_member(value, b"earlyProbes").or_else(|| doc.find_member(value, b"early-probes"));
            let Some(Value::Array(early_probes)) = early_probes.map(|p| doc.get(p)) else {
                continue;
            };
            for &probe in early_probes {
                if !doc.is_object(probe) {
                    continue;
                }
                if let Some(builder) = doc.find_member(probe, b"builder").and_then(|b| doc.uint64(b)) {
                    let mut attributes = Vec::new();
                    for member in doc.members(probe) {
                        let name = c_str(&member.name);
                        if name != b"builder" && name != b"kind" {
                            attributes.push((Box::from(name), doc.serialize(member.value)));
                        }
                    }
                    append(builder, b"early-probe", attributes);
                }
            }
        }

        pending.sort_by_key(|edge| edge.source_node);
        self.operator_cross_edges.reserve(pending.len());
        for edge in pending {
            let source = &mut self.operators[edge.source_node as usize];
            if source.cross_edge_count == 0 {
                source.cross_edges_begin = self.operator_cross_edges.len();
            }
            source.cross_edge_count += 1;
            self.operator_cross_edges.push(OperatorCrossEdge {
                edge_id: self.operator_cross_edges.len() as u32,
                source_node: edge.source_node,
                target_node: edge.target_node,
                kind: edge.kind,
                attributes: edge.attributes,
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
            if operators[root as usize].operator_type.as_deref() == Some(b"executiontarget") {
                root_boundaries.push(root);
            }
            pending.push(root);
        }
        let push_children = |pending: &mut Vec<u32>, operator_id: u32| {
            let op = &operators[operator_id as usize];
            pending.extend((op.children_begin..op.children_begin + op.children_count).rev().map(|c| c as u32));
        };
        while let Some(operator_id) = pending.pop() {
            if operators[operator_id as usize].operator_type.as_deref() == Some(b"federate") {
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

    /// Read explicit Hyper pipelines. Plans without this field have no pipelines.
    fn parse_hyper_pipelines(&mut self) {
        let root = self.document.root();
        let Some(pipelines) = self.document.find_member(root, b"pipelines") else {
            return;
        };
        let Value::Array(source_pipelines) = self.document.get(pipelines).clone() else {
            return;
        };
        let operator_ids = self.source_operator_ids();

        let mut next_edge_id: u64 = 0;
        for source_pipeline in source_pipelines {
            if !self.document.is_object(source_pipeline) {
                continue;
            }
            let source_pipeline_id =
                self.document.find_member(source_pipeline, b"pipelineId").and_then(|id| self.document.uint64(id));
            let members = self.document.find_member(source_pipeline, b"operators");
            let mut operators = Vec::new();
            let has_members = match members.map(|m| self.document.get(m)) {
                Some(Value::Array(members)) => {
                    for &member in members {
                        if let Some(mapped) = self.document.uint64(member).and_then(|id| operator_ids.get(&id)) {
                            operators.push(*mapped);
                        }
                    }
                    true
                }
                _ => false,
            };
            let pipeline = self.register_pipeline(source_pipeline_id);
            if !has_members {
                continue;
            }
            pipeline.operators = operators;
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
