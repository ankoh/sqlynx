//! A statement-level semantic diff between two parsed scripts, a port of
//! the C++ `src/script_diff.cc`.
//!
//! A modified patience diff over the statements of two parsed scripts: statements are mapped by
//! structural equality (order-insensitive), the longest common subsequence of unambiguous pairs is
//! kept, and the remaining statements are classified as MOVE / UPDATE / DELETE / INSERT.
//!
//! AST spans are token-index based and are resolved through the scanned script before touching
//! text. Object attribute lists are not sorted by key, the traversals sort a scratch copy.

use dashql_buffers::diff::{ScriptDiffOpCode, ScriptDiffOpT, ScriptDiffT};
use dashql_buffers::parser::{Node, NodeType, TextSpanT};
use dashql_parser::parser::context::resolve_text_span;
use dashql_parser::parser::{ParsedScript, Statement};
use dashql_parser::span::TextSpan;

/// The fraction of nodes that must be equal between statements to emit an UPDATE (instead of
/// DELETE + INSERT)
const UPDATE_SIMILARITY_THRESHOLD: f64 = 0.75;

/// A single diff operation
#[derive(Clone, Debug, PartialEq)]
pub struct DiffOp {
    pub code: ScriptDiffOpCode,
    /// The source (old) statement index, None for INSERT
    pub source_statement: Option<u32>,
    /// The target (new) statement index, None for DELETE
    pub target_statement: Option<u32>,
    /// The resolved text span of the source statement root (empty if no source)
    pub source_span: TextSpan,
    /// The resolved text span of the target statement root (empty if no target)
    pub target_span: TextSpan,
    /// The changed sub-ranges within the target statement (UPDATE only, coalesced)
    pub target_changes: Vec<TextSpan>,
}

/// A fast similarity estimate for two statements
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SimilarityEstimate {
    NotEqual,
    Similar,
    Equal,
}

/// A statement similarity score (matching nodes / total nodes)
#[derive(Clone, Copy, Debug, Default)]
struct StatementSimilarity {
    matching_nodes: usize,
    total_nodes: usize,
}

impl StatementSimilarity {
    fn score(&self) -> f64 {
        if self.total_nodes == 0 {
            0.0
        } else {
            self.matching_nodes as f64 / self.total_nodes as f64
        }
    }
}

/// A statement mapping (source id, target id)
type StatementMapping = (usize, usize);

/// The emitted operations and statements while computing a diff
struct Emitter {
    ops: Vec<DiffOp>,
    source_emitted: Vec<bool>,
    target_emitted: Vec<bool>,
}

/// Is the node type an enum? Enums live between ENUM_KEYS_ and OBJECT_KEYS_, except the four
/// ENUM_VIS_* values that sit between OBJECT_KEYS_ and VIS_OBJECT_KEYS_.
fn is_enum_type(t: NodeType) -> bool {
    let id = t.0;
    (id > NodeType::ENUM_KEYS_.0 && id < NodeType::OBJECT_KEYS_.0)
        || (id >= NodeType::ENUM_VIS_ENCODING_CHANNEL.0 && id <= NodeType::ENUM_VIS_SCALE_TYPE.0)
}

/// Is the node type an object? Objects live above OBJECT_KEYS_, except the ENUM_VIS_* block.
fn is_object_type(t: NodeType) -> bool {
    let id = t.0;
    (id > NodeType::OBJECT_KEYS_.0 && id < NodeType::ENUM_VIS_ENCODING_CHANNEL.0) || id > NodeType::VIS_OBJECT_KEYS_.0
}

/// Does the node type have child nodes (as opposed to an inline value)?
fn has_children(t: NodeType) -> bool {
    t == NodeType::ARRAY || is_object_type(t)
}

fn key_id(n: &Node) -> u16 {
    n.attribute_key().0
}

/// The text of a span like `ScannedScript::ReadTextAtTextSpan`, which reads the text buffer with its
/// two padding NUL bytes. Spans of EOF errors end one byte past the text.
fn padded_text(script: &ParsedScript, span: TextSpan) -> std::borrow::Cow<'_, [u8]> {
    let text = script.scanned.text.as_bytes();
    let begin = (span.offset as usize).min(text.len() + 2);
    let end = (span.end() as usize).min(text.len() + 2);
    if end <= text.len() {
        return std::borrow::Cow::Borrowed(&text[begin..end]);
    }
    let mut out = text[begin.min(text.len())..].to_vec();
    out.resize(end - begin, 0);
    std::borrow::Cow::Owned(out)
}

