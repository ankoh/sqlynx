//! The LALR(1) driver, a port of the `parse()` loop of bison's lalr1.cc skeleton as the C++ core
//! configures it: `parse.lac full`, `parse.error verbose` with the hint of `Parser::yysyntax_error_`,
//! error recovery through the `error` token, and the custom `YYLLOC_DEFAULT` of the former C++
//! prologue.

use super::actions::{ReduceError, ReduceStack};
use super::context::ParseContext;
use super::value::Value;
use crate::scanner::SymbolValue;
use crate::symbol_kind::*;
use crate::tables::*;
use crate::{symbol_name, SymbolKind};
use dashql_buffers::parser::SymbolSpan;

/// A parser state
pub type StateId = i32;

/// The state of `goto` after reducing to `lhs` in `state` (`yy_lr_goto_state_`)
pub fn goto_state(state: StateId, lhs: SymbolKind) -> StateId {
    let nterm = lhs as usize - YYNTOKENS;
    let r = YYPGOTO[nterm] as i32 + state;
    if (0..=YYLAST).contains(&r) && YYCHECK[r as usize] as i32 == state {
        YYTABLE[r as usize] as i32
    } else {
        YYDEFGOTO[nterm] as i32
    }
}

/// The action of a state on a token: `Some(Shift(state))`, `Some(Reduce(rule))`, or `None` for the
/// default action (or an error if the default is to fail).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Shift(StateId),
    Reduce(usize),
    Error,
}

/// The table action of `state` on `token`, `None` if the default action applies
pub fn table_action(state: StateId, token: SymbolKind) -> Option<Action> {
    let pact = YYPACT[state as usize] as i32;
    if pact == YYPACT_NINF {
        return None;
    }
    let i = pact + token as i32;
    if !(0..=YYLAST).contains(&i) || YYCHECK[i as usize] as i32 != token as i32 {
        return None;
    }
    let action = YYTABLE[i as usize] as i32;
    Some(if action > 0 {
        Action::Shift(action)
    } else if action == YYTABLE_NINF {
        Action::Error
    } else {
        Action::Reduce(-action as usize)
    })
}

/// Would the parser eventually shift `token` from the given stack of states? (`yy_lac_check_`)
///
/// Simulates the reductions on a scratch stack, the stack itself is not modified.
pub fn lac_check(states: &[StateId], token: SymbolKind, scratch: &mut Vec<StateId>) -> bool {
    scratch.clear();
    // The number of states popped from `states`
    let mut lac_top = 0;
    loop {
        let top_state = *scratch.last().unwrap_or(&states[states.len() - 1 - lac_top]);
        let rule = match table_action(top_state, token) {
            Some(Action::Shift(_)) => return true,
            Some(Action::Error) => return false,
            Some(Action::Reduce(rule)) => rule,
            None => match YYDEFACT[top_state as usize] as usize {
                0 => return false,
                rule => rule,
            },
        };
        // Pop the right-hand side, first from the scratch stack
        let mut len = YYR2[rule] as usize;
        if len < scratch.len() {
            scratch.truncate(scratch.len() - len);
            len = 0;
        } else if !scratch.is_empty() {
            len -= scratch.len();
            scratch.clear();
        }
        lac_top += len;
        let top_state = *scratch.last().unwrap_or(&states[states.len() - 1 - lac_top]);
        scratch.push(goto_state(top_state, YYR1[rule] as SymbolKind));
    }
}

/// Feed a token to a stack of states: reduce until the token is shifted. Returns false (and leaves
/// the stack in an unspecified state) if the token is a syntax error.
pub fn feed(states: &mut Vec<StateId>, token: SymbolKind) -> bool {
    loop {
        let top = *states.last().unwrap();
        let rule = match table_action(top, token) {
            Some(Action::Shift(next)) => {
                states.push(next);
                return true;
            }
            Some(Action::Error) => return false,
            Some(Action::Reduce(rule)) => rule,
            None => match YYDEFACT[top as usize] as usize {
                0 => return false,
                rule => rule,
            },
        };
        let len = YYR2[rule] as usize;
        states.truncate(states.len() - len);
        let next = goto_state(*states.last().unwrap(), YYR1[rule] as SymbolKind);
        states.push(next);
    }
}

