//! EXPLAIN statements (`formatter/formatter_explain.cc`).

use super::{FmtReg, Formatter, FormattingJoinPolicy, K};
use dashql_buffers::parser::Node;

impl<'a> Formatter<'a> {
    pub(super) fn format_explain(&self, node_id: usize) -> FmtReg {
        let f = &self.fmt;
        let node: &'a Node = &self.ast[node_id];
        let [statement, options] = self.attrs(node, [K::EXT_EXPLAIN_STATEMENT, K::EXT_EXPLAIN_OPTIONS]);
        let Some(statement) = statement else { return self.format_unimplemented(node) };
        let stmt_reg = self.reg(statement);
        if stmt_reg == 0 {
            return self.format_unimplemented(node);
        }
        if let Some(options) = options.filter(|o| o.children_count() > 0) {
            let options_reg = self.reg(options);
            if options_reg == 0 {
                return self.format_unimplemented(node);
            }
            let header = f.concat(&[f.text("explain "), f.parenthesized(options_reg)]);
            return self.space_join(&[header, stmt_reg], FormattingJoinPolicy::ForceBreak, false);
        }
        f.concat(&[f.text("explain "), stmt_reg])
    }

    pub(super) fn format_explain_expressions(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [expressions] = self.attrs(node, [K::EXT_EXPLAIN_EXPRESSIONS]);
        let Some(expressions) = expressions else { return self.format_unimplemented(node) };
        let expressions_reg = self.reg(expressions);
        if expressions_reg == 0 {
            return self.format_unimplemented(node);
        }
        f.concat(&[f.text("expressions "), f.parenthesized(expressions_reg)])
    }
}
