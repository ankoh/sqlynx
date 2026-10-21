//! The plan view model and its FlatBuffers encoding (`plan_view_model.cc`, `plan_view_model.h`).

use dashql_buffers::parser::SymbolSpan;
use dashql_buffers::view as fb;
use flatbuffers::{FlatBufferBuilder, WIPOffset};
use std::collections::HashMap;

/// A component of the path from an operator to the JSON value of its child operator
#[derive(Clone, Debug, PartialEq)]
pub(super) enum PathComponent {
    /// A member in an object (the C++ code keeps the index of the object on the DFS stack, but never reads it)
    MemberInObject { attribute: String },
    /// An entry in an array
    EntryInArray { index: usize },
    /// No path (the document root)
    None,
}

/// A reference of an operator to another operator through the operator id serialized by Hyper
#[derive(Debug)]
pub(super) struct OperatorReference {
    /// The operator id serialized by Hyper of the referenced operator
    pub(super) source_operator_id: u64,
    /// The relationship kind
    pub(super) kind: &'static str,
    /// Additional reference attributes, values serialized as JSON
    pub(super) attributes: Vec<(String, String)>,
}

/// An operator found in the JSON plan, before flattening (`ParsedOperatorNode`)
#[derive(Debug, Default)]
pub(super) struct ParsedOperatorNode {
    /// The path from the parent operator (or the document root)
    pub(super) parent_child_path: Vec<PathComponent>,
    /// The members of the operator object that contain no operators, values serialized as JSON
    pub(super) attributes: Vec<(String, String)>,
    /// The execution statistics
    pub(super) statistics: fb::PlanExecutionStatistics,
    /// The references to other operators
    pub(super) references: Vec<OperatorReference>,
    /// The operator type
    pub(super) operator_type: Option<String>,
    /// The operator label
    pub(super) operator_label: Option<String>,
    /// The operator id serialized by Hyper
    pub(super) source_operator_id: Option<u64>,
    /// The child operators (indexes of parsed operators)
    pub(super) child_operators: Vec<usize>,
    /// The source location
    pub(super) source_location: Option<SymbolSpan>,
}

/// A fragment
#[derive(Debug, Default)]
pub(super) struct Fragment {
    /// The fragment id
    pub(super) fragment_id: u32,
    /// The operator that introduces the fragment
    pub(super) anchor_operator: u32,
    /// The anchor and all operators reachable below it
    pub(super) operators: Vec<u32>,
}

/// A pipeline.
/// Note that a pipeline does not need to to be linear.
/// Hyper implements a Fork operator that will effectively result in two pipeline targets.
#[derive(Debug, Default)]
pub(super) struct Pipeline {
    /// The pipeline id
    pub(super) pipeline_id: u32,
    /// The id serialized by Hyper (not packed)
    #[allow(dead_code)]
    pub(super) source_pipeline_id: Option<u64>,
    /// The operators that belong to this pipeline
    pub(super) operators: Vec<u32>,
    /// The edges in the pipeline
    pub(super) edges: Vec<fb::PlanPipelineEdge>,
}

/// A non-containment relationship between operators
#[derive(Debug)]
pub(super) struct OperatorCrossEdge {
    /// The edge id
    pub(super) edge_id: u32,
    /// The referenced producer operator
    pub(super) source_node: u32,
    /// The operator containing the reference
    pub(super) target_node: u32,
    /// The relationship kind
    pub(super) kind: &'static str,
    /// Additional reference attributes, values serialized as JSON
    pub(super) attributes: Vec<(String, String)>,
}

/// An operator edge
#[derive(Debug)]
pub(super) struct OperatorEdge {
    /// The edge id
    pub(super) edge_id: u32,
    /// The pipeline (if assigned, not packed)
    #[allow(dead_code)]
    pub(super) pipeline: Option<u32>,
    /// The parent operator
    pub(super) parent_operator: u32,
    /// The child operator
    pub(super) child_operator: u32,
    /// The port count of the parent
    pub(super) parent_port_count: usize,
    /// The port id in the parent where this edge ends
    pub(super) parent_port_index: usize,
}