/// The location of the left-hand side of a reduction (the `YYLLOC_DEFAULT` of the former C++ prologue).
/// Uses the wrapping uint32 arithmetic of the C++ macro.
fn default_location(rhs: &[SymbolSpan], below: SymbolSpan) -> SymbolSpan {
    match (rhs.first(), rhs.last()) {
        (Some(first), Some(last)) => SymbolSpan::new(
            first.offset(),
            last.offset().wrapping_add(last.length()).wrapping_sub(first.offset()),
        ),
        _ => SymbolSpan::new(below.offset().wrapping_add(below.length()), 0),
    }
}

/// A lookahead token
#[derive(Clone, Copy, Debug)]
struct Lookahead {
    /// The token kind
    kind: SymbolKind,
    /// The semantic value of the token
    value: Value,
}

/// The parser stack
struct Stack {
    /// The automaton states
    states: Vec<StateId>,
    /// The semantic values, parallel to the states
    values: Vec<Value>,
    /// The symbol-index locations, parallel to the states
    locations: Vec<SymbolSpan>,
}

impl Stack {
    fn push(&mut self, state: StateId, value: Value, location: SymbolSpan) {
        self.states.push(state);
        self.values.push(value);
        self.locations.push(location);
    }

    fn pop(&mut self, n: usize) {
        let len = self.states.len() - n;
        self.states.truncate(len);
        self.values.truncate(len);
        self.locations.truncate(len);
    }

    fn top(&self) -> StateId {
        *self.states.last().unwrap()
    }
}

impl ReduceStack for Stack {
    fn value_at(&self, i: usize) -> Value {
        self.values[self.values.len() - 1 - i]
    }
    fn location_at(&self, i: usize) -> SymbolSpan {
        self.locations[self.locations.len() - 1 - i]
    }
}

/// The token stream of the parser (`ParseContext::NextSymbol`): scanned symbols located by their
/// index, followed by EOF tokens of length 0 once the symbols are exhausted.
pub struct TokenStream {
    /// The index of the next symbol to return
    pub next_index: u32,
}

impl TokenStream {
    pub fn next(&mut self, ctx: &ParseContext) -> (SymbolKind, Value, SymbolSpan) {
        let index = self.next_index;
        match ctx.symbols().get(index as usize) {
            Some(symbol) => {
                self.next_index += 1;
                let value = match symbol.value {
                    SymbolValue::None => Value::Empty,
                    SymbolValue::Name(id) => Value::Name(id),
                    SymbolValue::Text(text) => Value::Str(text),
                };
                (symbol.kind, value, SymbolSpan::new(index, 1))
            }
            None => (S_YYEOF, Value::Empty, SymbolSpan::new(index, 0)),
        }
    }
}

/// Where the parse loop continues
enum Label {
    NewState,
    Default,
    Reduce(usize),
    ErrLab,
    ErrLab1,
}

/// Build the verbose syntax error message (`yysyntax_error_`) and the hint of the C++ `Parser`.
fn syntax_error(states: &[StateId], lookahead: Option<SymbolKind>, scratch: &mut Vec<StateId>) -> (String, String) {
    const ARGS_MAX: usize = 5;
    let Some(token) = lookahead else {
        return ("syntax error".to_string(), String::new());
    };
    let mut args = vec![token];
    let mut overflow = false;
    for t in 0..YYNTOKENS as SymbolKind {
        if t == S_YYerror || t == S_YYUNDEF || !lac_check(states, t, scratch) {
            continue;
        }
        if args.len() == ARGS_MAX {
            overflow = true;
            break;
        }
        args.push(t);
    }
    if overflow {
        args.truncate(1);
    }
    let names: Vec<_> = args.iter().map(|&a| symbol_name(a)).collect();
    let mut message = format!("syntax error, unexpected {}", names[0]);
    for (i, name) in names.iter().enumerate().skip(1) {
        message.push_str(if i == 1 { ", expecting " } else { " or " });
        message.push_str(name);
    }
    // Suggest a double-quoted identifier when a string literal is used where an identifier fits.
    let hint = if token == S_SCONST && lac_check(states, S_IDENT, scratch) {
        "string literals cannot be used as identifiers here; use a double-quoted identifier instead".to_string()
    } else {
        String::new()
    };
    (message, hint)
}

