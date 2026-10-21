//! INSERT statements (`formatter/formatter_insert.cc`).

use dashql_parser::attrs;
use super::{FmtReg, Formatter, FormattingJoinPolicy, K};
use dashql_buffers::parser::{Node, NodeType};

impl<'a> Formatter<'a> {
    pub(super) fn format_insert(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [target, columns, source, default_values, returning, with_ctes, with_recursive] = attrs!(self.children(node), [
                K::SQL_INSERT_TARGET,
                K::SQL_INSERT_COLUMNS,
                K::SQL_INSERT_SOURCE,
                K::SQL_INSERT_DEFAULT_VALUES,
                K::SQL_INSERT_RETURNING,
                K::SQL_SELECT_WITH_CTES,
                K::SQL_SELECT_WITH_RECURSIVE,
            ],
        );
        let Some(target) = target else { return self.format_unimplemented(node) };
        if source.is_none() == default_values.is_none() {
            return self.format_unimplemented(node);
        }
        let target_reg = self.reg(target);
        if target_reg == 0 {
            return self.format_unimplemented(target);
        }

        let mut clauses = Vec::new();
        let mut header = f.concat(&[f.text("insert into "), target_reg]);
        if let Some(columns) = columns.filter(|c| c.node_type() == NodeType::ARRAY && c.children_count() > 0) {
            let columns_reg = self.reg(columns);
            if columns_reg == 0 {
                return self.format_unimplemented(columns);
            }
            header = f.concat(&[header, f.parenthesized(columns_reg)]);
        }
        clauses.push(header);

        if let Some(source) = source {
            let source_reg = self.reg(source);
            if source_reg == 0 {
                return self.format_unimplemented(source);
            }
            clauses.push(source_reg);
        } else {
            clauses.push(f.text("default values"));
        }

        if let Some(returning) = returning.filter(|r| r.node_type() == NodeType::ARRAY && r.children_count() > 0) {
            let returning_reg = self.reg(returning);
            if returning_reg == 0 {
                return self.format_unimplemented(returning);
            }
            clauses.push(f.concat(&[f.text("returning "), returning_reg]));
        }

        let policy = self.pretty_policy(FormattingJoinPolicy::BreakAllOrNone);
        let mut query = self.space_join(&clauses, policy, false);
        if let Some(with_ctes) = with_ctes {
            let ctes_reg = self.reg(with_ctes);
            if ctes_reg == 0 {
                return self.format_unimplemented(with_ctes);
            }
            let keyword = if with_recursive.is_some() { "with recursive " } else { "with " };
            let with_clause = f.concat(&[f.text(keyword), ctes_reg]);
            query = self.space_join(&[with_clause, query], policy, false);
        }
        query
    }
}