/// A sealed operator node
#[derive(Debug, Default)]
pub(super) struct OperatorNode {
    /// The operator id
    pub(super) operator_id: u32,
    /// The operator type
    pub(super) operator_type: Option<String>,
    /// The operator label
    pub(super) operator_label: Option<String>,
    /// The operator id serialized by Hyper
    pub(super) source_operator_id: Option<u64>,
    /// The members of the operator object that contain no operators, values serialized as JSON
    pub(super) attributes: Vec<(String, String)>,
    /// The execution statistics
    pub(super) statistics: fb::PlanExecutionStatistics,
    /// The references to other operators, until the cross edges are resolved
    pub(super) references: Vec<OperatorReference>,
    /// The parent operator id
    pub(super) parent_operator_id: Option<usize>,
    /// The parent path
    pub(super) parent_path: Vec<PathComponent>,
    /// The source location
    pub(super) source_location: Option<SymbolSpan>,
    /// The child operators
    pub(super) children_begin: usize,
    /// The number of child operators
    pub(super) children_count: usize,
    /// The begin of outgoing cross edges
    pub(super) cross_edges_begin: usize,
    /// The number of outgoing cross edges
    pub(super) cross_edge_count: usize,
    /// The layout info
    pub(super) layout_rect: Option<fb::PlanLayoutRect>,
}

impl OperatorNode {
    /// Construct from a parsed node
    pub(super) fn from_parsed(parsed: ParsedOperatorNode) -> Self {
        Self {
            operator_type: parsed.operator_type,
            operator_label: parsed.operator_label,
            source_operator_id: parsed.source_operator_id,
            attributes: parsed.attributes,
            statistics: parsed.statistics,
            references: parsed.references,
            parent_path: parsed.parent_child_path,
            source_location: parsed.source_location,
            ..Default::default()
        }
    }

    /// Serialize the parent child path
    pub(super) fn serialize_parent_path(&self) -> String {
        let mut out = String::new();
        for (i, component) in self.parent_path.iter().enumerate() {
            match component {
                PathComponent::MemberInObject { attribute } => {
                    if i > 0 {
                        out.push('.');
                    }
                    out.push_str(attribute);
                }
                PathComponent::EntryInArray { index } => {
                    out.push('[');
                    out.push_str(&index.to_string());
                    out.push(']');
                }
                PathComponent::None => {}
            }
        }
        out
    }
}

/// A string dictionary
#[derive(Default)]
struct StringDictionary {
    /// The allocated strings
    strings: Vec<String>,
    /// The string ids
    string_ids: HashMap<String, u32>,
}

impl StringDictionary {
    /// Allocate a string in the string dictionary
    fn allocate(&mut self, s: &str) -> u32 {
        if let Some(id) = self.string_ids.get(s) {
            return *id;
        }
        let id = self.strings.len() as u32;
        self.strings.push(s.to_string());
        self.string_ids.insert(s.to_string(), id);
        id
    }
}

/// The view model of a Hyper plan
pub struct PlanViewModel {
    /// The operators
    pub(super) operators: Vec<OperatorNode>,
    /// The operator edges
    pub(super) operator_edges: Vec<OperatorEdge>,
    /// The operator cross edges
    pub(super) operator_cross_edges: Vec<OperatorCrossEdge>,
    /// The root operators
    pub(super) root_operators: Vec<u32>,
    /// The pipelines
    pub(super) pipelines: Vec<Pipeline>,
    /// The fragments
    pub(super) fragments: Vec<Fragment>,
    /// The layout config
    pub(super) layout_config: fb::DerivedPlanLayoutConfig,
    /// The layout info of the entire plan
    pub(super) layout_rect: Option<fb::PlanLayoutRect>,
}

impl Default for PlanViewModel {
    fn default() -> Self {
        Self::new()
    }
}

impl PlanViewModel {
    /// Constructor
    pub fn new() -> Self {
        Self {
            operators: Vec::new(),
            operator_edges: Vec::new(),
            operator_cross_edges: Vec::new(),
            root_operators: Vec::new(),
            pipelines: Vec::new(),
            fragments: Vec::new(),
            layout_config: fb::DerivedPlanLayoutConfig::default(),
            layout_rect: None,
        }
    }