/// Run the parser with the grammar actions. Returns false if parsing was aborted.
pub fn parse(ctx: &mut ParseContext) -> bool {
    let mut stack = Stack {
        states: vec![0],
        values: vec![Value::Empty],
        locations: vec![SymbolSpan::default()],
    };
    let mut tokens = TokenStream { next_index: 0 };
    let mut lookahead: Option<Lookahead> = None;
    // The location of the lookahead; it outlives the lookahead itself, like bison's yyla.location.
    let mut lookahead_location = SymbolSpan::default();
    let mut lac_established = false;
    let mut scratch = Vec::new();
    let mut errstatus = 0;
    let mut error_range_begin = SymbolSpan::default();
    let mut label = Label::NewState;

    loop {
        label = match label {
            Label::NewState => {
                let state = stack.top();
                if state == YYFINAL {
                    return true;
                }
                if YYPACT[state as usize] as i32 == YYPACT_NINF {
                    Label::Default
                } else {
                    let la = match lookahead {
                        Some(la) => la,
                        None => {
                            let (kind, value, location) = tokens.next(ctx);
                            lookahead_location = location;
                            let la = Lookahead { kind, value };
                            lookahead = Some(la);
                            la
                        }
                    };
                    let mut establish = |stack: &Stack| {
                        if !lac_established {
                            lac_established = true;
                            return lac_check(&stack.states, la.kind, &mut scratch);
                        }
                        true
                    };
                    match table_action(state, la.kind) {
                        None => {
                            if establish(&stack) {
                                Label::Default
                            } else {
                                Label::ErrLab
                            }
                        }
                        Some(Action::Error) => Label::ErrLab,
                        Some(Action::Reduce(rule)) => {
                            if establish(&stack) {
                                Label::Reduce(rule)
                            } else {
                                Label::ErrLab
                            }
                        }
                        Some(Action::Shift(next)) => {
                            if errstatus > 0 {
                                errstatus -= 1;
                            }
                            stack.push(next, la.value, lookahead_location);
                            lookahead = None;
                            lac_established = false;
                            Label::NewState
                        }
                    }
                }
            }
            Label::Default => match YYDEFACT[stack.top() as usize] as usize {
                0 => Label::ErrLab,
                rule => Label::Reduce(rule),
            },
            Label::Reduce(rule) => {
                let len = YYR2[rule] as usize;
                let n = stack.states.len();
                let lhs_state = goto_state(stack.states[n - 1 - len], YYR1[rule] as SymbolKind);
                let location = default_location(&stack.locations[n - len..], stack.locations[n - 1]);
                error_range_begin = location;
                match reduce(ctx, rule, &stack, location) {
                    Ok(value) => {
                        if std::mem::take(&mut ctx.state.borrow_mut().clear_lookahead) {
                            lookahead = None;
                        }
                        stack.pop(len);
                        stack.push(lhs_state, value.unwrap_or(Value::Empty), location);
                        Label::NewState
                    }
                    Err(ReduceError::YyError) => {
                        if std::mem::take(&mut ctx.state.borrow_mut().clear_lookahead) {
                            lookahead = None;
                        }
                        // yyerrorlab: do not reclaim the symbols of the rule
                        stack.pop(len);
                        Label::ErrLab1
                    }
                }
            }
            Label::ErrLab => {
                if errstatus == 0 {
                    let (message, hint) = syntax_error(&stack.states, lookahead.map(|la| la.kind), &mut scratch);
                    ctx.state.borrow_mut().pending_hint = hint;
                    ctx.error(lookahead_location, &message);
                }
                error_range_begin = lookahead_location;
                if errstatus == 3 {
                    // Discard the lookahead that failed to be reused after an error
                    match lookahead {
                        Some(la) if la.kind == S_YYEOF => return false,
                        Some(_) => lookahead = None,
                        None => {}
                    }
                }
                Label::ErrLab1
            }
            Label::ErrLab1 => {
                errstatus = 3;
                // Pop states until one shifts the error token
                let next = loop {
                    if let Some(Action::Shift(next)) = table_action(stack.top(), S_YYerror) {
                        break next;
                    }
                    if stack.states.len() == 1 {
                        return false;
                    }
                    error_range_begin = *stack.locations.last().unwrap();
                    stack.pop(1);
                };
                let error_location = default_location(&[error_range_begin, lookahead_location], SymbolSpan::default());
                lac_established = false;
                stack.push(next, Value::Empty, error_location);
                Label::NewState
            }
        };
    }
}

/// Run the action of a rule
fn reduce(ctx: &mut ParseContext, rule: usize, stack: &Stack, location: SymbolSpan) -> Result<Option<Value>, ReduceError> {
    crate::tables::reduce(ctx, rule, stack, location)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_tokens() {
        let mut scratch = Vec::new();
        assert!(lac_check(&[0], S_SELECT, &mut scratch));
        assert!(!lac_check(&[0], S_RRB, &mut scratch));
    }
}
