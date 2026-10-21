//! CREATE, DROP, ATTACH and SET statements (`formatter/formatter_create.cc`).

use dashql_grammar::attrs;
use super::{FmtReg, Formatter, FormattingJoinPolicy, K};
use dashql_buffers::parser::{Node, NodeType, OnCommitOption, TempType};

impl<'a> Formatter<'a> {
    pub(super) fn format_temp_type(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        match TempType(super::value_u8(node)) {
            TempType::DEFAULT | TempType::LOCAL => f.text("temporary"),
            TempType::GLOBAL => f.text("global temporary"),
            TempType::UNLOGGED => f.text("unlogged"),
            TempType::NONE => f.empty(),
            _ => self.format_unimplemented(node),
        }
    }

    pub(super) fn format_on_commit_option(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        match OnCommitOption(super::value_u8(node)) {
            OnCommitOption::DROP => f.text("on commit drop"),
            OnCommitOption::DELETE_ROWS => f.text("on commit delete rows"),
            OnCommitOption::PRESERVE_ROWS => f.text("on commit preserve rows"),
            OnCommitOption::NOOP => f.empty(),
            _ => self.format_unimplemented(node),
        }
    }

    pub(super) fn format_create(&self, node_id: usize) -> FmtReg {
        let f = &self.fmt;
        let node: &'a Node = &self.ast[node_id];
        if !self.node_states[node_id].is_statement_root {
            return self.format_unimplemented(node);
        }
        let [name, elements, if_not_exists, temp, on_commit] = attrs!(self.children(node), [
                K::SQL_CREATE_TABLE_NAME,
                K::SQL_CREATE_TABLE_ELEMENTS,
                K::SQL_CREATE_TABLE_IF_NOT_EXISTS,
                K::SQL_CREATE_TABLE_TEMP,
                K::SQL_CREATE_TABLE_ON_COMMIT,
            ],
        );
        let (Some(name), Some(elements)) = (name, elements) else { return self.format_unimplemented(node) };

        let mut header_parts = vec![f.text("create ")];
        if let Some(temp) = temp {
            header_parts.push(self.reg(temp));
            header_parts.push(f.text(" "));
        }
        header_parts.push(f.text("table "));
        if if_not_exists.is_some() {
            header_parts.push(f.text("if not exists "));
        }
        header_parts.push(self.reg(name));
        let header = f.concat(&header_parts);

        let mut table_elements = f.empty();
        if elements.children_count() > 0 {
            let mut parts = Vec::with_capacity(elements.children_count() as usize);
            for element in self.children(elements) {
                let reg = self.reg(element);
                if reg == 0 {
                    return self.format_unimplemented(node);
                }
                parts.push(reg);
            }
            let (inline_separator, break_separator) = self.comma_separators();
            table_elements = f.join(&parts, inline_separator, break_separator, None, false);
        }

        let element_block = if elements.children_count() > 0 { f.parenthesized(table_elements) } else { f.text("()") };
        let mut statement = f.concat(&[header, f.text(" "), element_block]);
        if let Some(on_commit) = on_commit {
            statement = f.concat(&[statement, f.text(" "), self.reg(on_commit)]);
        }
        statement
    }

    pub(super) fn format_create_as(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [name, columns, if_not_exists, temp, statement, with_data, on_commit] = attrs!(self.children(node), [
                K::SQL_CREATE_AS_NAME,
                K::SQL_CREATE_AS_COLUMNS,
                K::SQL_CREATE_AS_IF_NOT_EXISTS,
                K::SQL_CREATE_AS_TEMP,
                K::SQL_CREATE_AS_STATEMENT,
                K::SQL_CREATE_AS_WITH_DATA,
                K::SQL_CREATE_AS_ON_COMMIT,
            ],
        );
        let (Some(name), Some(statement)) = (name, statement) else { return self.format_unimplemented(node) };

        let mut parts = vec![f.text("create ")];
        if let Some(temp) = temp {
            parts.push(self.reg(temp));
            parts.push(f.text(" "));
        }
        parts.push(f.text("table "));
        if if_not_exists.is_some() {
            parts.push(f.text("if not exists "));
        }
        parts.push(self.reg(name));
        if let Some(columns) = columns.filter(|c| c.children_count() > 0) {
            parts.push(f.parenthesized(self.reg(columns)));
        }
        if let Some(on_commit) = on_commit {
            parts.push(f.text(" "));
            parts.push(self.reg(on_commit));
        }
        parts.push(f.text(" as "));
        parts.push(self.reg(statement));
        if let Some(with_data) = with_data {
            let include_data = with_data.node_type() == NodeType::BOOL && with_data.children_begin_or_value() != 0;
            parts.push(f.text(if include_data { " with data" } else { " with no data" }));
        }
        f.concat(&parts)
    }

