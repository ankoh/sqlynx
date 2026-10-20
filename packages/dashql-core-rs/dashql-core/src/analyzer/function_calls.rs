//! Identify function calls (`identify_function_calls_pass.cc`).

use super::state::AnalysisState;
use super::types::*;
use crate::error::{Error, Result};
use dashql_buffers::algebra::FunctionCallModifier;
use dashql_buffers::parser::{AttributeKey as K, KnownFunction, NodeType};
use dashql_grammar::attrs;
use std::ops::Range;

pub(super) fn visit(state: &mut AnalysisState, morsel: Range<usize>) -> Result<()> {
    for node_id in morsel {
        let node = &state.ast[node_id];
        if node.node_type() != NodeType::OBJECT_SQL_FUNCTION_EXPRESSION {
            continue;
        }
        let [star, all, distinct, variadic, over, within_group, name, args] = attrs!(state.children(node), [
            K::SQL_FUNCTION_ARGUMENTS_STAR,
            K::SQL_FUNCTION_ALL,
            K::SQL_FUNCTION_DISTINCT,
            K::SQL_FUNCTION_VARIADIC,
            K::SQL_FUNCTION_OVER,
            K::SQL_FUNCTION_WITHIN_GROUP,
            K::SQL_FUNCTION_NAME,
            K::SQL_FUNCTION_ARGUMENTS,
        ]);
        let mut modifiers = 0u8;
        for (attr, modifier) in [
            (star, FunctionCallModifier::ARGS_STAR),
            (all, FunctionCallModifier::ARGS_ALL),
            (distinct, FunctionCallModifier::ARGS_DISTINCT),
            (variadic, FunctionCallModifier::VARIADIC),
            (over, FunctionCallModifier::OVER),
            (within_group, FunctionCallModifier::WITHIN_GROUP),
        ] {
            if attr.is_some() {
                modifiers |= modifier.0;
            }
        }
        // The parser always emits a function name
        let mut function_name = FunctionName::Known(KnownFunction::CURRENT_TIME);
        if let Some(name) = name {
            match name.node_type() {
                NodeType::ENUM_SQL_KNOWN_FUNCTION => {
                    function_name = FunctionName::Known(KnownFunction(name.children_begin_or_value() as u8));
                }
                NodeType::ARRAY => match state.read_qualified_function_name(Some(name)) {
                    Some(qualified) => function_name = FunctionName::Qualified(qualified),
                    // The C++ pass calls `value()` on the empty optional and throws
                    None => return Err(Error::invalid_argument("bad optional access")),
                },
                _ => {}
            }
        }
        let mut arguments = FunctionArguments::None;
        if let Some(args) = args {
            let begin = state.out.function_arguments.len() as u32;
            let count = args.children_count();
            for i in 0..count {
                let arg_node_id = args.children_begin_or_value() + i;
                let mut arg = FunctionArgument {
                    ast_node_id: arg_node_id,
                    ..Default::default()
                };
                let arg_node = &state.ast[arg_node_id as usize];
                if arg_node.node_type() != NodeType::OBJECT_SQL_FUNCTION_ARG {
                    arg.value_ast_node_id = arg_node_id;
                    state.out.function_arguments.push(arg);
                    continue;
                }
                let [value, name] = attrs!(state.children(arg_node), [K::SQL_FUNCTION_ARG_VALUE, K::SQL_FUNCTION_ARG_NAME]);
                match value {
                    // Error recovery can leave an incomplete function argument
                    None => arg.value_ast_node_id = arg_node_id,
                    Some(value) => {
                        arg.value_ast_node_id = state.node_id(value);
                        if let Some(name) = name {
                            arg.name = Some(state.node_name(name));
                        }
                    }
                }
                state.out.function_arguments.push(arg);
            }
            arguments = FunctionArguments::Generic { begin, count };
        }
        let call = FunctionCall {
            function_name,
            function_call_modifiers: modifiers,
            arguments,
        };
        let span = *node.symbol_span();
        let expr = state.add_expression(node_id as u32, span, ExpressionInner::FunctionCall(call));
        state.expression_index[node_id] = Some(expr);
    }
    Ok(())
}
