//! Identify constant expressions (`constant_propagation_pass.cc`).
//!
//! Literals, constant interval casts, binary expressions and comparisons over constants, and
//! function calls without modifiers over constants are constant. Finish stores the roots of the
//! constant expression trees.

use super::state::{literal_type, AnalysisState};
use super::types::*;
use dashql_buffers::algebra::{BinaryExpressionFunction, ComparisonFunction};
use dashql_buffers::analyzer::SemanticNodeMarkerType;
use dashql_buffers::parser::{AttributeKey as K, ExpressionOperator as Op, IntervalType as IntervalTypeEnum, NodeType};
use dashql_parser::attrs;
use std::ops::Range;

/// The pass that identifies constant expressions (`ConstantPropagationPass`)
#[derive(Default)]
pub(super) struct ConstantPropagationPass {
    /// The constant expressions, stored as roots during Finish
    constants: Vec<ExprId>,
}

/// `AnalysisState::ReadBinaryExpressionFunction`
fn binary_function(op: Op) -> BinaryExpressionFunction {
    match op {
        Op::PLUS => BinaryExpressionFunction::PLUS,
        Op::MINUS => BinaryExpressionFunction::MINUS,
        Op::MULTIPLY => BinaryExpressionFunction::MULTIPLY,
        Op::DIVIDE => BinaryExpressionFunction::DIVIDE,
        Op::MODULUS => BinaryExpressionFunction::MODULUS,
        Op::XOR => BinaryExpressionFunction::XOR,
        _ => BinaryExpressionFunction::UNKNOWN,
    }
}

/// `AnalysisState::ReadComparisonFunction`
fn comparison_function(op: Op) -> ComparisonFunction {
    match op {
        Op::EQUAL => ComparisonFunction::EQUAL,
        Op::NOT_EQUAL => ComparisonFunction::NOT_EQUAL,
        Op::LESS_EQUAL => ComparisonFunction::LESS_EQUAL,
        Op::LESS_THAN => ComparisonFunction::LESS_THAN,
        Op::GREATER_EQUAL => ComparisonFunction::GREATER_EQUAL,
        Op::GREATER_THAN => ComparisonFunction::GREATER_THAN,
        _ => ComparisonFunction::UNKNOWN,
    }
}

impl ConstantPropagationPass {
    /// The constant expression of a node
    fn constant_of(state: &AnalysisState, node_id: u32) -> Option<ExprId> {
        state.expression_of(node_id).filter(|&e| state.out.expressions[e as usize].is_constant_expression)
    }

    fn add_constant(&mut self, state: &mut AnalysisState, node_id: u32, inner: ExpressionInner, marker: SemanticNodeMarkerType) {
        let span = *state.ast[node_id as usize].symbol_span();
        let expr = state.add_expression(node_id, span, inner);
        state.out.expressions[expr as usize].is_constant_expression = true;
        state.expression_index[node_id as usize] = Some(expr);
        state.mark(node_id, marker);
        self.constants.push(expr);
    }

