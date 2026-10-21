//! The LR probes of the completion, a port of `DriveLALR` and its policies in
//! the C++ `src/parser/parser.cc`.
//!
//! The probes run the automaton without grammar actions, only the state numbers matter:
//! - [`parse_until_with_snapshot`] parses up to the cursor token, returns the expected symbols there
//!   and a snapshot of the state stack,
//! - [`parse_until_after`] feeds a symbol at the cursor and returns the expected symbols after it,
//! - [`probe_suffix_batch`] and [`probe_suffix_sequence`] replay the tokens after the cursor from a
//!   snapshot to test whether candidate symbols fit the rest of the script.

use super::driver::{lac_check, table_action, Action, StateId};
use crate::scanner::Symbol;
use crate::symbol_kind::*;
use crate::tables::*;
use crate::SymbolKind;

/// A completion replay stops after this many reductions without a shift. A restored prefix can enter
/// nullable reduction cycles that a regular parse never reaches.
const MAX_REDUCTIONS_WITHOUT_SHIFT: usize = 128;

/// The state stack before the read of the cursor token (`Parser::PrefixSnapshot`)
#[derive(Clone, Debug, Default)]
pub struct PrefixSnapshot {
    /// The states, bottom to top
    pub state_stack: Vec<StateId>,
    /// Did the prefix parse reach the cursor without failing or accepting first?
    pub reached_target: bool,
}

/// The expected symbols at the cursor and the snapshot they were computed from
#[derive(Clone, Debug, Default)]
pub struct ExpectedAtCursor {
    /// The tokens the parser would eventually shift at the cursor, empty if the cursor was not reached
    pub expected: Vec<SymbolKind>,
    /// The state stack before the read of the cursor token
    pub prefix: PrefixSnapshot,
}

/// How a fed symbol fits the tokens after the cursor (`Parser::SuffixProbe`)
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SuffixProbe {
    /// Did the next real token shift after the fed symbols?
    pub k1_compatible: bool,
    /// The number of real tokens shifted before an error or the accept
    pub depth_consumed: u16,
    /// Did the replay accept?
    pub reached_eof: bool,
}

/// The token reader of the probes, `ParseContext::NextSymbol` without semantic values
struct Tokens<'a> {
    /// The scanned symbols
    symbols: &'a [Symbol],
    /// The index of the next symbol to read, EOF past the end
    next_index: u32,
}

impl Tokens<'_> {
    fn next(&mut self) -> SymbolKind {
        match self.symbols.get(self.next_index as usize) {
            Some(symbol) => {
                self.next_index += 1;
                symbol.kind
            }
            None => S_YYEOF,
        }
    }
}

/// The hooks of the driver (see the policy documentation in parser.cc)
trait Policy {
    /// Inspect or replace a token that was just read. `pre_index` is the token index before the read,
    /// rewind `tokens` to it to read the real token again later.
    fn on_lookahead_read(&mut self, states: &[StateId], next: &mut SymbolKind, pre_index: u32, tokens: &mut Tokens, stop: &mut bool);
    fn on_shifted(&mut self, _kind: SymbolKind) {}
    fn on_accept(&mut self) {}
    /// Stop instead of recovering from an error?
    fn short_circuit_on_error(&mut self, _states: &[StateId]) -> bool {
        false
    }
}