    pub(super) fn format_view(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [name, columns, or_replace, temp, statement] = attrs!(self.children(node), [K::SQL_VIEW_NAME, K::SQL_VIEW_COLUMNS, K::SQL_VIEW_OR_REPLACE, K::SQL_VIEW_TEMP, K::SQL_VIEW_STATEMENT],
        );
        let (Some(name), Some(statement)) = (name, statement) else { return self.format_unimplemented(node) };

        let mut parts = vec![f.text("create ")];
        if or_replace.is_some() {
            parts.push(f.text("or replace "));
        }
        if let Some(temp) = temp {
            parts.push(self.reg(temp));
            parts.push(f.text(" "));
        }
        parts.push(f.text("view "));
        parts.push(self.reg(name));
        if let Some(columns) = columns.filter(|c| c.children_count() > 0) {
            parts.push(f.parenthesized(self.reg(columns)));
        }
        parts.push(f.text(" as"));
        let header = f.concat(&parts);
        self.space_join(&[header, self.reg(statement)], FormattingJoinPolicy::BreakAllOrNone, false)
    }

    pub(super) fn format_function_param(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [name, type_node] = attrs!(self.children(node), [K::SQL_FUNCTION_PARAM_NAME, K::SQL_FUNCTION_PARAM_TYPE]);
        let (Some(name), Some(type_node)) = (name, type_node) else { return self.format_unimplemented(node) };
        f.concat(&[self.reg(name), f.text(" "), self.reg(type_node)])
    }

    pub(super) fn format_create_function(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [name, params, returns, aggregate] = attrs!(self.children(node), [
                K::SQL_CREATE_FUNCTION_NAME,
                K::SQL_CREATE_FUNCTION_PARAMS,
                K::SQL_CREATE_FUNCTION_RETURNS,
                K::SQL_CREATE_FUNCTION_IS_AGGREGATE,
            ],
        );
        let (Some(name), Some(returns)) = (name, returns) else { return self.format_unimplemented(node) };
        let kind = if aggregate.is_some() { "create aggregate " } else { "create function " };
        let params_reg = params.map(|p| self.reg(p)).unwrap_or(0);
        f.concat(&[f.text(kind), self.reg(name), f.parenthesized(params_reg), f.text(" returns "), self.reg(returns)])
    }

    pub(super) fn format_drop(&self, node: &'a Node, table: bool) -> FmtReg {
        let f = &self.fmt;
        let [name, if_exists] = attrs!(self.children(node), [K::SQL_DROP_NAME, K::SQL_DROP_IF_EXISTS]);
        let Some(name) = name else { return self.format_unimplemented(node) };
        let object = if table { "table " } else { "view " };
        let if_exists_reg = if if_exists.is_some() { f.text("if exists ") } else { f.empty() };
        f.concat(&[f.text("drop "), f.text(object), if_exists_reg, self.reg(name)])
    }

    pub(super) fn format_attach_database_option(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [key, value] = attrs!(self.children(node), [K::SQL_GENERIC_OPTION_KEY, K::SQL_GENERIC_OPTION_VALUE]);
        let (Some(key), Some(value)) = (key, value) else { return self.format_unimplemented(node) };
        f.concat(&[self.reg(key), f.text(" = "), self.reg(value)])
    }

    pub(super) fn format_attach_database(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [path, alias, local, options] = attrs!(self.children(node), [
                K::SQL_ATTACH_DATABASE_PATH,
                K::SQL_ATTACH_DATABASE_ALIAS,
                K::SQL_ATTACH_DATABASE_LOCAL,
                K::SQL_ATTACH_DATABASE_OPTIONS,
            ],
        );
        let (Some(path), Some(alias)) = (path, alias) else { return self.format_unimplemented(node) };
        let mut parts = vec![
            f.text(if local.is_some() { "attach local database " } else { "attach database " }),
            self.reg(path),
            f.text(" as "),
            self.reg(alias),
        ];
        if let Some(options) = options {
            parts.push(f.text(" with "));
            parts.push(f.parenthesized(self.reg(options)));
        }
        f.concat(&parts)
    }

    pub(super) fn format_vararg_field(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [key, value] = attrs!(self.children(node), [K::EXT_VARARG_FIELD_KEY, K::EXT_VARARG_FIELD_VALUE]);
        let (Some(key), Some(value)) = (key, value) else { return self.format_unimplemented(node) };
        f.concat(&[self.reg(key), f.text(" = "), self.reg(value)])
    }

    pub(super) fn format_set(&self, node: &'a Node) -> FmtReg {
        let f = &self.fmt;
        let [varargs] = attrs!(self.children(node), [K::EXT_SET_VARARGS]);
        let Some(varargs) = varargs else { return self.format_unimplemented(node) };
        f.concat(&[f.text("set "), self.reg(varargs)])
    }
}
