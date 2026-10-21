//! A small document arena for width-aware SQL layout (`formatter/formatting_program.h/.cc`).
//!
//! The formatter builds a program of formatting operations (text, breaks, concatenations, joins,
//! indentation and parentheses) and renders it with a width-aware stack machine. Joins are rendered
//! inline if they fit, otherwise broken according to their join policy.

use dashql_buffers::formatting::{FormattingConfigT, FormattingDialect, FormattingMode, KeywordCase};
use dashql_grammar::keywords::Keyword;
use std::cell::RefCell;

pub const FORMATTING_DEFAULT_INDENTATION_WIDTH: usize = 2;
pub const FORMATTING_DEFAULT_HANGING_INDENTATION_WIDTH: usize = 2;
pub const FORMATTING_DEFAULT_MAX_WIDTH: usize = 120;

/// Parse a formatting mode, compact is the default
pub fn parse_formatting_mode(value: &str) -> FormattingMode {
    match value {
        "inline" => FormattingMode::INLINE,
        "compact" => FormattingMode::COMPACT,
        "pretty" => FormattingMode::PRETTY,
        _ => FormattingMode::COMPACT,
    }
}

/// The name of a formatting mode
pub fn formatting_mode_to_string(mode: FormattingMode) -> &'static str {
    match mode {
        FormattingMode::INLINE => "inline",
        FormattingMode::COMPACT => "compact",
        FormattingMode::PRETTY => "pretty",
        _ => "compact",
    }
}

/// Parse a formatting dialect, hyper is the default
pub fn parse_formatting_dialect(value: &str) -> FormattingDialect {
    match value {
        "hyper" => FormattingDialect::HYPER,
        "trino" => FormattingDialect::TRINO,
        _ => FormattingDialect::HYPER,
    }
}

/// The name of a formatting dialect
pub fn formatting_dialect_to_string(dialect: FormattingDialect) -> &'static str {
    match dialect {
        FormattingDialect::HYPER => "hyper",
        FormattingDialect::TRINO => "trino",
        _ => "hyper",
    }
}

/// A register of the formatting program, 0 is the empty document
pub type FmtReg = u32;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FormattingOpCode {
    #[default]
    Empty,
    Text,
    Break,
    Concat,
    Join,
    Indent,
    Parenthesis,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FormattingJoinPolicy {
    /// Render inline only if the entire join can be rendered without breaks.
    #[default]
    BreakAllOrNone,
    /// Render progressively: keep each separator inline while the next segment fits.
    BreakOnOverflow,
    /// Always render this join broken unless global INLINE mode forces flat output.
    ForceBreak,
}

#[derive(Clone, Debug, Default)]
pub struct FormattingOperation<'a> {
    pub code: FormattingOpCode,
    pub text: &'a str,
    /// Verbatim text keeps its case when keywords are upper-cased
    pub verbatim: bool,
    pub children: Vec<FmtReg>,
    pub inline_separator: FmtReg,
    pub break_separator: FmtReg,
    pub indent_after_breaks: bool,
    pub join_policy: FormattingJoinPolicy,
}

#[derive(Clone, Copy, Debug)]
pub struct FormattingRenderOptions {
    pub max_width: usize,
    pub indentation_width: usize,
    pub debug_mode: bool,
    pub mode: FormattingMode,
    pub keyword_case: KeywordCase,
}

impl Default for FormattingRenderOptions {
    fn default() -> Self {
        Self {
            max_width: FORMATTING_DEFAULT_MAX_WIDTH,
            indentation_width: FORMATTING_DEFAULT_INDENTATION_WIDTH,
            debug_mode: false,
            mode: FormattingMode::COMPACT,
            keyword_case: KeywordCase::LOWER,
        }
    }
}

/// A small document arena for width-aware SQL layout.
///
/// The builder methods take `&self` (the arena lives in a `RefCell`), so that operations can be
/// nested like in the C++ code: `f.concat(&[f.text("a"), f.text("b")])`.
pub struct FormattingProgram<'a> {
    pub config: FormattingConfigT,
    program: RefCell<Vec<FormattingOperation<'a>>>,
}

impl Default for FormattingProgram<'_> {
    fn default() -> Self {
        Self::new()
    }
}