    /// Reset the entire view model. The layout config is kept.
    pub fn reset(&mut self) {
        self.pipelines.clear();
        self.fragments.clear();
        self.root_operators.clear();
        self.operators.clear();
        self.operator_edges.clear();
        self.operator_cross_edges.clear();
        self.layout_rect = None;
    }

    /// Reset the view model execution (not implemented in the C++ core either)
    pub fn reset_execution(&mut self) {}

    /// Register a pipeline
    pub(super) fn register_pipeline(&mut self, source_pipeline_id: Option<u64>) -> &mut Pipeline {
        let pipeline_id = self.pipelines.len() as u32;
        self.pipelines.push(Pipeline { pipeline_id, source_pipeline_id, ..Default::default() });
        self.pipelines.last_mut().unwrap()
    }

    /// Flatten the operators.
    ///
    /// Runs a post-order DFS over the parsed operator tree and writes the children of every operator as one block.
    pub(super) fn flatten_operators(&mut self, parsed_ops: Vec<ParsedOperatorNode>, parsed_roots: Vec<usize>) {
        let mut parsed_ops: Vec<Option<ParsedOperatorNode>> = parsed_ops.into_iter().map(Some).collect();
        let children_of: Vec<Vec<usize>> =
            parsed_ops.iter().map(|op| op.as_ref().unwrap().child_operators.clone()).collect();

        // Prepare the operators: (parsed operator, visited)
        let mut pending: Vec<(usize, bool)> = parsed_roots.iter().rev().map(|r| (*r, false)).collect();
        self.operators.reserve(parsed_ops.len());

        // The flattened operators that are not yet placed (`mapped` in C++)
        let mut mapped: Vec<Option<OperatorNode>> = (0..parsed_ops.len()).map(|_| None).collect();
        while let Some(&(op, visited)) = pending.last() {
            if visited {
                // Add child operators
                let children_begin = self.operators.len();
                for &child in &children_of[op] {
                    let node = mapped[child].take().expect("child operator must be flattened");
                    self.place_operator(node);
                }
                let child_count = self.operators.len() - children_begin;
                let mut flat = OperatorNode::from_parsed(parsed_ops[op].take().unwrap());
                flat.children_begin = children_begin;
                flat.children_count = child_count;

                // Register flat operator
                mapped[op] = Some(flat);
                pending.pop();
            } else {
                pending.last_mut().unwrap().1 = true;
                // Add the children, reversed since we're using a DFS stack
                pending.extend(children_of[op].iter().rev().map(|c| (*c, false)));
            }
        }

        // Now only the root operators are left.
        //
        // The C++ code places them in the iteration order of an `std::unordered_map` keyed by the address of the
        // parsed operator. When a root is inserted, the map only holds the earlier roots, and libstdc++ puts a new
        // node in front of the others unless its bucket collides with the bucket of a root that is not first. We
        // place the roots in reverse plan order, which is what the C++ code does for up to two roots and for more
        // roots without bucket collisions.
        self.root_operators.reserve(parsed_roots.len());
        for root in parsed_roots.into_iter().rev() {
            let node = mapped[root].take().expect("root operator must be flattened");
            let oid = self.place_operator(node);
            self.root_operators.push(oid as u32);
        }
    }

    /// Append a flattened operator and point its children at it
    fn place_operator(&mut self, mut node: OperatorNode) -> usize {
        let operator_id = self.operators.len();
        node.operator_id = operator_id as u32;
        let (children_begin, children_count) = (node.children_begin, node.children_count);
        self.operators.push(node);
        for child in &mut self.operators[children_begin..children_begin + children_count] {
            child.parent_operator_id = Some(operator_id);
        }
        operator_id
    }

