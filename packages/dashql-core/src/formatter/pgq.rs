//! Property graphs and graph queries (`formatter/formatter_pgq.cc`).

use dashql_grammar::attrs;
use super::{is_true, FmtReg, Formatter, FormattingJoinPolicy, K};
use dashql_buffers::parser::{Node, NodeType};

impl<'a> Formatter<'a> {
    pub(super) fn format_property_graph(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [vertices, edges] =
            attrs!(self.children(node), [K::SQL_PROPERTY_GRAPH_VERTEX_TABLES, K::SQL_PROPERTY_GRAPH_EDGE_TABLES]);
        let mut sections = Vec::new();
        if let Some(vertices) = vertices.filter(|v| v.children_count() > 0) {
            sections.push(f.concat(&[f.text("vertex tables "), f.parenthesized(self.reg(vertices))]));
        }
        if let Some(edges) = edges.filter(|e| e.children_count() > 0) {
            sections.push(f.concat(&[f.text("edge tables "), f.parenthesized(self.reg(edges))]));
        }
        if sections.is_empty() {
            // An empty text, not the empty document
            return f.text("");
        }
        self.space_join(&sections, self.pretty_policy(FormattingJoinPolicy::BreakOnOverflow), false)
    }

    pub(super) fn format_graph_element_table(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [table, key, source, destination, labels] = attrs!(self.children(node), [
                K::SQL_GRAPH_ELEMENT_TABLE_TABLE,
                K::SQL_GRAPH_ELEMENT_TABLE_KEY,
                K::SQL_GRAPH_ELEMENT_TABLE_SOURCE,
                K::SQL_GRAPH_ELEMENT_TABLE_DESTINATION,
                K::SQL_GRAPH_ELEMENT_TABLE_LABELS,
            ],
        );
        let Some(table) = table else { return self.format_unimplemented(node) };
        let [table_name, table_alias, table_query] =
            attrs!(self.children(table), [K::SQL_TABLEREF_NAME, K::SQL_TABLEREF_ALIAS, K::SQL_TABLEREF_TABLE]);
        let mut table_reg = self.reg(table);
        if let Some(table_alias) = table_alias {
            let mut base_reg = match (table_name, table_query) {
                (Some(table_name), _) => self.reg(table_name),
                (None, Some(table_query)) => self.reg(table_query),
                (None, None) => 0,
            };
            let alias_reg = self.reg(table_alias);
            if base_reg == 0 || alias_reg == 0 {
                return self.format_unimplemented(node);
            }
            if table_query.is_some_and(|q| q.node_type() == NodeType::OBJECT_SQL_SELECT) {
                base_reg = f.parenthesized(base_reg);
            }
            table_reg = f.concat(&[base_reg, f.text(" as "), alias_reg]);
        }
        let mut parts = vec![table_reg];
        if let Some(key) = key {
            parts.push(f.concat(&[f.text("key "), f.parenthesized(self.reg(key))]));
        }
        if let Some(source) = source {
            parts.push(f.concat(&[f.text("source "), self.reg(source)]));
        }
        if let Some(destination) = destination {
            parts.push(f.concat(&[f.text("destination "), self.reg(destination)]));
        }
        if let Some(labels) = labels {
            parts.extend(self.array_regs(labels));
        }
        self.space_join(&parts, self.pretty_policy(FormattingJoinPolicy::BreakOnOverflow), true)
    }

    pub(super) fn format_graph_vertex_reference(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [name, key, columns] = attrs!(self.children(node), [
                K::SQL_GRAPH_VERTEX_REFERENCE_NAME,
                K::SQL_GRAPH_VERTEX_REFERENCE_KEY,
                K::SQL_GRAPH_VERTEX_REFERENCE_COLUMNS,
            ],
        );
        let Some(name) = name else { return self.format_unimplemented(node) };
        let Some(key) = key else { return self.reg(name) };
        let mut result =
            f.concat(&[f.text("key "), f.parenthesized(self.reg(key)), f.text(" references "), self.reg(name)]);
        if let Some(columns) = columns.filter(|c| c.children_count() > 0) {
            result = f.concat(&[result, f.parenthesized(self.reg(columns))]);
        }
        result
    }