impl<'a> FormattingProgram<'a> {
    pub fn new() -> Self {
        let mut config = FormattingConfigT::default();
        config.mode = FormattingMode::COMPACT;
        let program = Self { config, program: RefCell::new(Vec::new()) };
        program.reset();
        program
    }

    pub fn set_config(&mut self, value: &FormattingConfigT) {
        self.config = value.clone();
    }

    pub fn reset(&self) {
        let mut program = self.program.borrow_mut();
        program.clear();
        program.push(FormattingOperation::default());
    }

    /// The number of operations, including the empty document
    pub fn len(&self) -> usize {
        self.program.borrow().len()
    }

    /// Is the program empty (only the empty document)?
    pub fn is_empty(&self) -> bool {
        self.len() <= 1
    }

    /// A copy of an operation
    pub fn get(&self, reg: FmtReg) -> FormattingOperation<'a> {
        self.program.borrow()[reg as usize].clone()
    }

    pub fn empty(&self) -> FmtReg {
        0
    }

    pub fn text(&self, text: &'a str) -> FmtReg {
        self.push(FormattingOperation { code: FormattingOpCode::Text, text, ..Default::default() })
    }

    pub fn verbatim(&self, text: &'a str) -> FmtReg {
        self.push(FormattingOperation { code: FormattingOpCode::Text, text, verbatim: true, ..Default::default() })
    }

    pub fn break_(&self) -> FmtReg {
        self.push(FormattingOperation { code: FormattingOpCode::Break, ..Default::default() })
    }

    /// Concatenate documents, skipping empty ones
    pub fn concat(&self, parts: &[FmtReg]) -> FmtReg {
        let parts: Vec<FmtReg> = parts.iter().copied().filter(|&p| p != 0).collect();
        match parts.len() {
            0 => self.empty(),
            1 => parts[0],
            _ => {
                self.push(FormattingOperation { code: FormattingOpCode::Concat, children: parts, ..Default::default() })
            }
        }
    }

    pub fn indented(&self, child: FmtReg) -> FmtReg {
        if child == 0 {
            return self.empty();
        }
        self.push(FormattingOperation { code: FormattingOpCode::Indent, children: vec![child], ..Default::default() })
    }

    pub fn parenthesized(&self, child: FmtReg) -> FmtReg {
        if child == 0 {
            return self.empty();
        }
        self.push(FormattingOperation {
            code: FormattingOpCode::Parenthesis,
            children: vec![child],
            ..Default::default()
        })
    }

    /// Join documents with separators, skipping empty ones.
    ///
    /// Without a policy, joins break all or none in pretty mode and on overflow otherwise.
    pub fn join(
        &self,
        items: &[FmtReg],
        inline_separator: FmtReg,
        break_separator: FmtReg,
        join_policy: Option<FormattingJoinPolicy>,
        indent_after_breaks: bool,
    ) -> FmtReg {
        let filtered: Vec<FmtReg> = items.iter().copied().filter(|&i| i != 0).collect();
        match filtered.len() {
            0 => return self.empty(),
            1 => return filtered[0],
            _ => {}
        }
        let selected_policy = join_policy.unwrap_or(if self.config.mode == FormattingMode::PRETTY {
            FormattingJoinPolicy::BreakAllOrNone
        } else {
            FormattingJoinPolicy::BreakOnOverflow
        });
        self.push(FormattingOperation {
            code: FormattingOpCode::Join,
            children: filtered,
            inline_separator,
            break_separator,
            indent_after_breaks,
            join_policy: selected_policy,
            ..Default::default()
        })
    }

    fn push(&self, doc: FormattingOperation<'a>) -> FmtReg {
        let mut program = self.program.borrow_mut();
        program.push(doc);
        (program.len() - 1) as FmtReg
    }

    /// Render a document
    pub fn render(&self, root: FmtReg, options: &FormattingRenderOptions) -> String {
        if root == 0 {
            return String::new();
        }
        let program = self.program.borrow();
        render(&program, root, options)
    }
}

const FORMATTING_INLINE_WIDTH_SAFETY_BUFFER: isize = 2;