/// The resolved text of a node (for operators and literals)
fn node_text<'a>(script: &'a ParsedScript, node: &Node) -> std::borrow::Cow<'a, [u8]> {
    padded_text(script, resolve(script, node))
}

/// The registered name text of a NAME node
fn name_text<'a>(script: &'a ParsedScript, node: &Node) -> &'a str {
    &script.scanned.names.get(node.children_begin_or_value()).text
}

fn resolve(script: &ParsedScript, node: &Node) -> TextSpan {
    resolve_text_span(&script.scanned.text, &script.scanned.symbols, *node.symbol_span())
}

/// The text span of a statement root (empty if the root is invalid)
fn resolve_statement_span(script: &ParsedScript, statement: &Statement) -> TextSpan {
    match script.nodes.get(statement.root as usize) {
        Some(root) => resolve(script, root),
        None => TextSpan::default(),
    }
}

/// An object's child node indices sorted (stably) by attribute key
fn collect_sorted_children(script: &ParsedScript, node: &Node, out: &mut Vec<u32>) {
    out.clear();
    let begin = node.children_begin_or_value();
    out.extend(begin..begin + node.children_count());
    out.sort_by_key(|&i| key_id(&script.nodes[i as usize]));
}

/// The diff between two parsed scripts
pub struct ScriptDiff<'a> {
    source: &'a ParsedScript,
    target: &'a ParsedScript,
    /// Memoized subtree sizes (0 = not computed yet)
    source_subtree_sizes: Vec<usize>,
    target_subtree_sizes: Vec<usize>,
    ops: Vec<DiffOp>,
    computed: bool,
}

impl<'a> ScriptDiff<'a> {
    pub fn new(source: &'a ParsedScript, target: &'a ParsedScript) -> Self {
        Self {
            source,
            target,
            source_subtree_sizes: Vec::new(),
            target_subtree_sizes: Vec::new(),
            ops: Vec::new(),
            computed: false,
        }
    }

    /// The size of the subtree rooted at `root` (memoized iterative DFS)
    fn compute_tree_size(script: &ParsedScript, root: usize, sizes: &mut Vec<usize>) -> usize {
        if root >= script.nodes.len() {
            return 0;
        }
        if sizes.len() != script.nodes.len() {
            *sizes = vec![0; script.nodes.len()];
        } else if sizes[root] > 0 {
            return sizes[root];
        }
        // (node, parent, visited)
        let mut pending: Vec<(usize, usize, bool)> = Vec::with_capacity(32);
        pending.push((root, root, false));
        let mut node_count = 0;
        while let Some(&(node_id, parent, visited)) = pending.last() {
            if visited {
                if pending.len() == 1 {
                    node_count = sizes[node_id];
                    break;
                }
                sizes[parent] += sizes[node_id];
                pending.pop();
                continue;
            }
            sizes[node_id] = 1;
            pending.last_mut().unwrap().2 = true;
            let node = &script.nodes[node_id];
            if has_children(node.node_type()) {
                let begin = node.children_begin_or_value() as usize;
                for i in begin..begin + node.children_count() as usize {
                    pending.push((i, node_id, false));
                }
            }
        }
        node_count
    }

    /// Estimate the similarity of two statements (O(1) for unchanged statements)
    fn estimate_similarity(&self, source: &Statement, target: &Statement) -> SimilarityEstimate {
        let (Some(s), Some(t)) = (self.source.nodes.get(source.root as usize), self.target.nodes.get(target.root as usize))
        else {
            return SimilarityEstimate::NotEqual;
        };
        if s.node_type() != t.node_type() {
            return SimilarityEstimate::NotEqual;
        }
        // Compare the text if the statements are equal in size and number of root attributes.
        let s_span = resolve(self.source, s);
        let t_span = resolve(self.target, t);
        if s.children_count() == t.children_count() && s_span.length == t_span.length {
            if padded_text(self.source, s_span) == padded_text(self.target, t_span) {
                return SimilarityEstimate::Equal;
            }
        }
        SimilarityEstimate::Similar
    }

