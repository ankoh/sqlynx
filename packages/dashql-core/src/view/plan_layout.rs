//! The plan layout (`plan_layout.cc`).
//!
//! This layouting algorithm is based on two papers:
//! - A Node-Positioning Algorithm for General Trees:
//!   1990 by Walker
//!   https://www.cs.unc.edu/techreports/89-034.pdf
//!   This is the original tree layouting algorithm that many are using
//! - Improving Walker's Algorithm to Run in Linear Time
//!   2002 by Buchheim-Juenger-Leipert
//!   https://www.researchgate.net/publication/30508504_Improving_Walker%27s_Algorithm_to_Run_in_Linear_Time
//!   This is an updated version that fixes quadratic runtime in the original paper.
//!
//! The floating point operations are mirrored in the order of the C++ code, so positions are bit-identical.
//! `std::min` and `std::max` are not `f64::min` and `f64::max` (NaN, signed zeros), see `cpp_min` and `cpp_max`.

use super::plan_view_model::{OperatorNode, PlanViewModel};
use dashql_buffers::view as fb;

/// `std::min(a, b)`
fn cpp_min(a: f64, b: f64) -> f64 {
    if b < a {
        b
    } else {
        a
    }
}

/// `std::max(a, b)`
fn cpp_max(a: f64, b: f64) -> f64 {
    if a < b {
        b
    } else {
        a
    }
}

/// Compute the rendered width of an operator node
fn compute_node_width(op: &OperatorNode, layout_config: &fb::PlanLayoutConfig) -> f64 {
    let label = op.operator_label.as_deref().or(op.operator_type.as_deref()).unwrap_or("");
    let label_chars = label.chars().count().min(layout_config.max_label_chars() as usize);
    cpp_max(
        layout_config.node_padding_left()
            + layout_config.icon_width()
            + layout_config.icon_margin_right()
            + (label_chars as f64 * layout_config.width_per_label_char())
            + layout_config.node_padding_right(),
        layout_config.node_min_width(),
    )
}

/// A node for the layouter
#[derive(Clone, Debug, Default)]
struct PlanLayoutNode {
    /// The parent (if any)
    parent: Option<usize>,
    /// The children
    children_begin: usize,
    /// The number of children
    children_count: usize,
    /// The rendered node width
    width: f64,
    /// The node index among its siblings
    sibling_index: usize,

    /// Walker - The current node's preliminary x-coordinate
    prelim: f64,
    /// Walker - The current node's modifier value.
    ///
    /// We track shifting only at subtree roots instead of eagerly updating the x-coordinates within the tree.
    /// `mod` is a value that is to be added to all preliminary x-coordinates in the subtree rooted at v, except for v
    /// itself.
    ///
    /// The actual x-coordinate of a node is the own preliminary position `prelim` plus all `mod` values on the path to
    /// the root, also called `modsum` in the paper. We traverse top-down in a dedicated pass at the end to compute the
    /// final position in O(n).
    ///
    /// For leafs v with a thread to w, `mod` stores `modsum(v) - modsum(w)`.
    modifier: f64,
    /// Walker - The current node's x-coordinate
    x: f64,
    /// Walker - The current node's y-coordinate
    y: f64,
    /// Buchheim - The current node's shifting.
    /// Buchheim memoizes the node shifting to shift non-current subtrees in a single pass.
    /// This is needed to make the central positioning of parents above the children non-quadratic.
    shift: f64,
    /// Buchheim - The current node's change.
    change: f64,
    /// A corrective subtree shift applied by the final level sweep.
    layout_shift: f64,
    /// Buchheim - Save a node's ancestor.
    ancestor: usize,
    /// Reingold - The node's thread
    thread: Option<usize>,
}

impl PlanLayoutNode {
    /// Is a leaf?
    fn is_leaf(&self) -> bool {
        self.children_count == 0
    }
    /// Walker - The current node's leftmost offspring. Must not be a leaf.
    fn left_most_child(&self) -> usize {
        debug_assert!(!self.is_leaf());
        self.children_begin
    }
    /// Walker - The current node's rightmost offspring. Must not be a leaf.
    fn right_most_child(&self) -> usize {
        debug_assert!(!self.is_leaf());
        self.children_begin + self.children_count - 1
    }
    /// Traverse the right contour.
    /// If we're an inner node, we traverse to the right-most child.
    /// If we're a leaf, we traverse to our thread.
    fn next_along_right_contour(&self) -> Option<usize> {
        if !self.is_leaf() {
            Some(self.right_most_child())
        } else {
            self.thread
        }
    }
    /// Traverse the left contour.
    /// If we're an inner node, we traverse to the left-most child.
    /// If we're a leaf, we traverse to our thread.
    fn next_along_left_contour(&self) -> Option<usize> {
        if !self.is_leaf() {
            Some(self.left_most_child())
        } else {
            self.thread
        }
    }
    /// The children
    fn children(&self) -> std::ops::Range<usize> {
        self.children_begin..self.children_begin + self.children_count
    }
}