    /// Pack a plan operator
    fn pack_operator(
        &self,
        op: &OperatorNode,
        strings: &mut StringDictionary,
        attributes: &mut Vec<fb::PlanAttribute>,
    ) -> fb::PlanOperator {
        let mut out = fb::PlanOperator::default();
        out.set_operator_id(op.operator_id);
        out.set_operator_type_name(op.operator_type.as_ref().map(|t| strings.allocate(t)).unwrap_or(u32::MAX));
        out.set_operator_label(op.operator_label.as_ref().map(|l| strings.allocate(l)).unwrap_or(u32::MAX));
        out.set_parent_operator_id(op.parent_operator_id.map(|p| p as u32).unwrap_or(u32::MAX));
        out.set_parent_path(strings.allocate(&op.serialize_parent_path()));
        if let Some(loc) = &op.source_location {
            out.set_source_location(&SymbolSpan::new(loc.offset(), loc.length()));
        }
        out.set_children_begin(op.children_begin as u32);
        out.set_children_count(op.children_count as u32);
        out.set_cross_edges_begin(op.cross_edges_begin as u32);
        out.set_cross_edge_count(op.cross_edge_count as u32);
        let attributes_begin = attributes.len();
        out.set_attributes_begin(attributes_begin as u32);
        for (name, value_json) in &op.attributes {
            let mut attribute = fb::PlanAttribute::default();
            attribute.set_attribute_id(attributes.len() as u32);
            attribute.set_name(strings.allocate(name));
            attribute.set_value_json(strings.allocate(value_json));
            attributes.push(attribute);
        }
        out.set_attribute_count((attributes.len() - attributes_begin) as u32);
        out.set_execution_statistics(&op.statistics);
        if let Some(rect) = &op.layout_rect {
            out.set_layout_rect(rect);
        }
        out
    }