    /// Do two nodes of the same type match without looking at their children?
    fn leaf_match(&self, s: &Node, t: &Node) -> Option<bool> {
        Some(match s.node_type() {
            NodeType::NONE => true,
            NodeType::BOOL => s.children_begin_or_value() == t.children_begin_or_value(),
            NodeType::NAME => name_text(self.source, s) == name_text(self.target, t),
            NodeType::OPERATOR
            | NodeType::LITERAL_NULL
            | NodeType::LITERAL_INTEGER
            | NodeType::LITERAL_FLOAT
            | NodeType::LITERAL_STRING
            | NodeType::LITERAL_INTERVAL => node_text(self.source, s) == node_text(self.target, t),
            _ => return None,
        })
    }

    /// Compute the similarity of two statements (lockstep DFS over the subtrees)
    fn compute_similarity(&mut self, source: &Statement, target: &Statement) -> StatementSimilarity {
        let source_size = Self::compute_tree_size(self.source, source.root as usize, &mut self.source_subtree_sizes);
        let target_size = Self::compute_tree_size(self.target, target.root as usize, &mut self.target_subtree_sizes);
        let node_count = source_size.max(target_size);
        if node_count == 0 {
            return StatementSimilarity::default();
        }
        struct Entry {
            source_node: usize,
            target_node: usize,
            parent_entry: usize,
            matching_nodes: usize,
            visited: bool,
        }
        let mut pending = Vec::with_capacity(32);
        pending.push(Entry {
            source_node: source.root as usize,
            target_node: target.root as usize,
            parent_entry: 0,
            matching_nodes: 0,
            visited: false,
        });
        let mut src_children = Vec::new();
        let mut tgt_children = Vec::new();
        let mut sim = StatementSimilarity::default();
        while !pending.is_empty() {
            let idx = pending.len() - 1;
            if pending[idx].visited {
                if idx == 0 {
                    sim.total_nodes = node_count;
                    sim.matching_nodes = pending[0].matching_nodes;
                    break;
                }
                let entry = pending.pop().unwrap();
                pending[entry.parent_entry].matching_nodes += entry.matching_nodes;
                continue;
            }
            pending[idx].visited = true;
            let s = self.source.nodes[pending[idx].source_node];
            let t = self.target.nodes[pending[idx].target_node];
            let mut matched = true;
            if s.node_type() != t.node_type() {
                matched = false;
            } else if let Some(m) = self.leaf_match(&s, &t) {
                matched = m;
            } else if s.node_type() == NodeType::ARRAY {
                let (sc, tc) = (s.children_count(), t.children_count());
                matched = sc == tc;
                let (sb, tb) = (s.children_begin_or_value(), t.children_begin_or_value());
                for i in 0..sc.min(tc) {
                    pending.push(Entry {
                        source_node: (sb + i) as usize,
                        target_node: (tb + i) as usize,
                        parent_entry: idx,
                        matching_nodes: 0,
                        visited: false,
                    });
                }
            } else if is_object_type(s.node_type()) {
                // Attribute lists are unsorted; sort scratch copies by key, then merge-join.
                collect_sorted_children(self.source, &s, &mut src_children);
                collect_sorted_children(self.target, &t, &mut tgt_children);
                matched = s.children_count() == t.children_count();
                let (mut i, mut j) = (0, 0);
                while i < src_children.len() && j < tgt_children.len() {
                    let sk = key_id(&self.source.nodes[src_children[i] as usize]);
                    let tk = key_id(&self.target.nodes[tgt_children[j] as usize]);
                    if sk < tk {
                        i += 1;
                        matched = false;
                    } else if sk > tk {
                        j += 1;
                        matched = false;
                    } else {
                        pending.push(Entry {
                            source_node: src_children[i] as usize,
                            target_node: tgt_children[j] as usize,
                            parent_entry: idx,
                            matching_nodes: 0,
                            visited: false,
                        });
                        i += 1;
                        j += 1;
                    }
                }
            } else if is_enum_type(s.node_type()) {
                matched = s.children_begin_or_value() == t.children_begin_or_value();
            }
            if matched {
                pending[idx].matching_nodes += 1;
            }
        }
        sim
    }

