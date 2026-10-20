//! SELECT statements (`formatter/formatter_select.cc`).

use super::{FmtReg, Formatter, FormattingJoinPolicy, K};
use dashql_buffers::formatting::FormattingMode;
use dashql_buffers::parser::{CombineModifier, CombineOperation, Node, NodeType};

impl<'a> Formatter<'a> {
    pub(super) fn format_select(&self, node_id: usize) -> FmtReg {
        let f = &self.fmt;
        let node: &'a Node = &self.ast[node_id];
        #[rustfmt::skip]
        let [
            select_all, select_distinct, select_targets, select_into, select_from, select_where, select_groups,
            select_having, select_windows, select_order, select_row_locking, select_with_ctes, select_with_recursive,
            select_offset, select_limit, select_limit_all, select_sample, select_values, select_table,
            combine_operation, combine_modifier, combine_input, select_statement,
        ] = self.attrs(
            node,
            [
                K::SQL_SELECT_ALL,
                K::SQL_SELECT_DISTINCT,
                K::SQL_SELECT_TARGETS,
                K::SQL_SELECT_INTO,
                K::SQL_SELECT_FROM,
                K::SQL_SELECT_WHERE,
                K::SQL_SELECT_GROUPS,
                K::SQL_SELECT_HAVING,
                K::SQL_SELECT_WINDOWS,
                K::SQL_SELECT_ORDER,
                K::SQL_SELECT_ROW_LOCKING,
                K::SQL_SELECT_WITH_CTES,
                K::SQL_SELECT_WITH_RECURSIVE,
                K::SQL_SELECT_OFFSET,
                K::SQL_SELECT_LIMIT,
                K::SQL_SELECT_LIMIT_ALL,
                K::SQL_SELECT_SAMPLE,
                K::SQL_SELECT_VALUES,
                K::SQL_SELECT_TABLE,
                K::SQL_COMBINE_OPERATION,
                K::SQL_COMBINE_MODIFIER,
                K::SQL_COMBINE_INPUT,
                K::SQL_SELECT_EXPRESSION_STATEMENT,
            ],
        );

        let mut query = 0;
        if let Some(select_statement) = select_statement {
            query = self.reg(select_statement);
            if query == 0 {
                return self.format_unimplemented(node);
            }
        }
        if let (Some(combine_operation), Some(combine_input)) = (combine_operation, combine_input) {
            let op_text = match CombineOperation(super::value_u8(combine_operation)) {
                CombineOperation::UNION => "union",
                CombineOperation::INTERSECT => "intersect",
                CombineOperation::EXCEPT => "except",
                _ => return self.format_unimplemented(node),
            };
            let mod_text = match combine_modifier.map(|m| CombineModifier(super::value_u8(m))) {
                Some(CombineModifier::ALL) => " all",
                Some(CombineModifier::DISTINCT) => " distinct",
                _ => "",
            };
            let op_reg =
                if mod_text.is_empty() { f.text(op_text) } else { f.concat(&[f.text(op_text), f.text(mod_text)]) };
            let separator = f.concat(&[f.text(" "), op_reg, f.text(" ")]);
            let break_separator = f.concat(&[f.break_(), op_reg, f.break_()]);
            let inputs = self.array_regs(combine_input);
            if inputs.iter().any(|&i| i == 0) {
                return self.format_unimplemented(node);
            }
            query = f.join(&inputs, separator, break_separator, Some(FormattingJoinPolicy::BreakAllOrNone), false);
        }

        if query == 0 {
            let mut clauses = Vec::with_capacity(12);
            if let Some(select_values) = select_values {
                let values_reg = self.reg(select_values);
                if values_reg == 0 {
                    return self.format_unimplemented(node);
                }
                if self.config.mode == FormattingMode::PRETTY {
                    clauses.push(f.concat(&[f.text("values"), f.indented(f.concat(&[f.break_(), values_reg]))]));
                } else {
                    clauses.push(f.concat(&[f.text("values "), values_reg]));
                }
            }
            if let Some(select_table) = select_table {
                let table_reg = self.reg(select_table);
                if table_reg == 0 {
                    return self.format_unimplemented(select_table);
                }
                clauses.push(f.concat(&[f.text("table "), table_reg]));
            }
            if let Some(select_targets) = select_targets {
                let body = self.reg(select_targets);
                match select_distinct.filter(|d| d.node_type() == NodeType::ARRAY) {
                    Some(select_distinct) if select_distinct.children_count() > 0 => {
                        let on_cols = self.reg(select_distinct);
                        clauses.push(f.concat(&[
                            f.text("select distinct on "),
                            f.parenthesized(on_cols),
                            f.text(" "),
                            body,
                        ]));
                    }
                    Some(_) => clauses.push(f.concat(&[f.text("select distinct "), body])),
                    None if select_all.is_some() => clauses.push(f.concat(&[f.text("select all "), body])),
                    None => clauses.push(f.concat(&[f.text("select "), body])),
                }
            }
            if let Some(select_into) = select_into {
                let body = self.reg(select_into);
                if body == 0 {
                    return self.format_unimplemented(node);
                }
                clauses.push(body);
            }
            if let Some(select_from) = select_from {
                clauses.push(f.concat(&[f.text("from "), self.reg(select_from)]));
            }
            if let Some(select_where) = select_where {
                clauses.push(f.concat(&[f.text("where "), self.reg(select_where)]));
            }
            if let Some(select_groups) = select_groups {
                clauses.push(f.concat(&[f.text("group by "), self.reg(select_groups)]));
            }
            if let Some(select_having) = select_having {
                clauses.push(f.concat(&[f.text("having "), self.reg(select_having)]));
            }
            if let Some(select_windows) = select_windows {
                let body = self.reg(select_windows);
                if body == 0 {
                    return self.format_unimplemented(node);
                }
                clauses.push(f.concat(&[f.text("window "), body]));
            }
            if let Some(select_sample) = select_sample {
                let body = self.reg(select_sample);
                if body == 0 {
                    return self.format_unimplemented(node);
                }
                clauses.push(body);
            }
            if let Some(select_order) = select_order {
                clauses.push(f.concat(&[f.text("order by "), self.reg(select_order)]));
            }
            if select_limit_all.is_some() {
                clauses.push(f.text("limit all"));
            } else if let Some(select_limit) = select_limit {
                let mut body = self.reg(select_limit);
                if select_limit.node_type() == NodeType::BOOL && select_limit.children_begin_or_value() != 0 {
                    body = f.text("1");
                }
                clauses.push(f.concat(&[f.text("limit "), body]));
            }
            if let Some(select_offset) = select_offset {
                clauses.push(f.concat(&[f.text("offset "), self.reg(select_offset)]));
            }
            if let Some(select_row_locking) = select_row_locking {
                let body = self.reg(select_row_locking);
                if body == 0 {
                    return self.format_unimplemented(node);
                }
                clauses.push(body);
            }

            if clauses.is_empty() {
                return self.format_unimplemented(node);
            }
            let clause_policy = self.pretty_policy(FormattingJoinPolicy::BreakAllOrNone);
            query = self.space_join(&clauses, clause_policy, false);
        }

        if let Some(select_with_ctes) = select_with_ctes {
            let cte_children = self.array_regs(select_with_ctes);
            let mut cte_regs = Vec::with_capacity(cte_children.len() * 2);
            for (i, &cte) in cte_children.iter().enumerate() {
                if i > 0 {
                    cte_regs.push(f.text(", "));
                }
                cte_regs.push(cte);
            }
            let ctes = f.concat(&cte_regs);
            let keyword = if select_with_recursive.is_some() { "with recursive " } else { "with " };
            let with_clause = f.concat(&[f.text(keyword), ctes]);
            let with_policy = self.pretty_policy(FormattingJoinPolicy::BreakAllOrNone);
            query = self.space_join(&[with_clause, query], with_policy, false);
        }
        query
    }
}