/// Run the automaton without actions (`Parser::DriveLALR`)
fn drive<P: Policy>(policy: &mut P, states: &mut Vec<StateId>, tokens: &mut Tokens) {
    let mut lookahead: Option<SymbolKind> = None;
    let mut lac_established = false;
    let mut scratch = Vec::new();
    let mut errstatus = 0;
    let mut reductions_without_shift = 0;

    enum Label {
        NewState,
        Default,
        Reduce(usize),
        ErrLab,
        ErrLab1,
    }
    let mut label = Label::NewState;
    loop {
        label = match label {
            Label::NewState => {
                let state = *states.last().unwrap();
                if state == YYFINAL {
                    policy.on_accept();
                    return;
                }
                if YYPACT[state as usize] as i32 == YYPACT_NINF {
                    Label::Default
                } else {
                    let kind = match lookahead {
                        Some(kind) => kind,
                        None => {
                            let pre_index = tokens.next_index;
                            let mut next = tokens.next();
                            let mut stop = false;
                            policy.on_lookahead_read(states, &mut next, pre_index, tokens, &mut stop);
                            if stop {
                                return;
                            }
                            lookahead = Some(next);
                            next
                        }
                    };
                    if kind == S_YYerror {
                        // The scanner already reported the error, recover directly
                        lookahead = Some(S_YYUNDEF);
                        Label::ErrLab1
                    } else {
                        let mut establish = |states: &[StateId]| {
                            if !lac_established {
                                lac_established = true;
                                return lac_check(states, kind, &mut scratch);
                            }
                            true
                        };
                        match table_action(state, kind) {
                            None => {
                                if establish(states) {
                                    Label::Default
                                } else {
                                    Label::ErrLab
                                }
                            }
                            Some(Action::Error) => Label::ErrLab,
                            Some(Action::Reduce(rule)) => {
                                if establish(states) {
                                    Label::Reduce(rule)
                                } else {
                                    Label::ErrLab
                                }
                            }
                            Some(Action::Shift(next)) => {
                                if errstatus > 0 {
                                    errstatus -= 1;
                                }
                                states.push(next);
                                lookahead = None;
                                lac_established = false;
                                reductions_without_shift = 0;
                                policy.on_shifted(kind);
                                Label::NewState
                            }
                        }
                    }
                }
            }
            Label::Default => match YYDEFACT[*states.last().unwrap() as usize] as usize {
                0 => Label::ErrLab,
                rule => Label::Reduce(rule),
            },
            Label::Reduce(rule) => {
                reductions_without_shift += 1;
                if reductions_without_shift > MAX_REDUCTIONS_WITHOUT_SHIFT {
                    return;
                }
                let len = YYR2[rule] as usize;
                let n = states.len();
                let next = super::driver::goto_state(states[n - 1 - len], YYR1[rule] as SymbolKind);
                states.truncate(n - len);
                states.push(next);
                Label::NewState
            }
            Label::ErrLab => {
                if policy.short_circuit_on_error(states) {
                    return;
                }
                if errstatus == 3 {
                    match lookahead {
                        Some(S_YYEOF) => return,
                        Some(_) => lookahead = None,
                        None => {}
                    }
                }
                Label::ErrLab1
            }
            Label::ErrLab1 => {
                errstatus = 3;
                let next = loop {
                    if let Some(Action::Shift(next)) = table_action(*states.last().unwrap(), S_YYerror) {
                        break next;
                    }
                    if states.len() == 1 {
                        return;
                    }
                    states.pop();
                };
                lac_established = false;
                states.push(next);
                Label::NewState
            }
        };
    }
}

/// All tokens that the parser would eventually shift (`Parser::CollectExpectedSymbols`)
pub fn collect_expected_symbols(states: &[StateId]) -> Vec<SymbolKind> {
    let mut scratch = Vec::new();
    (0..YYNTOKENS as SymbolKind)
        .filter(|&t| t != S_YYerror && t != S_YYUNDEF && lac_check(states, t, &mut scratch))
        .collect()
}

/// Capture the state stack when the cursor token would be read
struct PrefixCapture<'a> {
    /// The symbol index of the cursor token
    target: u32,
    /// The captured snapshot
    out: &'a mut PrefixSnapshot,
}

impl Policy for PrefixCapture<'_> {
    fn on_lookahead_read(&mut self, states: &[StateId], _next: &mut SymbolKind, pre_index: u32, _tokens: &mut Tokens, stop: &mut bool) {
        if pre_index >= self.target {
            self.out.reached_target = true;
            self.out.state_stack.extend_from_slice(states);
            *stop = true;
        }
    }
}

/// Parse until the cursor token and collect the expected symbols there (`ParseUntilWithSnapshot`)
pub fn parse_until_with_snapshot(symbols: &[Symbol], target: u32) -> ExpectedAtCursor {
    let mut out = ExpectedAtCursor::default();
    let mut states = vec![0];
    let mut tokens = Tokens { symbols, next_index: 0 };
    drive(&mut PrefixCapture { target, out: &mut out.prefix }, &mut states, &mut tokens);
    if out.prefix.reached_target && !out.prefix.state_stack.is_empty() {
        out.expected = collect_expected_symbols(&out.prefix.state_stack);
    }
    out
}

/// Replace the cursor token with a symbol, then inject COMPLETE_HERE to collect the expected
/// symbols after it at the next error
struct CollectAfter {
    /// The symbol index of the cursor token
    target: u32,
    /// The symbol that replaces the cursor token
    feed: SymbolKind,
    /// 0 = parsing, 1 = fed the symbol, 2 = injected COMPLETE_HERE
    phase: u8,
    /// The expected symbols after the fed symbol, collected at the first error after COMPLETE_HERE
    expected: Vec<SymbolKind>,
}