/// The tree layouter that positions the operators of a plan
struct PlanLayouter<'a> {
    /// The plan layout nodes
    nodes: Vec<PlanLayoutNode>,
    /// The root operators
    root_operators: &'a [u32],
    /// The plan layout config
    layout_config: fb::PlanLayoutConfig,
}

impl<'a> PlanLayouter<'a> {
    fn new(view_model: &'a PlanViewModel, layout_config: &fb::DerivedPlanLayoutConfig) -> Self {
        let input = *layout_config.input();
        let mut nodes = vec![PlanLayoutNode::default(); view_model.operators.len()];
        for (i, op) in view_model.operators.iter().enumerate() {
            nodes[i].parent = op.parent_operator_id;
            nodes[i].children_begin = op.children_begin;
            nodes[i].children_count = op.children_count;
            nodes[i].width = compute_node_width(op, &input);
            nodes[i].ancestor = i;
            for child_index in 0..op.children_count {
                nodes[op.children_begin + child_index].sibling_index = child_index;
            }
        }
        Self { nodes, root_operators: &view_model.root_operators, layout_config: input }
    }

    /// Compute the required center-to-center distance between two nodes
    fn separation(&self, left: usize, right: usize) -> f64 {
        self.nodes[left].width / 2.0 + self.layout_config.node_margin_horizontal() + self.nodes[right].width / 2.0
    }

    /// Perform the first walk over the tree
    fn first_walk(&mut self, node: usize, left_sibling: Option<usize>) {
        if !self.nodes[node].is_leaf() {
            // The default ancestor is the left-most child.
            let mut default_ancestor = self.nodes[node].left_most_child();
            // Track the left sibling
            let mut current_left_sibling = None;

            for child in self.nodes[node].children() {
                self.first_walk(child, current_left_sibling);
                default_ancestor = self.apportion(child, current_left_sibling, default_ancestor);
                current_left_sibling = Some(child);
            }

            // Execute the shifts at a node
            self.execute_shifts(node);
            // Compute the mid-point
            let n = &self.nodes[node];
            let midpoint = (self.nodes[n.left_most_child()].prelim + self.nodes[n.right_most_child()].prelim) / 2.0;

            // Is there a left sibling?
            if let Some(left_sibling) = left_sibling {
                let prelim = self.nodes[left_sibling].prelim + self.separation(left_sibling, node);
                self.nodes[node].prelim = prelim;
                self.nodes[node].modifier = prelim - midpoint;
            } else {
                self.nodes[node].prelim = midpoint;
            }
        } else {
            // Is there a left sibling?
            if let Some(left_sibling) = left_sibling {
                self.nodes[node].prelim = self.nodes[left_sibling].prelim + self.separation(left_sibling, node);
            } else {
                self.nodes[node].prelim = 0.0;
            }
        }
    }

    /// Perform the second walk over the tree
    fn second_walk(&mut self, node: usize, m: f64, level: usize) {
        self.nodes[node].x = self.nodes[node].prelim + m;
        self.nodes[node].y = level as f64 * self.layout_config.level_height();
        let modifier = self.nodes[node].modifier;
        for child in self.nodes[node].children() {
            self.second_walk(child, m + modifier, level + 1);
        }
    }

    /// Find the greatest distinct ancestor betweeen nodes
    fn find_greatest_distinct_ancestor(&self, left: usize, right: usize, default_ancestor: usize) -> usize {
        let ancestor = self.nodes[left].ancestor;
        if self.nodes[ancestor].parent == self.nodes[right].parent {
            ancestor
        } else {
            default_ancestor
        }
    }