    /// Check two statements for deep equality
    fn check_deep_equality(&self, source: &Statement, target: &Statement) -> bool {
        let source_valid = (source.root as usize) < self.source.nodes.len();
        let target_valid = (target.root as usize) < self.target.nodes.len();
        if !source_valid || !target_valid {
            return !source_valid && !target_valid;
        }
        let mut pending = vec![(source.root as usize, target.root as usize)];
        let mut src_children = Vec::new();
        let mut tgt_children = Vec::new();
        while let Some((source_id, target_id)) = pending.pop() {
            let s = self.source.nodes[source_id];
            let t = self.target.nodes[target_id];
            if s.node_type() != t.node_type() {
                return false;
            }
            if let Some(m) = self.leaf_match(&s, &t) {
                if !m {
                    return false;
                }
            } else if s.node_type() == NodeType::ARRAY {
                if s.children_count() != t.children_count() {
                    return false;
                }
                let (sb, tb) = (s.children_begin_or_value(), t.children_begin_or_value());
                for i in 0..s.children_count() {
                    pending.push(((sb + i) as usize, (tb + i) as usize));
                }
            } else if is_object_type(s.node_type()) {
                if s.children_count() != t.children_count() {
                    return false;
                }
                collect_sorted_children(self.source, &s, &mut src_children);
                collect_sorted_children(self.target, &t, &mut tgt_children);
                for (&si, &ti) in src_children.iter().zip(&tgt_children) {
                    if key_id(&self.source.nodes[si as usize]) != key_id(&self.target.nodes[ti as usize]) {
                        return false;
                    }
                    pending.push((si as usize, ti as usize));
                }
            } else if is_enum_type(s.node_type()) && s.children_begin_or_value() != t.children_begin_or_value() {
                return false;
            }
        }
        true
    }

    /// Map statements between the two scripts (unique + equal pairs, with ambiguity handling)
    fn map_statements(&self) -> (Vec<StatementMapping>, Vec<StatementMapping>) {
        let source_count = self.source.statements.len();
        let target_count = self.target.statements.len();
        let mut source_ambiguous = vec![false; source_count];
        let mut target_ambiguous = vec![false; target_count];
        let mut target_mapping: Vec<Option<usize>> = vec![None; target_count];
        let mut unique_pairs = Vec::new();
        let mut equal_pairs = Vec::new();

        for source_id in 0..source_count {
            let source_stmt = &self.source.statements[source_id];
            let mut matched: Option<usize> = None;
            for target_id in 0..target_count {
                let target_stmt = &self.target.statements[target_id];
                let equal = match self.estimate_similarity(source_stmt, target_stmt) {
                    SimilarityEstimate::NotEqual => false,
                    SimilarityEstimate::Similar => self.check_deep_equality(source_stmt, target_stmt),
                    SimilarityEstimate::Equal => true,
                };
                if !equal {
                    continue;
                }
                equal_pairs.push((source_id, target_id));
                if let Some(existing) = target_mapping[target_id] {
                    // Two source statements map to the same target statement
                    source_ambiguous[source_id] = true;
                    source_ambiguous[existing] = true;
                    target_ambiguous[target_id] = true;
                    continue;
                } else if let Some(m) = matched {
                    // The source statement maps to two target statements
                    source_ambiguous[source_id] = true;
                    target_ambiguous[m] = true;
                    target_ambiguous[target_id] = true;
                    continue;
                }
                target_mapping[target_id] = Some(source_id);
                matched = Some(target_id);
            }
        }

        for (target_id, &source_id) in target_mapping.iter().enumerate() {
            let Some(source_id) = source_id else { continue };
            if source_ambiguous[source_id] || target_ambiguous[target_id] {
                continue;
            }
            unique_pairs.push((source_id, target_id));
        }
        unique_pairs.sort_by_key(|p| p.0);
        equal_pairs.sort();
        (unique_pairs, equal_pairs)
    }

    /// The longest common subsequence among the unique pairs (patience sort)
    fn find_lcs(unique_pairs: &[StatementMapping]) -> Vec<StatementMapping> {
        // (source id, target id, size of the previous pile)
        let mut piles: Vec<Vec<(usize, usize, usize)>> = Vec::new();
        for &(source_id, target_id) in unique_pairs {
            match piles.iter().position(|pile| pile.last().unwrap().1 >= target_id) {
                Some(p) => {
                    let prev_pile_id = p.max(1) - 1;
                    let prev_pile_size = piles[prev_pile_id].len();
                    piles[p].push((source_id, target_id, prev_pile_size));
                }
                None => {
                    piles.push(Vec::new());
                    let prev_pile_id = piles.len().max(2) - 2;
                    let prev_pile_size = piles[prev_pile_id].len();
                    piles.last_mut().unwrap().push((source_id, target_id, prev_pile_size));
                }
            }
        }
        let mut lcs = Vec::new();
        if piles.is_empty() {
            return lcs;
        }
        let mut pile_id = piles.len() - 1;
        let mut entry_id = piles[pile_id].len() - 1;
        loop {
            let (source_id, target_id, prev_pile_size) = piles[pile_id][entry_id];
            lcs.push((source_id, target_id));
            if pile_id == 0 {
                break;
            }
            entry_id = prev_pile_size - 1;
            pile_id -= 1;
        }
        lcs.reverse();
        lcs
    }

