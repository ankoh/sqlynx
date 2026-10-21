//! Runs the calculator grammar (tests/calc.y) through the Rust table skeleton with actions.
//!
//! The driver below is a minimal LALR(1) loop without LAC or error recovery. It only checks
//! that the emitted tables, symbol kinds and `reduce` dispatch fit together; the real driver
//! is a port of the C++ `DriveLALR`.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Location {
    pub offset: u32,
    pub length: u32,
}

impl Location {
    fn span(first: Location, last: Location) -> Location {
        Location {
            offset: first.offset,
            length: last.offset + last.length - first.offset,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Value {
    None,
    Int(i64),
}

impl From<()> for Value {
    fn from(_: ()) -> Self {
        Value::None
    }
}

impl From<i64> for Value {
    fn from(v: i64) -> Self {
        Value::Int(v)
    }
}

pub trait FromValue: Sized {
    fn from_value(v: Value) -> Self;
}

impl FromValue for i64 {
    fn from_value(v: Value) -> Self {
        match v {
            Value::Int(v) => v,
            other => panic!("expected an integer, got {other:?}"),
        }
    }
}

pub trait ReduceStack {
    fn value_at(&self, i: usize) -> Value;
    fn location_at(&self, i: usize) -> Location;
}

#[derive(Debug, PartialEq)]
pub enum ReduceError {
    DivisionByZero(Location),
}

#[derive(Default)]
pub struct ParseContext {
    pub result: Option<(i64, Location)>,
}

#[allow(dead_code, non_upper_case_globals, unused_braces, unused_parens, unused_variables)]
#[path = "calc_tables.rs"]
mod calc;

use calc::symbol_kind::*;

struct Stack {
    states: Vec<i32>,
    values: Vec<Value>,
    locations: Vec<Location>,
}

impl ReduceStack for Stack {
    fn value_at(&self, i: usize) -> Value {
        self.values[self.values.len() - 1 - i]
    }
    fn location_at(&self, i: usize) -> Location {
        self.locations[self.locations.len() - 1 - i]
    }
}

#[derive(Debug, PartialEq)]
enum ParseError {
    Syntax(Location),
    Action(ReduceError),
}

fn parse(input: &[(u16, Value)]) -> Result<(i64, Location), ParseError> {
    let mut tokens = input
        .iter()
        .enumerate()
        .map(|(i, &(kind, value))| (kind, value, Location { offset: i as u32, length: 1 }))
        .chain(std::iter::once((S_YYEOF, Value::None, Location { offset: input.len() as u32, length: 0 })));
    let mut ctx = ParseContext::default();
    let mut stack = Stack { states: vec![0], values: vec![Value::None], locations: vec![Location::default()] };
    let mut lookahead = tokens.next().unwrap();

    loop {
        let state = *stack.states.last().unwrap();
        if state == calc::YYFINAL {
            return ctx.result.ok_or(ParseError::Syntax(lookahead.2));
        }
        // Decide between shift, reduce, and error.
        let pact = calc::YYPACT[state as usize] as i32;
        let mut rule = None;
        if pact != calc::YYPACT_NINF {
            let i = pact + lookahead.0 as i32;
            if (0..=calc::YYLAST).contains(&i) && calc::YYCHECK[i as usize] as i32 == lookahead.0 as i32 {
                let action = calc::YYTABLE[i as usize] as i32;
                if action > 0 {
                    stack.states.push(action);
                    stack.values.push(lookahead.1);
                    stack.locations.push(lookahead.2);
                    if lookahead.0 != S_YYEOF {
                        lookahead = tokens.next().unwrap();
                    }
                    continue;
                }
                if action == calc::YYTABLE_NINF {
                    return Err(ParseError::Syntax(lookahead.2));
                }
                rule = Some(-action as usize);
            }
        }
        let rule = match rule {
            Some(rule) => rule,
            None => match calc::YYDEFACT[state as usize] as usize {
                0 => return Err(ParseError::Syntax(lookahead.2)),
                rule => rule,
            },
        };

        // Reduce.
        let len = calc::YYR2[rule] as usize;
        let location = if len > 0 {
            Location::span(stack.location_at(len - 1), stack.location_at(0))
        } else {
            let prev = stack.location_at(0);
            Location { offset: prev.offset + prev.length, length: 0 }
        };
        let value = match calc::reduce(&mut ctx, rule, &stack, location).map_err(ParseError::Action)? {
            Some(value) => value,
            None if len > 0 => stack.value_at(len - 1),
            None => Value::None,
        };
        for _ in 0..len {
            stack.states.pop();
            stack.values.pop();
            stack.locations.pop();
        }
        let lhs = calc::YYR1[rule] as usize - calc::YYNTOKENS;
        let top = *stack.states.last().unwrap();
        let goto = calc::YYPGOTO[lhs] as i32 + top;
        let next = if (0..=calc::YYLAST).contains(&goto) && calc::YYCHECK[goto as usize] as i32 == top {
            calc::YYTABLE[goto as usize] as i32
        } else {
            calc::YYDEFGOTO[lhs] as i32
        };
        stack.states.push(next);
        stack.values.push(value);
        stack.locations.push(location);
    }
}

fn num(v: i64) -> (u16, Value) {
    (S_NUM, Value::Int(v))
}

fn op(kind: u16) -> (u16, Value) {
    (kind, Value::None)
}

#[test]
fn evaluates_with_precedence() {
    // 1 + 2 * 3
    let input = [num(1), op(S_PLUS), num(2), op(S_STAR), num(3)];
    assert_eq!(parse(&input), Ok((7, Location { offset: 0, length: 5 })));
}

#[test]
fn evaluates_left_associative() {
    // 2 - 3 - 4
    let input = [num(2), op(S_MINUS), num(3), op(S_MINUS), num(4)];
    assert_eq!(parse(&input).map(|r| r.0), Ok(-5));
}

#[test]
fn evaluates_parentheses_and_unary_minus() {
    // -(2 - 3) * 4
    let input = [op(S_MINUS), op(S_LRB), num(2), op(S_MINUS), num(3), op(S_RRB), op(S_STAR), num(4)];
    assert_eq!(parse(&input).map(|r| r.0), Ok(4));
}

#[test]
fn action_errors_carry_locations() {
    // 1 / (2 - 2)
    let input = [num(1), op(S_SLASH), op(S_LRB), num(2), op(S_MINUS), num(2), op(S_RRB)];
    assert_eq!(
        parse(&input),
        Err(ParseError::Action(ReduceError::DivisionByZero(Location { offset: 2, length: 5 })))
    );
}

#[test]
fn syntax_errors() {
    // 1 + * 2
    let input = [num(1), op(S_PLUS), op(S_STAR), num(2)];
    assert_eq!(parse(&input), Err(ParseError::Syntax(Location { offset: 2, length: 1 })));
}

#[test]
fn symbol_names() {
    assert_eq!(calc::YYTNAME[S_NUM as usize], "\"number\"");
    assert_eq!(calc::YYTNAME[S_PLUS as usize], "PLUS");
}