    /// Apportion routine of Walker's algorithm
    fn apportion(&mut self, root: usize, left_sibling_of_root: Option<usize>, default_ancestor: usize) -> usize {
        //
        //     [-]     [+]      o:  Outside contour.
        //      .       .       i:  Inside contour.
        //     / \     / \      ll: Left-tree(s) Left-most-contour.
        //    /___\   /___\     lr: Left-tree(s) Right-most-contour.
        //    o   i   i   o     rl: Right-tree Left-contour.
        //    ll  lr  rl  rr    rr: Right-tree Right-contour.
        //
        let mut new_default_ancestor = default_ancestor;

        if let Some(left_sibling) = left_sibling_of_root {
            let mut rl = root;
            let mut rr = root;
            let mut lr = left_sibling;
            let parent = self.nodes[rl].parent.expect("apportioned node must have a parent");
            let mut ll = self.nodes[parent].left_most_child();

            let mut ll_mod = self.nodes[ll].modifier;
            let mut lr_mod = self.nodes[lr].modifier;
            let mut rl_mod = self.nodes[rl].modifier;
            let mut rr_mod = self.nodes[rr].modifier;

            // Traverse down the "seam".
            // Left subtree, traverse along right contour.
            // Right subtree, traverse along left contour.
            while let (Some(next_lr), Some(next_rl)) =
                (self.nodes[lr].next_along_right_contour(), self.nodes[rl].next_along_left_contour())
            {
                ll = self.nodes[ll].next_along_left_contour().expect("left contour ends early");
                lr = next_lr;
                rl = next_rl;
                rr = self.nodes[rr].next_along_right_contour().expect("right contour ends early");

                // Maintain the ancestor of the right contour to be the common root.
                // This allows us to resolve our ancestor in O(1) while going over the tree left-to-right.
                self.nodes[rr].ancestor = root;

                // Compute the current shift as the difference between the left contour and the right contour along
                // the seam. Section 4 in the Buchheim paper does a good job explain the fractional spacing approach.
                let shift =
                    (self.nodes[lr].prelim + lr_mod) - (self.nodes[rl].prelim + rl_mod) + self.separation(lr, rl);

                if shift > 0.0 {
                    let ancestor = self.find_greatest_distinct_ancestor(lr, root, default_ancestor);
                    self.move_subtree(ancestor, root, shift);
                    rl_mod += shift;
                    rr_mod += shift;
                }

                ll_mod += self.nodes[ll].modifier;
                lr_mod += self.nodes[lr].modifier;
                rl_mod += self.nodes[rl].modifier;
                rr_mod += self.nodes[rr].modifier;
            }

            // Still have contour nodes at the seam from the left subtree?
            let lr_next = self.nodes[lr].next_along_right_contour();
            let rr_next = self.nodes[rr].next_along_right_contour();
            if lr_next.is_some() && rr_next.is_none() {
                // Let thread of RR point to LRs right contour starting at next level.
                self.nodes[rr].thread = lr_next;
                self.nodes[rr].modifier += lr_mod - rr_mod;
            }

            // Still have contour nodes at the seam from the right subtree?
            let rl_next = self.nodes[rl].next_along_left_contour();
            let ll_next = self.nodes[ll].next_along_left_contour();
            if rl_next.is_some() && ll_next.is_none() {
                // Let thread of LL point to RLs left contour starting at next level.
                self.nodes[ll].thread = rl_next;
                self.nodes[ll].modifier += rl_mod - ll_mod;
                new_default_ancestor = root;
            }
        }

        new_default_ancestor
    }

    /// Execute shifts for a layout node
    fn execute_shifts(&mut self, v: usize) {
        let mut shift = 0.0;
        let mut change = 0.0;
        for child in self.nodes[v].children().rev() {
            let child = &mut self.nodes[child];
            child.prelim += shift;
            child.modifier += shift;
            change += child.change;
            shift += child.shift + change;
        }
    }

    /// Helper to move a subtree
    fn move_subtree(&mut self, w0: usize, w1: usize, shift: f64) {
        debug_assert!(self.nodes[w0].parent.is_some());
        debug_assert!(self.nodes[w1].parent == self.nodes[w0].parent);
        debug_assert!(self.nodes[w1].sibling_index > self.nodes[w0].sibling_index);
        let subtrees = self.nodes[w1].sibling_index.wrapping_sub(self.nodes[w0].sibling_index) as f64;

        self.nodes[w1].change -= shift / subtrees;
        self.nodes[w1].shift += shift;
        self.nodes[w0].change += shift / subtrees;
        self.nodes[w1].prelim += shift;
        self.nodes[w1].modifier += shift;
    }