    /// The changed sub-ranges within an UPDATE target statement (target-side highlighting)
    fn collect_target_changes(&self, source: &Statement, target: &Statement) -> Vec<TextSpan> {
        let mut changes = Vec::new();
        if source.root as usize >= self.source.nodes.len() || target.root as usize >= self.target.nodes.len() {
            return changes;
        }
        let record = |changes: &mut Vec<TextSpan>, target_node_id: usize| {
            let span = resolve(self.target, &self.target.nodes[target_node_id]);
            if span.length > 0 {
                changes.push(span);
            }
        };
        let mut pending = vec![(source.root as usize, target.root as usize)];
        let mut src_children = Vec::new();
        let mut tgt_children = Vec::new();
        while let Some((source_id, target_id)) = pending.pop() {
            let s = self.source.nodes[source_id];
            let t = self.target.nodes[target_id];
            // Different node type: the entire target subtree changed
            if s.node_type() != t.node_type() {
                record(&mut changes, target_id);
                continue;
            }
            if let Some(m) = self.leaf_match(&s, &t) {
                if !m {
                    record(&mut changes, target_id);
                }
            } else if s.node_type() == NodeType::ARRAY {
                let (sc, tc) = (s.children_count(), t.children_count());
                let (sb, tb) = (s.children_begin_or_value(), t.children_begin_or_value());
                let common = sc.min(tc);
                for i in 0..common {
                    pending.push(((sb + i) as usize, (tb + i) as usize));
                }
                // Extra target children are additions
                for i in common..tc {
                    record(&mut changes, (tb + i) as usize);
                }
            } else if is_object_type(s.node_type()) {
                collect_sorted_children(self.source, &s, &mut src_children);
                collect_sorted_children(self.target, &t, &mut tgt_children);
                let (mut i, mut j) = (0, 0);
                while i < src_children.len() && j < tgt_children.len() {
                    let sk = key_id(&self.source.nodes[src_children[i] as usize]);
                    let tk = key_id(&self.target.nodes[tgt_children[j] as usize]);
                    if sk < tk {
                        i += 1;
                    } else if sk > tk {
                        record(&mut changes, tgt_children[j] as usize);
                        j += 1;
                    } else {
                        pending.push((src_children[i] as usize, tgt_children[j] as usize));
                        i += 1;
                        j += 1;
                    }
                }
                for &child in &tgt_children[j..] {
                    record(&mut changes, child as usize);
                }
            } else if is_enum_type(s.node_type()) && s.children_begin_or_value() != t.children_begin_or_value() {
                record(&mut changes, target_id);
            }
        }
        // Sort and coalesce overlapping or adjacent spans
        if changes.len() > 1 {
            changes.sort_by_key(|c| c.offset);
            let mut coalesced: Vec<TextSpan> = Vec::with_capacity(changes.len());
            coalesced.push(changes[0]);
            for change in &changes[1..] {
                let last = coalesced.last_mut().unwrap();
                let last_end = last.end();
                if change.offset <= last_end {
                    let new_end = last_end.max(change.end());
                    *last = TextSpan::new(last.offset, new_end - last.offset);
                } else {
                    coalesced.push(*change);
                }
            }
            changes = coalesced;
        }
        changes
    }

    /// Emit a diff operation
    fn emit(&self, out: &mut Emitter, code: ScriptDiffOpCode, source_id: Option<usize>, target_id: Option<usize>) {
        let mut op = DiffOp {
            code,
            source_statement: None,
            target_statement: None,
            source_span: TextSpan::default(),
            target_span: TextSpan::default(),
            target_changes: Vec::new(),
        };
        if let Some(s) = source_id {
            op.source_statement = Some(s as u32);
            op.source_span = resolve_statement_span(self.source, &self.source.statements[s]);
            out.source_emitted[s] = true;
        }
        if let Some(t) = target_id {
            op.target_statement = Some(t as u32);
            op.target_span = resolve_statement_span(self.target, &self.target.statements[t]);
            out.target_emitted[t] = true;
        }
        if let (ScriptDiffOpCode::UPDATE, Some(s), Some(t)) = (code, source_id, target_id) {
            op.target_changes = self.collect_target_changes(&self.source.statements[s], &self.target.statements[t]);
        }
        out.ops.push(op);
    }