    pub(super) fn format_graph_label(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [name, is_default, properties] =
            attrs!(self.children(node), [K::SQL_GRAPH_LABEL_NAME, K::SQL_GRAPH_LABEL_DEFAULT, K::SQL_GRAPH_LABEL_PROPERTIES]);
        let Some(properties) = properties else { return self.format_unimplemented(node) };
        if name.is_none() && !is_true(is_default) {
            return self.format_unimplemented(node);
        }
        let label = match name {
            Some(name) => f.concat(&[f.text("label "), self.reg(name)]),
            None => f.text("default label"),
        };
        f.concat(&[label, f.text(" "), self.reg(properties)])
    }

    pub(super) fn format_graph_properties(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [all, columns, exclude] = attrs!(self.children(node), [K::SQL_GRAPH_PROPERTIES_ALL, K::SQL_GRAPH_PROPERTIES_COLUMNS, K::SQL_GRAPH_PROPERTIES_EXCLUDE],
        );
        if is_true(all) {
            let mut result = f.text("properties are all columns");
            if let Some(exclude) = exclude.filter(|e| e.children_count() > 0) {
                result = f.concat(&[result, f.text(" except "), f.parenthesized(self.reg(exclude))]);
            }
            return result;
        }
        if let Some(columns) = columns {
            return f.concat(&[f.text("properties "), f.parenthesized(self.reg(columns))]);
        }
        f.text("no properties")
    }

    pub(super) fn format_graph_property(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [value, name] = attrs!(self.children(node), [K::SQL_GRAPH_PROPERTY_VALUE, K::SQL_GRAPH_PROPERTY_NAME]);
        let Some(value) = value else { return self.format_unimplemented(node) };
        match name {
            Some(name) => f.concat(&[self.reg(value), f.text(" as "), self.reg(name)]),
            None => self.reg(value),
        }
    }

    pub(super) fn format_graph_table(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [graph, graph_match, rows, columns] = attrs!(self.children(node), [K::SQL_GRAPH_TABLE_GRAPH, K::SQL_GRAPH_TABLE_MATCH, K::SQL_GRAPH_TABLE_ROWS, K::SQL_GRAPH_TABLE_COLUMNS],
        );
        let (Some(graph), Some(graph_match)) = (graph, graph_match) else { return self.format_unimplemented(node) };
        let mut clauses = vec![self.reg(graph), self.reg(graph_match)];
        if let Some(rows) = rows {
            clauses.push(self.reg(rows));
        }
        if let Some(columns) = columns {
            clauses.push(f.concat(&[f.text("columns "), f.parenthesized(self.reg(columns))]));
        }
        let body = self.space_join(&clauses, self.pretty_policy(FormattingJoinPolicy::BreakOnOverflow), true);
        if self.is_pretty() {
            return f.concat(&[
                f.text("graph_table("),
                f.indented(f.concat(&[f.break_(), body])),
                f.break_(),
                f.text(")"),
            ]);
        }
        f.concat(&[f.text("graph_table"), f.parenthesized(body)])
    }

    pub(super) fn format_graph_match(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [patterns, where_clause] = attrs!(self.children(node), [K::SQL_GRAPH_MATCH_PATTERNS, K::SQL_GRAPH_MATCH_WHERE]);
        let Some(patterns) = patterns else { return self.format_unimplemented(node) };
        let result = f.concat(&[f.text("match "), self.reg(patterns)]);
        match where_clause {
            Some(where_clause) => f.concat(&[result, f.text(" where "), self.reg(where_clause)]),
            None => result,
        }
    }

