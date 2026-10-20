//! DELETE statements (`formatter/formatter_delete.cc`).

use super::{FmtReg, Formatter, FormattingJoinPolicy, K};
use dashql_buffers::parser::Node;

impl<'a> Formatter<'a> {
    pub(super) fn format_delete(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [target, using_clause, where_clause, returning, with_ctes, with_recursive] = self.attrs(
            node,
            [
                K::SQL_DELETE_TARGET,
                K::SQL_DELETE_USING,
                K::SQL_DELETE_WHERE,
                K::SQL_DELETE_RETURNING,
                K::SQL_SELECT_WITH_CTES,
                K::SQL_SELECT_WITH_RECURSIVE,
            ],
        );
        let Some(target) = target.filter(|t| self.reg(t) != 0) else { return self.format_unimplemented(node) };

        let mut clauses = Vec::new();
        if let Some(with_ctes) = with_ctes {
            if self.reg(with_ctes) == 0 {
                return self.format_unimplemented(with_ctes);
            }
            let keyword = if with_recursive.is_some() { "with recursive " } else { "with " };
            clauses.push(f.concat(&[f.text(keyword), self.reg(with_ctes)]));
        }
        clauses.push(f.concat(&[f.text("delete from "), self.reg(target)]));
        for (child, keyword) in [(using_clause, "using "), (where_clause, "where "), (returning, "returning ")] {
            let Some(child) = child else { continue };
            if self.reg(child) == 0 {
                return self.format_unimplemented(child);
            }
            clauses.push(f.concat(&[f.text(keyword), self.reg(child)]));
        }
        let policy = self.pretty_policy(FormattingJoinPolicy::BreakAllOrNone);
        self.space_join(&clauses, policy, false)
    }
}