impl Policy for CollectAfter {
    fn on_lookahead_read(&mut self, _states: &[StateId], next: &mut SymbolKind, pre_index: u32, _tokens: &mut Tokens, _stop: &mut bool) {
        if self.phase == 1 {
            *next = S_COMPLETE_HERE;
            self.phase = 2;
            return;
        }
        if self.phase == 0 && pre_index >= self.target {
            *next = self.feed;
            self.phase = 1;
        }
    }
    fn short_circuit_on_error(&mut self, states: &[StateId]) -> bool {
        if self.phase == 2 {
            self.expected = collect_expected_symbols(states);
            return true;
        }
        false
    }
}

/// Parse until the cursor token, feed a symbol instead, and collect the expected symbols after it
/// (`ParseUntilAfter`)
pub fn parse_until_after(symbols: &[Symbol], target: u32, feed: SymbolKind) -> Vec<SymbolKind> {
    let mut policy = CollectAfter {
        target,
        feed,
        phase: 0,
        expected: Vec::new(),
    };
    let mut states = vec![0];
    let mut tokens = Tokens { symbols, next_index: 0 };
    drive(&mut policy, &mut states, &mut tokens);
    policy.expected
}

/// Feed symbols at the cursor and count the real tokens that shift after them
struct SuffixProbePolicy<'a> {
    /// The symbols fed at the cursor
    feed: &'a [SymbolKind],
    /// Does the first fed symbol replace the cursor token instead of being inserted before it?
    replace_target: bool,
    /// The probe result
    probe: SuffixProbe,
    /// The number of fed symbols
    fed_count: usize,
    /// The number of fed symbols that shifted
    feed_shifted: usize,
}

impl Policy for SuffixProbePolicy<'_> {
    fn on_lookahead_read(&mut self, _states: &[StateId], next: &mut SymbolKind, pre_index: u32, tokens: &mut Tokens, _stop: &mut bool) {
        if self.fed_count < self.feed.len() {
            // Only the first fed symbol replaces the target, all other fed symbols are insertions
            let consumes_target = self.replace_target && self.fed_count == 0;
            if !consumes_target {
                tokens.next_index = pre_index;
            }
            *next = self.feed[self.fed_count];
            self.fed_count += 1;
        }
    }
    fn on_shifted(&mut self, kind: SymbolKind) {
        if self.feed_shifted < self.feed.len() {
            self.feed_shifted += 1;
            return;
        }
        if kind != S_YYEOF {
            if self.probe.depth_consumed == 0 {
                self.probe.k1_compatible = true;
            }
            self.probe.depth_consumed = self.probe.depth_consumed.saturating_add(1);
        }
    }
    fn on_accept(&mut self) {
        self.probe.reached_eof = true;
    }
    fn short_circuit_on_error(&mut self, _states: &[StateId]) -> bool {
        // Recovering would consume the whole suffix without telling anything about the candidate
        self.fed_count >= 1
    }
}

/// Probe a sequence of symbols fed at the cursor against the tokens after it
/// (`ProbeSuffixSequenceFromPrefix`)
pub fn probe_suffix_sequence(symbols: &[Symbol], target: u32, prefix: &PrefixSnapshot, feed: &[SymbolKind], replace_target: bool) -> SuffixProbe {
    if !prefix.reached_target || feed.is_empty() {
        return SuffixProbe::default();
    }
    let mut states = prefix.state_stack.clone();
    if states.is_empty() {
        return SuffixProbe::default();
    }
    // Advance the tokens to the target
    let next_index = target.min(symbols.len() as u32);
    let mut tokens = Tokens { symbols, next_index };
    let mut policy = SuffixProbePolicy {
        feed,
        replace_target,
        probe: SuffixProbe::default(),
        fed_count: 0,
        feed_shifted: 0,
    };
    drive(&mut policy, &mut states, &mut tokens);
    policy.probe
}

/// Probe every symbol on its own (`ProbeSuffixBatchFromSnapshot`)
pub fn probe_suffix_batch(symbols: &[Symbol], target: u32, prefix: &PrefixSnapshot, feed: &[SymbolKind], replace_target: bool) -> Vec<SuffixProbe> {
    if feed.is_empty() || !prefix.reached_target {
        return vec![SuffixProbe::default(); feed.len()];
    }
    feed.iter()
        .map(|&kind| probe_suffix_sequence(symbols, target, prefix, &[kind], replace_target))
        .collect()
}