    pub(super) fn format_graph_path_element(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [vertex, left, right, any, variable, label, where_clause, quantifier] = attrs!(self.children(node), [
                K::SQL_GRAPH_PATH_ELEMENT_VERTEX,
                K::SQL_GRAPH_PATH_ELEMENT_EDGE_LEFT,
                K::SQL_GRAPH_PATH_ELEMENT_EDGE_RIGHT,
                K::SQL_GRAPH_PATH_ELEMENT_EDGE_ANY,
                K::SQL_GRAPH_PATH_ELEMENT_VARIABLE,
                K::SQL_GRAPH_PATH_ELEMENT_LABEL,
                K::SQL_GRAPH_PATH_ELEMENT_WHERE,
                K::SQL_GRAPH_PATH_ELEMENT_QUANTIFIER,
            ],
        );
        let mut body_parts = Vec::new();
        if let Some(variable) = variable {
            body_parts.push(self.reg(variable));
        }
        if let Some(label) = label {
            body_parts.push(f.concat(&[f.text(":"), self.reg(label)]));
        }
        if let Some(where_clause) = where_clause {
            body_parts.push(f.concat(&[f.text("where "), self.reg(where_clause)]));
        }
        // Path element bodies are short and must not wrap, breaks happen between path elements instead.
        let mut spaced_parts = Vec::new();
        for (i, &part) in body_parts.iter().enumerate() {
            if i > 0 {
                spaced_parts.push(f.text(" "));
            }
            spaced_parts.push(part);
        }
        let body = f.concat(&spaced_parts);
        let result = if is_true(vertex) {
            if body == 0 {
                f.text("()")
            } else {
                f.concat(&[f.text("("), body, f.text(")")])
            }
        } else if is_true(left) {
            f.concat(&[f.text("<-["), body, f.text("]-")])
        } else if is_true(right) {
            f.concat(&[f.text("-["), body, f.text("]->")])
        } else if is_true(any) {
            f.concat(&[f.text("-["), body, f.text("]-")])
        } else {
            return self.format_unimplemented(node);
        };
        match quantifier {
            Some(quantifier) => f.concat(&[result, self.reg(quantifier)]),
            None => result,
        }
    }

    pub(super) fn format_graph_quantifier(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [lower, upper, fixed] = attrs!(self.children(node), [K::SQL_GRAPH_QUANTIFIER_LOWER, K::SQL_GRAPH_QUANTIFIER_UPPER, K::SQL_GRAPH_QUANTIFIER_FIXED]);
        if is_true(fixed) {
            let Some(lower) = lower else { return self.format_unimplemented(node) };
            return f.concat(&[f.text("{"), self.reg(lower), f.text("}")]);
        }
        let lower_reg = lower.map(|l| self.reg(l)).unwrap_or(0);
        let upper_reg = upper.map(|u| self.reg(u)).unwrap_or(0);
        f.concat(&[f.text("{"), lower_reg, f.text(","), upper_reg, f.text("}")])
    }

    pub(super) fn format_graph_label_expression(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [label, wildcard, negated, left, right, disjunction] = attrs!(self.children(node), [
                K::SQL_GRAPH_LABEL_EXPRESSION_LABEL,
                K::SQL_GRAPH_LABEL_EXPRESSION_WILDCARD,
                K::SQL_GRAPH_LABEL_EXPRESSION_NEGATED,
                K::SQL_GRAPH_LABEL_EXPRESSION_LEFT,
                K::SQL_GRAPH_LABEL_EXPRESSION_RIGHT,
                K::SQL_GRAPH_LABEL_EXPRESSION_DISJUNCTION,
            ],
        );
        if let Some(label) = label {
            return self.reg(label);
        }
        if is_true(wildcard) {
            return f.text("%");
        }
        if is_true(negated) {
            return match left {
                Some(left) => f.concat(&[f.text("!"), self.reg(left)]),
                None => self.format_unimplemented(node),
            };
        }
        let (Some(left), Some(right)) = (left, right) else { return self.format_unimplemented(node) };
        let op = if is_true(disjunction) { f.text(" | ") } else { f.text(" & ") };
        f.concat(&[self.reg(left), op, self.reg(right)])
    }

    pub(super) fn format_graph_rows(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [per_match, per_step, source, edge, destination] = attrs!(self.children(node), [
                K::SQL_GRAPH_ROWS_PER_MATCH,
                K::SQL_GRAPH_ROWS_PER_STEP,
                K::SQL_GRAPH_ROWS_SOURCE,
                K::SQL_GRAPH_ROWS_EDGE,
                K::SQL_GRAPH_ROWS_DESTINATION,
            ],
        );
        if is_true(per_match) {
            return f.text("one row per match");
        }
        let (Some(source), Some(edge), Some(destination)) = (source, edge, destination) else {
            return self.format_unimplemented(node);
        };
        if !is_true(per_step) {
            return self.format_unimplemented(node);
        }
        let vars = f.concat(&[self.reg(source), f.text(", "), self.reg(edge), f.text(", "), self.reg(destination)]);
        f.concat(&[f.text("one row per step"), f.parenthesized(vars)])
    }
}