    /// Pack the plan view model as flatbuffer
    pub fn pack<'a>(&self, builder: &mut FlatBufferBuilder<'a>) -> WIPOffset<fb::PlanViewModel<'a>> {
        // Track strings in a dictionary for flatbuffer
        let mut dictionary = StringDictionary::default();

        // Pack plan fragments
        let mut flat_fragments = Vec::with_capacity(self.fragments.len());
        let mut flat_fragment_operators: Vec<u32> = Vec::new();
        for f in &self.fragments {
            let operators_begin = flat_fragment_operators.len();
            flat_fragment_operators.extend_from_slice(&f.operators);
            let mut fragment = fb::PlanFragment::default();
            fragment.set_fragment_id(f.fragment_id);
            fragment.set_anchor_operator(f.anchor_operator);
            fragment.set_operators_begin(operators_begin as u32);
            fragment.set_operator_count((flat_fragment_operators.len() - operators_begin) as u32);
            flat_fragments.push(fragment);
        }

        // Pack plan pipelines
        let mut flat_pipelines = Vec::with_capacity(self.pipelines.len());
        let mut flat_pipeline_edges: Vec<fb::PlanPipelineEdge> = Vec::new();
        let mut flat_pipeline_operators: Vec<u32> = Vec::new();
        for p in &self.pipelines {
            let edges_begin = flat_pipeline_edges.len();
            flat_pipeline_edges.extend_from_slice(&p.edges);
            let operators_begin = flat_pipeline_operators.len();
            flat_pipeline_operators.extend_from_slice(&p.operators);
            let mut pipeline = fb::PlanPipeline::default();
            pipeline.set_pipeline_id(flat_pipelines.len() as u32);
            pipeline.set_edges_begin(edges_begin as u32);
            pipeline.set_edge_count((flat_pipeline_edges.len() - edges_begin) as u32);
            pipeline.set_operators_begin(operators_begin as u32);
            pipeline.set_operator_count((flat_pipeline_operators.len() - operators_begin) as u32);
            flat_pipelines.push(pipeline);
        }

        // Pack plan operators
        let mut flat_ops = Vec::with_capacity(self.operators.len());
        let mut flat_attributes: Vec<fb::PlanAttribute> = Vec::new();
        for op in &self.operators {
            flat_ops.push(self.pack_operator(op, &mut dictionary, &mut flat_attributes));
        }

        // Pack the plan edges
        let flat_op_edges: Vec<fb::PlanOperatorEdge> = self
            .operator_edges
            .iter()
            .map(|edge| {
                let mut out = fb::PlanOperatorEdge::default();
                out.set_edge_id(edge.edge_id as u64);
                out.set_parent_operator(edge.parent_operator);
                out.set_parent_operator_port_count(edge.parent_port_count as u32);
                out.set_parent_operator_port_index(edge.parent_port_index as u32);
                out.set_child_operator(edge.child_operator);
                out.set_pipeline_id(u32::MAX);
                out
            })
            .collect();

        // Pack the plan cross edges and their relationship metadata
        let mut flat_cross_edges = Vec::with_capacity(self.operator_cross_edges.len());
        for edge in &self.operator_cross_edges {
            let mut flat = fb::PlanOperatorCrossEdge::default();
            flat.set_edge_id(edge.edge_id as u64);
            flat.set_source_node(edge.source_node);
            flat.set_target_node(edge.target_node);
            flat.set_pipeline_id(u32::MAX);
            let attributes_begin = flat_attributes.len();
            flat.set_attributes_begin(attributes_begin as u32);

            let mut kind = fb::PlanAttribute::default();
            kind.set_attribute_id(flat_attributes.len() as u32);
            kind.set_name(dictionary.allocate("kind"));
            kind.set_value_json(dictionary.allocate(&format!("\"{}\"", edge.kind)));
            flat_attributes.push(kind);
            for (name, value_json) in &edge.attributes {
                let mut attribute = fb::PlanAttribute::default();
                attribute.set_attribute_id(flat_attributes.len() as u32);
                attribute.set_name(dictionary.allocate(name));
                attribute.set_value_json(dictionary.allocate(value_json));
                flat_attributes.push(attribute);
            }
            flat.set_attribute_count((flat_attributes.len() - attributes_begin) as u32);
            flat_cross_edges.push(flat);
        }

        let flat_fragments_ofs = builder.create_vector(&flat_fragments);
        let flat_fragment_operators_ofs = builder.create_vector(&flat_fragment_operators);
        let flat_pipelines_ofs = builder.create_vector(&flat_pipelines);
        let flat_pipeline_edges_ofs = builder.create_vector(&flat_pipeline_edges);
        let flat_pipeline_operators_ofs = builder.create_vector(&flat_pipeline_operators);
        let flat_ops_ofs = builder.create_vector(&flat_ops);
        let flat_attributes_ofs = builder.create_vector(&flat_attributes);
        let flat_edges_ofs = builder.create_vector(&flat_op_edges);
        let flat_cross_edges_ofs = builder.create_vector(&flat_cross_edges);
        let flat_roots_ofs = builder.create_vector(&self.root_operators);
        let string_offsets: Vec<WIPOffset<&str>> =
            dictionary.strings.iter().map(|s| builder.create_string(s)).collect();
        let string_dictionary_ofs = builder.create_vector(&string_offsets);

        fb::PlanViewModel::create(
            builder,
            &fb::PlanViewModelArgs {
                layout_config: Some(&self.layout_config),
                string_dictionary: Some(string_dictionary_ofs),
                fragments: Some(flat_fragments_ofs),
                fragment_operators: Some(flat_fragment_operators_ofs),
                pipelines: Some(flat_pipelines_ofs),
                pipeline_edges: Some(flat_pipeline_edges_ofs),
                pipeline_operators: Some(flat_pipeline_operators_ofs),
                operators: Some(flat_ops_ofs),
                attributes: Some(flat_attributes_ofs),
                operator_edges: Some(flat_edges_ofs),
                operator_cross_edges: Some(flat_cross_edges_ofs),
                root_operators: Some(flat_roots_ofs),
                layout_rect: self.layout_rect.as_ref(),
                operator_pipelines: None,
            },
        )
    }

    /// Pack the plan view model into a finished flatbuffer
    pub fn pack_buffer(&self) -> Vec<u8> {
        let mut builder = FlatBufferBuilder::new();
        let vm = self.pack(&mut builder);
        builder.finish(vm, None);
        builder.finished_data().to_vec()
    }
}