    /// Enforce the spacing invariant among all nodes on each level
    fn resolve_level_overlaps(&mut self, root: usize) {
        let margin = self.layout_config.node_margin_horizontal();
        let mut level: Vec<(usize, f64)> = vec![(root, 0.0)];
        while !level.is_empty() {
            let mut next_level = Vec::new();
            let mut right_edge: Option<f64> = None;
            for (node, inherited_shift) in level {
                let mut shift = inherited_shift + self.nodes[node].layout_shift;
                let left_edge = self.nodes[node].x + shift - self.nodes[node].width / 2.0;
                if let Some(right_edge) = right_edge {
                    let correction = right_edge + margin - left_edge;
                    if correction > 0.0 {
                        self.nodes[node].layout_shift += correction;
                        shift += correction;
                    }
                }
                right_edge = Some(self.nodes[node].x + shift + self.nodes[node].width / 2.0);
                next_level.extend(self.nodes[node].children().map(|child| (child, shift)));
            }
            level = next_level;
        }

        let mut pending: Vec<(usize, f64)> = vec![(root, 0.0)];
        while let Some((node, inherited_shift)) = pending.pop() {
            let shift = inherited_shift + self.nodes[node].layout_shift;
            self.nodes[node].x += shift;
            pending.extend(self.nodes[node].children().map(|child| (child, shift)));
        }
    }

    /// Compute the plan layout
    fn compute(&mut self) {
        let margin = self.layout_config.node_margin_horizontal();
        let mut packed_right = 0.0;
        let mut has_packed_root = false;
        for &root in self.root_operators {
            let root = root as usize;
            // First run over the tree
            self.first_walk(root, None);
            // Second run over the tree.
            // `prelim` stores the preliminary x-coordinate AFTER computing the subtree.
            self.second_walk(root, -1.0 * self.nodes[root].prelim, 0);
            self.resolve_level_overlaps(root);

            // Independent roots are laid out at the same origin. Pack their full subtree bounds left-to-right.
            let mut left = f64::MAX;
            let mut right = f64::MIN;
            let mut pending = vec![root];
            while let Some(node) = pending.pop() {
                let n = &self.nodes[node];
                left = cpp_min(left, n.x - n.width / 2.0);
                right = cpp_max(right, n.x + n.width / 2.0);
                pending.extend(n.children());
            }
            if has_packed_root {
                let offset = packed_right + margin - left;
                pending.push(root);
                while let Some(node) = pending.pop() {
                    self.nodes[node].x += offset;
                    pending.extend(self.nodes[node].children());
                }
                right += offset;
            }
            has_packed_root = true;
            packed_right = right;
        }
    }
}

impl PlanViewModel {
    /// Configure the layout
    pub fn configure(&mut self, config: &fb::PlanLayoutConfig) {
        self.layout_config.set_input(config);
        self.layout_config.set_computed_node_width(config.node_min_width());
    }

    /// Compute the plan layout
    pub fn compute_layout(&mut self) {
        let input = *self.layout_config.input();

        // Retain the widest node pitch in the derived config for layout consumers.
        let mut cell_width = 0.0;
        for op in &self.operators {
            cell_width = cpp_max(cell_width, compute_node_width(op, &input) + input.node_margin_horizontal());
        }
        self.layout_config.set_computed_node_width(cell_width);

        // Compute the plan layout
        let mut layouter = PlanLayouter::new(self, &self.layout_config);
        layouter.compute();
        let nodes = layouter.nodes;

        // Compute total width and x- and y-shifts to make each point positive
        let mut x_max = f64::MIN;
        let mut x_min = f64::MAX;
        let mut y_max = f64::MIN;
        let mut y_min = f64::MAX;
        let node_height = input.node_height();
        let level_height = input.level_height();
        for node in &nodes {
            x_max = cpp_max(x_max, node.x + node.width / 2.0);
            x_min = cpp_min(x_min, node.x - node.width / 2.0);
            y_max = cpp_max(y_max, node.y);
            y_min = cpp_min(y_min, node.y);
        }
        let total_width = (x_max - x_min).abs();
        let total_height = (y_max - y_min).abs() + level_height;
        let shift_x = -x_min;
        let shift_y = (y_min - level_height / 2.0) * -1.0;

        // Set all nodes layouts
        for (out, node) in self.operators.iter_mut().zip(&nodes) {
            let rect = fb::PlanLayoutRect::new(shift_x + node.x, shift_y + node.y, node.width, node_height);
            out.layout_rect = Some(rect);
        }

        // Update the plan layout info
        self.layout_rect = Some(if !self.operators.is_empty() {
            fb::PlanLayoutRect::new(0.0, 0.0, total_width, total_height)
        } else {
            fb::PlanLayoutRect::default()
        });
    }
}