    pub fn visit(&mut self, state: &mut AnalysisState, morsel: Range<usize>) {
        for node_id in morsel {
            let node = &state.ast[node_id];
            let node_id = node_id as u32;
            match node.node_type() {
                // Base case, literals
                NodeType::LITERAL_FLOAT
                | NodeType::LITERAL_INTEGER
                | NodeType::LITERAL_INTERVAL
                | NodeType::LITERAL_NULL
                | NodeType::LITERAL_STRING => {
                    let raw_value = state.text_span(*node.symbol_span());
                    let inner = ExpressionInner::Literal(Literal {
                        literal_type: literal_type(node.node_type()),
                        raw_value,
                    });
                    // The literal node types share the values of the semantic markers
                    let marker = SemanticNodeMarkerType(node.node_type().0 as u8);
                    self.add_constant(state, node_id, inner, marker);
                }
                // interval '30 days'
                NodeType::OBJECT_SQL_CONST_INTERVAL_CAST => {
                    let [value, interval] = attrs!(state.children(node), [K::SQL_CONST_CAST_VALUE, K::SQL_CONST_CAST_INTERVAL]);
                    let Some(value) = value else { continue };
                    let Some(value_expr) = Self::constant_of(state, state.node_id(value)) else { continue };
                    let mut cast = ConstIntervalCast {
                        value_expression_id: value_expr,
                        interval: None,
                    };
                    if let Some(interval) = interval {
                        let [type_attr, precision] =
                            attrs!(state.children(interval), [K::SQL_INTERVAL_TYPE, K::SQL_INTERVAL_PRECISION]);
                        let interval_type =
                            IntervalTypeEnum(type_attr.map(|t| t.children_begin_or_value()).unwrap_or(0) as _);
                        let precision_expression =
                            precision.and_then(|p| state.expression_of(state.node_id(p))).map(|e| e as i32);
                        cast.interval = Some(IntervalType {
                            interval_type,
                            precision_expression,
                        });
                    }
                    self.add_constant(
                        state,
                        node_id,
                        ExpressionInner::ConstIntervalCast(cast),
                        SemanticNodeMarkerType::CONSTANT_EXPRESSION,
                    );
                }
                // N-ary expressions
                NodeType::OBJECT_SQL_NARY_EXPRESSION => {
                    let [op_node, args_node] = attrs!(state.children(node), [K::SQL_EXPRESSION_OPERATOR, K::SQL_EXPRESSION_ARGS]);
                    let Some(op_node) = op_node.filter(|n| n.node_type() == NodeType::ENUM_SQL_EXPRESSION_OPERATOR) else {
                        continue;
                    };
                    // Are all arguments constant?
                    let args = args_node.map(|a| state.children(a)).unwrap_or(&[]);
                    let mut const_args = Vec::with_capacity(args.len());
                    for arg in args {
                        match Self::constant_of(state, state.node_id(arg)) {
                            Some(e) => const_args.push(e),
                            None => break,
                        }
                    }
                    if const_args.len() != args.len() || const_args.len() != 2 {
                        continue;
                    }
                    let op = Op(op_node.children_begin_or_value() as _);
                    let inner = match op {
                        Op::PLUS | Op::MINUS | Op::MULTIPLY | Op::DIVIDE | Op::MODULUS | Op::XOR | Op::AND | Op::OR => {
                            ExpressionInner::BinaryExpression(BinaryExpression {
                                func: binary_function(op),
                                left_expression_id: const_args[0],
                                right_expression_id: const_args[1],
                            })
                        }
                        Op::EQUAL | Op::NOT_EQUAL | Op::LESS_THAN | Op::LESS_EQUAL | Op::GREATER_THAN | Op::GREATER_EQUAL => {
                            ExpressionInner::Comparison(Comparison {
                                func: comparison_function(op),
                                left_expression_id: const_args[0],
                                right_expression_id: const_args[1],
                            })
                        }
                        _ => continue,
                    };
                    self.add_constant(state, node_id, inner, SemanticNodeMarkerType::CONSTANT_EXPRESSION);
                }
                // Function calls
                NodeType::OBJECT_SQL_FUNCTION_EXPRESSION => {
                    let Some(expr_id) = state.expression_of(node_id) else { continue };
                    let ExpressionInner::FunctionCall(call) = &state.out.expressions[expr_id as usize].inner else {
                        continue;
                    };
                    // Skip functions with any modifiers
                    if call.function_call_modifiers != 0 {
                        continue;
                    }
                    match call.arguments {
                        // Constant, but not stored as a root
                        FunctionArguments::None => {
                            state.out.expressions[expr_id as usize].is_constant_expression = true;
                        }
                        FunctionArguments::Generic { begin, count } => {
                            let mut is_constant = true;
                            for i in begin..begin + count {
                                let value_node = state.out.function_arguments[i as usize].value_ast_node_id;
                                match state.expression_of(value_node) {
                                    None => {
                                        is_constant = false;
                                        break;
                                    }
                                    Some(arg_expr) => {
                                        state.out.function_arguments[i as usize].expression_id = Some(arg_expr);
                                        is_constant &= state.out.expressions[arg_expr as usize].is_constant_expression;
                                    }
                                }
                            }
                            state.out.expressions[expr_id as usize].is_constant_expression = is_constant;
                            if is_constant {
                                self.constants.push(expr_id);
                                state.mark(node_id, SemanticNodeMarkerType::CONSTANT_EXPRESSION);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    pub fn finish(&mut self, state: &mut AnalysisState) {
        for &expr_id in &self.constants {
            let node_id = state.out.expressions[expr_id as usize].ast_node_id;
            let node = &state.ast[node_id as usize];
            // Only store the roots of constant expression trees
            let parent = state.expression_of(node.parent());
            if parent.is_some_and(|p| state.out.expressions[p as usize].is_constant_expression) {
                continue;
            }
            // If object, mark as constant expression root
            if node.node_type().0 >= NodeType::OBJECT_KEYS_.0 {
                state.mark(node_id, SemanticNodeMarkerType::CONSTANT_EXPRESSION_ROOT);
            }
            state.out.constant_expressions.push(ConstantExpression { root: expr_id });
        }
    }
}