    /// Compute the diff (memoized)
    pub fn compute(&mut self) -> &[DiffOp] {
        if self.computed {
            return &self.ops;
        }
        self.computed = true;
        let source_count = self.source.statements.len();
        let target_count = self.target.statements.len();
        let (unique_pairs, equal_pairs) = self.map_statements();
        let lcs = Self::find_lcs(&unique_pairs);
        let mut out = Emitter {
            ops: Vec::new(),
            source_emitted: vec![false; source_count],
            target_emitted: vec![false; target_count],
        };

        // Iterate over the sections between LCS entries
        let mut next: StatementMapping = (0, 0);
        for lcs_index in 0..=lcs.len() {
            let prev = next;
            next = lcs.get(lcs_index).copied().unwrap_or((source_count, target_count));
            let (prev_source_id, prev_target_id) = prev;
            let (next_source_id, next_target_id) = next;

            for source_id in prev_source_id..next_source_id {
                // Emit equal pairs that are ambiguous or cross section boundaries (MOVE)
                let begin = equal_pairs.partition_point(|p| p.0 < source_id);
                let end = begin + equal_pairs[begin..].partition_point(|p| p.0 <= source_id);
                for &(_, target_id) in &equal_pairs[begin..end] {
                    if out.target_emitted[target_id] {
                        continue;
                    }
                    self.emit(&mut out, ScriptDiffOpCode::MOVE, Some(source_id), Some(target_id));
                    break;
                }
                if out.source_emitted[source_id] {
                    continue;
                }
                let source_stmt = self.source.statements[source_id];
                // The highest-scoring remaining target in the section above the threshold (a
                // deliberate divergence from the legacy heap, which picked the smallest score)
                let mut best_target = None;
                let mut best_score = -1.0;
                for target_id in prev_target_id..next_target_id {
                    if out.target_emitted[target_id] {
                        continue;
                    }
                    let target_stmt = self.target.statements[target_id];
                    match self.estimate_similarity(&source_stmt, &target_stmt) {
                        SimilarityEstimate::NotEqual => continue,
                        SimilarityEstimate::Equal => {
                            self.emit(&mut out, ScriptDiffOpCode::KEEP, Some(source_id), Some(target_id));
                            break;
                        }
                        SimilarityEstimate::Similar => {}
                    }
                    let score = self.compute_similarity(&source_stmt, &target_stmt).score();
                    if score >= UPDATE_SIMILARITY_THRESHOLD && score > best_score {
                        best_score = score;
                        best_target = Some(target_id);
                    }
                }
                // An equal match emitted a KEEP
                if out.source_emitted[source_id] {
                    continue;
                }
                match best_target {
                    Some(t) => self.emit(&mut out, ScriptDiffOpCode::UPDATE, Some(source_id), Some(t)),
                    None => self.emit(&mut out, ScriptDiffOpCode::DELETE, Some(source_id), None),
                }
            }
            // Insert the new statements of the section
            for target_id in prev_target_id..next_target_id {
                if !out.target_emitted[target_id] {
                    self.emit(&mut out, ScriptDiffOpCode::INSERT, None, Some(target_id));
                }
            }
            if lcs_index < lcs.len() {
                self.emit(&mut out, ScriptDiffOpCode::KEEP, Some(next_source_id), Some(next_target_id));
            }
        }
        self.ops = out.ops;
        &self.ops
    }

    /// Pack the diff into the FlatBuffers object API
    pub fn pack(&mut self) -> ScriptDiffT {
        let span = |s: &TextSpan| TextSpanT { offset: s.offset, length: s.length };
        let ops = self
            .compute()
            .iter()
            .map(|op| {
                let mut out = ScriptDiffOpT::default();
                out.code = op.code;
                out.source_statement = op.source_statement.unwrap_or(u32::MAX);
                out.target_statement = op.target_statement.unwrap_or(u32::MAX);
                out.source_span = op.source_statement.map(|_| span(&op.source_span));
                out.target_span = op.target_statement.map(|_| span(&op.target_span));
                out.target_changes = (!op.target_changes.is_empty()).then(|| op.target_changes.iter().map(span).collect());
                out
            })
            .collect();
        let mut diff = ScriptDiffT::default();
        diff.ops = Some(ops);
        diff
    }
}