fn remaining_inline_width(max_width: usize, current_line_width: usize) -> isize {
    let remaining = max_width as isize - current_line_width as isize;
    remaining - FORMATTING_INLINE_WIDTH_SAFETY_BUFFER
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RendererOpCode {
    Format,
    JoinNextBreakOnOverflow,
    CloseParenthesis,
    CloseParenthesisAfterBreak,
}

#[derive(Clone, Copy, Debug)]
struct InlineRenderCommand {
    doc: FmtReg,
    indentation: usize,
}

#[derive(Clone, Copy, Debug)]
struct RenderCommand {
    kind: RendererOpCode,
    reg: FmtReg,
    indentation: usize,
    next_index: usize,
}

impl RenderCommand {
    fn format(reg: FmtReg, indentation: usize) -> Self {
        Self { kind: RendererOpCode::Format, reg, indentation, next_index: 0 }
    }
}

fn get_only_child(doc: &FormattingOperation) -> FmtReg {
    debug_assert_eq!(doc.children.len(), 1);
    doc.children[0]
}

fn push_inline_children(stack: &mut Vec<InlineRenderCommand>, children: &[FmtReg], indentation: usize) {
    for &child in children.iter().rev() {
        stack.push(InlineRenderCommand { doc: child, indentation });
    }
}

fn push_docs(stack: &mut Vec<RenderCommand>, children: &[FmtReg], indentation: usize) {
    for &child in children.iter().rev() {
        stack.push(RenderCommand::format(child, indentation));
    }
}

fn push_inline_join(stack: &mut Vec<InlineRenderCommand>, doc: &FormattingOperation, indentation: usize) {
    for i in (1..=doc.children.len()).rev() {
        stack.push(InlineRenderCommand { doc: doc.children[i - 1], indentation });
        if i > 1 && doc.inline_separator != 0 {
            stack.push(InlineRenderCommand { doc: doc.inline_separator, indentation });
        }
    }
}

fn push_rendered_join(
    stack: &mut Vec<RenderCommand>,
    doc: &FormattingOperation,
    indentation: usize,
    separator: FmtReg,
) {
    for i in (1..=doc.children.len()).rev() {
        stack.push(RenderCommand::format(doc.children[i - 1], indentation));
        if i > 1 && separator != 0 {
            stack.push(RenderCommand::format(separator, indentation));
        }
    }
}

/// Does the stack render inline within the remaining width?
fn dry_run_inline(
    mut remaining: isize,
    mut stack: Vec<InlineRenderCommand>,
    program: &[FormattingOperation],
    options: &FormattingRenderOptions,
) -> bool {
    while remaining >= 0 {
        let Some(command) = stack.pop() else { break };
        let doc = &program[command.doc as usize];
        match doc.code {
            FormattingOpCode::Empty => {}
            FormattingOpCode::Text => remaining -= doc.text.len() as isize,
            FormattingOpCode::Break => return false,
            FormattingOpCode::Concat => push_inline_children(&mut stack, &doc.children, command.indentation),
            FormattingOpCode::Join => {
                if doc.join_policy == FormattingJoinPolicy::ForceBreak && doc.children.len() > 1 {
                    return false;
                }
                push_inline_join(&mut stack, doc, command.indentation);
            }
            FormattingOpCode::Indent => {
                if !doc.children.is_empty() {
                    stack.push(InlineRenderCommand {
                        doc: get_only_child(doc),
                        indentation: command.indentation + options.indentation_width,
                    });
                }
            }
            FormattingOpCode::Parenthesis => {
                remaining -= 2;
                if !doc.children.is_empty() {
                    stack.push(InlineRenderCommand { doc: get_only_child(doc), indentation: command.indentation });
                }
            }
        }
    }
    remaining >= 0
}

fn join_fits_inline(
    remaining: isize,
    doc: &FormattingOperation,
    indentation: usize,
    program: &[FormattingOperation],
    options: &FormattingRenderOptions,
) -> bool {
    let mut stack = Vec::new();
    push_inline_join(&mut stack, doc, indentation);
    dry_run_inline(remaining, stack, program, options)
}

fn can_inline_join_step(
    remaining: isize,
    doc: &FormattingOperation,
    next_index: usize,
    indentation: usize,
    program: &[FormattingOperation],
    options: &FormattingRenderOptions,
) -> bool {
    if next_index >= doc.children.len() {
        return true;
    }
    let mut stack = vec![InlineRenderCommand { doc: doc.children[next_index], indentation }];
    if doc.inline_separator != 0 {
        stack.push(InlineRenderCommand { doc: doc.inline_separator, indentation });
    }
    dry_run_inline(remaining, stack, program, options)
}

fn parenthesis_fits_inline(
    remaining: isize,
    doc: &FormattingOperation,
    indentation: usize,
    program: &[FormattingOperation],
    options: &FormattingRenderOptions,
) -> bool {
    if remaining < 2 {
        return false;
    }
    let mut stack = Vec::new();
    if !doc.children.is_empty() {
        stack.push(InlineRenderCommand { doc: get_only_child(doc), indentation });
    }
    dry_run_inline(remaining - 2, stack, program, options)
}

fn append_line_break(output: &mut String, current_line_width: &mut usize, indentation: usize, debug_mode: bool) {
    if debug_mode {
        output.push_str(" /*");
        output.push_str(&current_line_width.to_string());
        output.push_str("*/");
    }
    output.push('\n');
    output.extend(std::iter::repeat(' ').take(indentation));
    *current_line_width = indentation;
}

/// Append generated text, upper-casing the words that are keywords
fn append_generated_text(output: &mut String, text: &str) {
    let is_word = |ch: u8| ch.is_ascii_alphanumeric() || ch == b'_';
    let bytes = text.as_bytes();
    let mut pos = 0;
    while pos < bytes.len() {
        let start = pos;
        if !is_word(bytes[pos]) {
            // Words are ASCII, so runs of other bytes end at char boundaries
            while pos < bytes.len() && !is_word(bytes[pos]) {
                pos += 1;
            }
            output.push_str(&text[start..pos]);
            continue;
        }
        while pos < bytes.len() && is_word(bytes[pos]) {
            pos += 1;
        }
        let word = &text[start..pos];
        if Keyword::find(word.as_bytes()).is_none() {
            output.push_str(word);
        } else {
            output.push_str(&word.to_ascii_uppercase());
        }
    }
}

fn render(program: &[FormattingOperation], root: FmtReg, options: &FormattingRenderOptions) -> String {
    let mut output = String::new();
    let mut current_line_width = 0usize;
    let force_inline = options.mode == FormattingMode::INLINE;

    let mut stack = vec![RenderCommand::format(root, 0)];
    while let Some(command) = stack.pop() {
        match command.kind {
            RendererOpCode::CloseParenthesis => {
                output.push(')');
                current_line_width += 1;
                continue;
            }
            RendererOpCode::CloseParenthesisAfterBreak => {
                append_line_break(&mut output, &mut current_line_width, command.indentation, options.debug_mode);
                output.push(')');
                current_line_width += 1;
                continue;
            }
            RendererOpCode::JoinNextBreakOnOverflow => {
                let doc = &program[command.reg as usize];
                if command.next_index >= doc.children.len() {
                    continue;
                }
                let next = RenderCommand {
                    kind: RendererOpCode::JoinNextBreakOnOverflow,
                    reg: command.reg,
                    indentation: command.indentation,
                    next_index: command.next_index + 1,
                };
                let child = doc.children[command.next_index];
                if can_inline_join_step(
                    remaining_inline_width(options.max_width, current_line_width),
                    doc,
                    command.next_index,
                    command.indentation,
                    program,
                    options,
                ) {
                    stack.push(next);
                    stack.push(RenderCommand::format(child, command.indentation));
                    if doc.inline_separator != 0 {
                        stack.push(RenderCommand::format(doc.inline_separator, command.indentation));
                    }
                } else {
                    let next_is_parenthesis = (child as usize) < program.len()
                        && program[child as usize].code == FormattingOpCode::Parenthesis;
                    let use_inline_separator = next_is_parenthesis && doc.inline_separator != 0;
                    stack.push(next);
                    stack.push(RenderCommand::format(child, command.indentation));
                    if doc.break_separator != 0 {
                        let separator = if use_inline_separator { doc.inline_separator } else { doc.break_separator };
                        stack.push(RenderCommand::format(separator, command.indentation));
                    }
                }
                continue;
            }
            RendererOpCode::Format => {}
        }

        let doc = &program[command.reg as usize];
        match doc.code {
            FormattingOpCode::Empty => {}
            FormattingOpCode::Text => {
                if options.keyword_case == KeywordCase::UPPER && !doc.verbatim {
                    append_generated_text(&mut output, doc.text);
                } else {
                    output.push_str(doc.text);
                }
                current_line_width += doc.text.len();
            }
            FormattingOpCode::Break => {
                append_line_break(&mut output, &mut current_line_width, command.indentation, options.debug_mode);
            }
            FormattingOpCode::Concat => push_docs(&mut stack, &doc.children, command.indentation),
            FormattingOpCode::Join => {
                if force_inline
                    || (doc.join_policy != FormattingJoinPolicy::ForceBreak
                        && join_fits_inline(
                            remaining_inline_width(options.max_width, current_line_width),
                            doc,
                            command.indentation,
                            program,
                            options,
                        ))
                {
                    push_rendered_join(&mut stack, doc, command.indentation, doc.inline_separator);
                } else {
                    let indent =
                        command.indentation + if doc.indent_after_breaks { options.indentation_width } else { 0 };
                    match doc.join_policy {
                        FormattingJoinPolicy::BreakAllOrNone | FormattingJoinPolicy::ForceBreak => {
                            push_rendered_join(&mut stack, doc, indent, doc.break_separator);
                        }
                        FormattingJoinPolicy::BreakOnOverflow => {
                            if !doc.children.is_empty() {
                                if doc.children.len() > 1 {
                                    stack.push(RenderCommand {
                                        kind: RendererOpCode::JoinNextBreakOnOverflow,
                                        reg: command.reg,
                                        indentation: indent,
                                        next_index: 1,
                                    });
                                }
                                stack.push(RenderCommand::format(doc.children[0], indent));
                            }
                        }
                    }
                }
            }
            FormattingOpCode::Indent => {
                if !doc.children.is_empty() {
                    stack.push(RenderCommand::format(
                        get_only_child(doc),
                        command.indentation + options.indentation_width,
                    ));
                }
            }
            FormattingOpCode::Parenthesis => {
                let render_flat = force_inline
                    || parenthesis_fits_inline(
                        remaining_inline_width(options.max_width, current_line_width),
                        doc,
                        command.indentation,
                        program,
                        options,
                    );
                output.push('(');
                current_line_width += 1;
                let close = if render_flat {
                    RendererOpCode::CloseParenthesis
                } else {
                    append_line_break(
                        &mut output,
                        &mut current_line_width,
                        command.indentation + options.indentation_width,
                        options.debug_mode,
                    );
                    RendererOpCode::CloseParenthesisAfterBreak
                };
                stack.push(RenderCommand { kind: close, reg: 0, indentation: command.indentation, next_index: 0 });
                if !doc.children.is_empty() {
                    stack.push(RenderCommand::format(
                        get_only_child(doc),
                        command.indentation + options.indentation_width,
                    ));
                }
            }
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(mode: FormattingMode, max_width: usize) -> FormattingRenderOptions {
        FormattingRenderOptions { mode, max_width, ..Default::default() }
    }

    fn comma_list<'a>(f: &FormattingProgram<'a>, items: &[&'a str], policy: Option<FormattingJoinPolicy>) -> FmtReg {
        let regs: Vec<FmtReg> = items.iter().map(|i| f.text(i)).collect();
        let break_separator = f.concat(&[f.text(","), f.break_()]);
        f.join(&regs, f.text(", "), break_separator, policy, true)
    }

    #[test]
    fn concat_skips_empty_documents() {
        let f = FormattingProgram::new();
        let a = f.text("a");
        assert_eq!(f.concat(&[]), 0);
        assert_eq!(f.concat(&[0, a, 0]), a);
        assert_eq!(f.indented(0), 0);
        assert_eq!(f.parenthesized(0), 0);
        assert_eq!(f.join(&[0, a], 0, 0, None, false), a);
        let both = f.concat(&[a, f.text("b")]);
        assert_eq!(f.render(both, &options(FormattingMode::COMPACT, 120)), "ab");
        assert_eq!(f.render(0, &options(FormattingMode::COMPACT, 120)), "");
    }

    #[test]
    fn join_breaks_all_or_none() {
        let f = FormattingProgram::new();
        let list = comma_list(&f, &["aaaa", "bbbb", "cccc"], Some(FormattingJoinPolicy::BreakAllOrNone));
        let root = f.concat(&[f.text("x "), list]);
        assert_eq!(f.render(root, &options(FormattingMode::COMPACT, 120)), "x aaaa, bbbb, cccc");
        // The safety buffer of 2 counts: 18 characters need a width of 20.
        assert_eq!(f.render(root, &options(FormattingMode::COMPACT, 20)), "x aaaa, bbbb, cccc");
        assert_eq!(f.render(root, &options(FormattingMode::COMPACT, 19)), "x aaaa,\n  bbbb,\n  cccc");
        assert_eq!(f.render(root, &options(FormattingMode::INLINE, 1)), "x aaaa, bbbb, cccc");
    }

    #[test]
    fn join_breaks_on_overflow() {
        let f = FormattingProgram::new();
        let list = comma_list(&f, &["aaaa", "bbbb", "cccc"], Some(FormattingJoinPolicy::BreakOnOverflow));
        assert_eq!(f.render(list, &options(FormattingMode::COMPACT, 14)), "aaaa, bbbb,\n  cccc");
    }

    #[test]
    fn join_force_break() {
        let f = FormattingProgram::new();
        let list = comma_list(&f, &["a", "b"], Some(FormattingJoinPolicy::ForceBreak));
        assert_eq!(f.render(list, &options(FormattingMode::COMPACT, 120)), "a,\n  b");
        assert_eq!(f.render(list, &options(FormattingMode::INLINE, 120)), "a, b");
        // A forced break inside a parenthesis breaks the parenthesis as well
        let parens = f.parenthesized(list);
        assert_eq!(f.render(parens, &options(FormattingMode::COMPACT, 120)), "(\n  a,\n    b\n)");
    }

    #[test]
    fn default_join_policy_depends_on_mode() {
        let mut f = FormattingProgram::new();
        let overflow = comma_list(&f, &["a"; 3], None);
        let mut config = FormattingConfigT::default();
        config.mode = FormattingMode::PRETTY;
        f.set_config(&config);
        let all_or_none = comma_list(&f, &["a"; 3], None);
        assert_eq!(f.get(overflow).join_policy, FormattingJoinPolicy::BreakOnOverflow);
        assert_eq!(f.get(all_or_none).join_policy, FormattingJoinPolicy::BreakAllOrNone);
        f.reset();
        assert!(f.is_empty());
    }

    #[test]
    fn parenthesis_breaks_when_too_wide() {
        let f = FormattingProgram::new();
        let inner = f.text("0123456789");
        let root = f.concat(&[f.text("f"), f.parenthesized(inner)]);
        assert_eq!(f.render(root, &options(FormattingMode::COMPACT, 15)), "f(0123456789)");
        assert_eq!(f.render(root, &options(FormattingMode::COMPACT, 14)), "f(\n  0123456789\n)");
    }

    #[test]
    fn overflowing_parenthesis_keeps_inline_separator() {
        let f = FormattingProgram::new();
        let items = [f.text("aaaa"), f.parenthesized(f.text("bbbbbbbb"))];
        let join = f.join(&items, f.text(" "), f.break_(), Some(FormattingJoinPolicy::BreakOnOverflow), false);
        assert_eq!(f.render(join, &options(FormattingMode::COMPACT, 12)), "aaaa (\n  bbbbbbbb\n)");
    }

    #[test]
    fn indentation_and_debug_mode() {
        let f = FormattingProgram::new();
        let root = f.concat(&[f.text("a"), f.indented(f.concat(&[f.break_(), f.text("b")]))]);
        let mut opts = options(FormattingMode::COMPACT, 120);
        opts.indentation_width = 4;
        assert_eq!(f.render(root, &opts), "a\n    b");
        opts.debug_mode = true;
        assert_eq!(f.render(root, &opts), "a /*1*/\n    b");
    }

    #[test]
    fn upper_cases_keywords_of_generated_text() {
        let f = FormattingProgram::new();
        let root = f.concat(&[f.text("select foo_bar, y1"), f.text(" from "), f.verbatim("select")]);
        let mut opts = options(FormattingMode::COMPACT, 120);
        opts.keyword_case = KeywordCase::UPPER;
        assert_eq!(f.render(root, &opts), "SELECT foo_bar, y1 FROM select");
        // Only lower-case words are keywords
        let mixed = f.text("Select order1 'between'");
        assert_eq!(f.render(mixed, &opts), "Select order1 'BETWEEN'");
    }
}
