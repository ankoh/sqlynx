//! The shell session (`src/shell/shell_session.cc`).

use super::arrow_renderer::ArrowRenderer;
use super::prompt_buffer::{find_from, PromptBuffer};
use super::session_relations::SessionRelationCatalog;
use super::unicode::{display_width, is_valid, next_grapheme};
use super::vt100::{self, append_sequence, Command};
use super::*;
use crate::catalog::ids::CatalogObjectType;
use crate::catalog::Catalog;
use crate::error::Error;
use crate::pack::pack_tokens;
use crate::script::Script;
use crate::utils::{ci_cmp, ci_find, ci_starts_with, quote_identifier};
use dashql_buffers::completion::CandidateTag;
use dashql_buffers::parser::{ParsedScriptFeature, ScannerTokenType};
use dashql_buffers::status::StatusCode;
use dashql_parser::symbol_kind::S_SEMICOLON;
use std::cmp::Ordering;
use std::collections::VecDeque;

const DEFAULT_DATABASE_NAME: &str = "hyper";
const DEFAULT_TERMINAL_PROMPT: &[u8] = b"dashql> ";
const HISTORY_LIMIT: usize = 1000;
const TERMINAL_COMPLETION_ROWS: usize = 10;
const TERMINAL_PROMPT_CAPACITY: usize = 256;
const TERMINAL_QUERY_SPINNER_FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// The message of a C++ `dashql::Exception` with a status code (`GetDefaultMessage`)
fn exception_message(status: StatusCode) -> &'static str {
    match status {
        StatusCode::CATALOG_NULL => "Catalog is null",
        StatusCode::CATALOG_MISMATCH => "Catalog is not matching",
        StatusCode::CATALOG_ID_OUT_OF_SYNC => "Catalog id is out of sync",
        StatusCode::SCRIPT_NOT_PARSED => "Script is not parsed",
        StatusCode::SCRIPT_NOT_ANALYZED => "Script is not analyzed",
        StatusCode::SCRIPT_BUSY => "Script has an active asynchronous analysis job",
        StatusCode::CATALOG_SCRIPT_NOT_ANALYZED => "Unanalyzed scripts cannot be added to the catalog",
        StatusCode::CATALOG_SCRIPT_UNKNOWN => "Script is missing in catalog",
        StatusCode::CATALOG_DESCRIPTOR_POOL_UNKNOWN => "Schema descriptor pool is not known",
        StatusCode::CATALOG_DESCRIPTOR_TABLES_NULL => "Schema descriptor field `tables` is null or empty",
        StatusCode::CATALOG_DESCRIPTOR_TABLE_NAME_EMPTY => "Table name in schema descriptor is null or empty",
        StatusCode::CATALOG_DESCRIPTOR_TABLE_NAME_COLLISION => "Schema descriptor contains a duplicate table name",
        StatusCode::COMPLETION_MISSES_CURSOR => "Completion requires a script cursor",
        StatusCode::COMPLETION_MISSES_SCANNER_TOKEN => "Completion requires a scanner token",
        StatusCode::COMPLETION_STATE_INCOMPATIBLE => "Completion state is incompatible",
        StatusCode::COMPLETION_STRATEGY_UNKNOWN => "Completion strategy is unknown",
        StatusCode::COMPLETION_WITHOUT_CONTINUATION => "Completion has no continuation",
        StatusCode::COMPLETION_CANDIDATE_INVALID => "Completion candidate is invalid",
        StatusCode::COMPLETION_CATALOG_OBJECT_INVALID => "Completion catalog object is invalid",
        StatusCode::COMPLETION_TEMPLATE_INVALID => "Completion template is invalid",
        StatusCode::EXTERNAL_ID_COLLISION => "Collision on external identifier",
        StatusCode::VIEWMODEL_INPUT_JSON_PARSER_ERROR => "Failed to parse JSON for ViewModel",
        StatusCode::OK => "",
        _ => "Unknown error",
    }
}

/// The `what()` of the C++ exception that corresponds to a core error
fn error_message(error: Error) -> String {
    match error.status {
        Some(status) => exception_message(status).to_string(),
        None => error.message,
    }
}

fn token_style(token_type: ScannerTokenType) -> &'static str {
    match token_type {
        ScannerTokenType::KEYWORD => vt100::BOLD_FOREGROUND_PINK,
        ScannerTokenType::KEYWORD_VIS => vt100::ITALIC_FOREGROUND_SILVER,
        ScannerTokenType::LITERAL_INTEGER
        | ScannerTokenType::LITERAL_FLOAT
        | ScannerTokenType::LITERAL_BINARY
        | ScannerTokenType::LITERAL_HEX
        | ScannerTokenType::LITERAL_BOOLEAN => vt100::FOREGROUND_PURPLE,
        ScannerTokenType::LITERAL_STRING => vt100::FOREGROUND_CORAL,
        ScannerTokenType::OPERATOR => vt100::FOREGROUND_PINK,
        ScannerTokenType::IDENTIFIER => vt100::FOREGROUND_SILVER,
        ScannerTokenType::COMMENT => vt100::FOREGROUND_GRAY,
        _ => "",
    }
}

fn append_cursor_move(output: &mut Vec<u8>, count: usize, command: Command) {
    if count != 0 {
        append_sequence(output, count, command);
    }
}

fn push(output: &mut Vec<u8>, text: &str) {
    output.extend_from_slice(text.as_bytes());
}

/// The byte offset after the grapheme cluster at `offset`, one byte further if the text is not valid UTF-8
fn next_cluster(utf8: Option<&str>, offset: usize) -> usize {
    match utf8 {
        Some(text) => next_grapheme(text, offset),
        None => offset + 1,
    }
}

/// Cut a text to a display width and append "..." (`TruncateDisplayText`)
fn truncate_display_text(text: &[u8], width: usize) -> Vec<u8> {
    if display_width(text) <= width {
        return text.to_vec();
    }
    const MARKER: &[u8] = b"...";
    let marker_width = width.min(MARKER.len());
    let content_width = width - marker_width;
    let mut rendered = 0;
    let mut end = 0;
    let utf8 = std::str::from_utf8(text).ok();
    let mut offset = 0;
    while offset < text.len() {
        let next = next_cluster(utf8, offset);
        let grapheme_width = display_width(&text[offset..next]);
        if rendered + grapheme_width > content_width {
            break;
        }
        rendered += grapheme_width;
        end = next;
        offset = next;
    }
    let mut output = text[..end].to_vec();
    output.extend_from_slice(&MARKER[..marker_width]);
    output
}

fn completion_variant_info_width(count: usize) -> usize {
    if count < 2 {
        return 0;
    }
    let digits = count.to_string().len();
    " <- /".len() + digits * 2 + " ->".len()
}

/// The extent of a laid out prompt in the terminal
#[derive(Clone, Copy, Debug)]
struct PromptLayout {
    /// The number of terminal rows
    rows: usize,
    /// The column after the last grapheme
    column: usize,
}

impl Default for PromptLayout {
    fn default() -> Self {
        Self { rows: 1, column: 0 }
    }
}

fn append_prompt_prefix(
    output: &mut Vec<u8>,
    prefix: &[u8],
    prefix_style: &[u8],
    columns: usize,
    layout: &mut PromptLayout,
) {
    if !prefix.is_empty() {
        output.extend_from_slice(prefix_style);
    }
    let utf8 = std::str::from_utf8(prefix).ok();
    let mut offset = 0;
    while offset < prefix.len() {
        let next = next_cluster(utf8, offset);
        let grapheme = &prefix[offset..next];
        let width = display_width(grapheme);
        if layout.column != 0 && layout.column + width > columns {
            push(output, vt100::CARRIAGE_RETURN);
            append_cursor_move(output, 1, Command::CursorDown);
            layout.rows += 1;
            layout.column = 0;
        }
        output.extend_from_slice(grapheme);
        layout.column += width;
        offset = next;
    }
    if !prefix.is_empty() {
        push(output, vt100::RESET_ATTRIBUTES);
    }
}

fn advance_prompt_prefix(prefix: &[u8], columns: usize, layout: &mut PromptLayout) {
    let utf8 = std::str::from_utf8(prefix).ok();
    let mut offset = 0;
    while offset < prefix.len() {
        let next = next_cluster(utf8, offset);
        let width = display_width(&prefix[offset..next]);
        if layout.column != 0 && layout.column + width > columns {
            layout.rows += 1;
            layout.column = 0;
        }
        layout.column += width;
        offset = next;
    }
}

fn break_prompt_line(
    output: Option<&mut Vec<u8>>,
    continuation: &[u8],
    prefix_style: &[u8],
    active_style: &[u8],
    columns: usize,
    layout: &mut PromptLayout,
) {
    match output {
        Some(output) => {
            if !active_style.is_empty() {
                push(output, vt100::RESET_ATTRIBUTES);
            }
            push(output, vt100::CARRIAGE_RETURN);
            append_cursor_move(output, 1, Command::CursorDown);
            layout.rows += 1;
            layout.column = 0;
            append_prompt_prefix(output, continuation, prefix_style, columns, layout);
            if !active_style.is_empty() {
                output.extend_from_slice(active_style);
            }
        }
        None => {
            layout.rows += 1;
            layout.column = 0;
            advance_prompt_prefix(continuation, columns, layout);
        }
    }
}

fn layout_prompt(text: &[u8], initial: &[u8], continuation: &[u8], columns: usize) -> PromptLayout {
    let columns = columns.max(1);
    let mut layout = PromptLayout::default();
    advance_prompt_prefix(initial, columns, &mut layout);
    let utf8 = std::str::from_utf8(text).ok();
    let mut offset = 0;
    while offset < text.len() {
        if text[offset] == b'\n' {
            break_prompt_line(None, continuation, &[], &[], columns, &mut layout);
            offset += 1;
            continue;
        }
        let next = next_cluster(utf8, offset);
        let width = display_width(&text[offset..next]);
        if layout.column != 0 && layout.column + width > columns {
            break_prompt_line(None, continuation, &[], &[], columns, &mut layout);
        }
        layout.column += width;
        offset = next;
    }
    layout
}

fn render_highlighted_prompt(
    output: &mut Vec<u8>,
    highlighted: &[u8],
    initial: &[u8],
    continuation: &[u8],
    prefix_style: &[u8],
    columns: usize,
) -> PromptLayout {
    let columns = columns.max(1);
    let mut layout = PromptLayout::default();
    append_prompt_prefix(output, initial, prefix_style, columns, &mut layout);
    let mut active_style: Vec<u8> = Vec::new();
    let utf8 = std::str::from_utf8(highlighted).ok();
    let mut offset = 0;
    while offset < highlighted.len() {
        if highlighted[offset] == 0x1b && offset + 1 < highlighted.len() && highlighted[offset + 1] == b'[' {
            if let Some(end) = find_from(highlighted, b'm', offset + 2) {
                let sequence = &highlighted[offset..end + 1];
                output.extend_from_slice(sequence);
                active_style =
                    if sequence == vt100::RESET_ATTRIBUTES.as_bytes() { Vec::new() } else { sequence.to_vec() };
                offset = end + 1;
                continue;
            }
        }
        if highlighted[offset] == b'\n' {
            break_prompt_line(Some(output), continuation, prefix_style, &active_style, columns, &mut layout);
            offset += 1;
            continue;
        }
        let next = next_cluster(utf8, offset);
        let grapheme = &highlighted[offset..next];
        let width = display_width(grapheme);
        if layout.column != 0 && layout.column + width > columns {
            break_prompt_line(Some(output), continuation, prefix_style, &active_style, columns, &mut layout);
        }
        output.extend_from_slice(grapheme);
        layout.column += width;
        offset = next;
    }
    layout
}

fn escape_terminal_text(text: &[u8]) -> Vec<u8> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = Vec::with_capacity(text.len());
    for &value in text {
        if value == b'\t' {
            output.extend_from_slice(b"    ");
        } else if value < 0x20 || value == 0x7f {
            output.extend_from_slice(b"\\x");
            output.push(HEX[(value >> 4) as usize]);
            output.push(HEX[(value & 0x0f) as usize]);
        } else {
            output.push(value);
        }
    }
    output
}

fn normalize_terminal_progress_message(message: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(message.len());
    let mut pending_space = false;
    for &value in message {
        if value == 0x1b {
            break;
        }
        if matches!(value, b' ' | b'\t' | b'\r' | b'\n') {
            pending_space = !output.is_empty();
            continue;
        }
        if value < 0x20 || value == 0x7f {
            continue;
        }
        if pending_space {
            output.push(b' ');
            pending_space = false;
        }
        output.push(value);
    }
    output
}

fn normalize_error(data: &[u8]) -> Vec<u8> {
    if data.is_empty() {
        b"query failed".to_vec()
    } else {
        data.to_vec()
    }
}

fn ci_eq(a: &[u8], b: &[u8]) -> bool {
    ci_cmp(a, b) == Ordering::Equal
}

fn is_non_default_three_part_name(name: &[u8]) -> bool {
    let mut separator_count = 0;
    let mut first_separator = None;
    let mut quoted = false;
    let mut i = 0;
    while i < name.len() {
        if name[i] == b'"' {
            if quoted && i + 1 < name.len() && name[i + 1] == b'"' {
                i += 1;
            } else {
                quoted = !quoted;
            }
        } else if !quoted && name[i] == b'.' {
            if first_separator.is_none() {
                first_separator = Some(i);
            }
            separator_count += 1;
        }
        i += 1;
    }
    let Some(first_separator) = first_separator else {
        return false;
    };
    if separator_count != 2 {
        return false;
    }
    let mut database = &name[..first_separator];
    if database.len() >= 2 && database[0] == b'"' && database[database.len() - 1] == b'"' {
        database = &database[1..database.len() - 1];
    }
    !ci_eq(database, DEFAULT_DATABASE_NAME.as_bytes())
}

/// `std::string::find_first_not_of(set)`
fn find_first_not_of(text: &[u8], set: &[u8]) -> Option<usize> {
    text.iter().position(|c| !set.contains(c))
}

/// `std::string::find_last_not_of(set)`
fn find_last_not_of(text: &[u8], set: &[u8]) -> Option<usize> {
    text.iter().rposition(|c| !set.contains(c))
}

/// `std::string::find_first_of(set, pos)`
fn find_first_of(text: &[u8], set: &[u8], from: usize) -> Option<usize> {
    if from > text.len() {
        return None;
    }
    text[from..].iter().position(|c| set.contains(c)).map(|i| i + from)
}

/// The completion overlay of the terminal (`TerminalCompletionOverlay`)
#[derive(Clone, Debug, Default)]
struct TerminalCompletionOverlay {
    /// The completion candidates
    candidates: Vec<CompletionCandidate>,
    /// The index of the selected candidate
    selection: usize,
    /// The index of the selected qualification variant of the selected candidate
    variant_selection: usize,
    /// The index of the first visible candidate
    window_begin: usize,
    /// The number of terminal rows below the prompt that the list occupies, 0 if not drawn
    rows: usize,
    /// The prompt row of the cursor
    cursor_row: usize,
    /// The terminal column of the left list border
    anchor_column: usize,
    /// The width of the list content in columns
    content_width: usize,
    /// The width of the inline hint before the typed text
    hint_prefix_width: usize,
    /// The width of the inline hint after the cursor
    hint_suffix_width: usize,
    /// The width of the typed text of the target
    hint_current_width: usize,
    /// Was the hint suffix inserted before following text instead of written at the line end?
    hint_suffix_inserted: bool,
    /// Show only the inline hint without the candidate list?
    hint_only: bool,
    /// Does the ` <- i/n ->` variant indicator fit into the list?
    show_variant_info: bool,
}

/// The spinner line of a running query (`TerminalQueryProgressState`)
#[derive(Clone, Debug, Default)]
struct TerminalQueryProgress {
    /// The current spinner frame
    frame: usize,
    /// The text after the spinner
    message: Vec<u8>,
}

/// Prefer a real extension over an identity candidate for the passive hint (`SelectTerminalCompletionHint`)
fn select_terminal_completion_hint(overlay: &mut TerminalCompletionOverlay, prompt_text: &[u8]) {
    if overlay.candidates.is_empty() {
        return;
    }
    let selected = &overlay.candidates[overlay.selection];
    let selected_end = selected.target_offset as usize + selected.target_length as usize;
    if selected_end >= prompt_text.len() || !selected.is_identity {
        return;
    }
    let begin = selected.target_offset as usize;
    let current = &prompt_text[begin..(begin + selected.target_length as usize).min(prompt_text.len())];
    for (i, candidate) in overlay.candidates.iter().enumerate() {
        let target_end = candidate.target_offset as usize + candidate.target_length as usize;
        if target_end == selected_end
            && candidate.completion_text.as_bytes().starts_with(current)
            && candidate.completion_text.as_bytes() != current
        {
            overlay.selection = i;
            return;
        }
    }
}

/// A suspended operation that waits for the host (`PendingEffect`)
#[derive(Clone, Debug)]
struct PendingEffect {
    /// The effect id that the host passes back on completion
    id: u64,
    /// The kind of the effect
    effect_type: EffectType,
    /// The payload, the query or command text
    payload: Vec<u8>,
}

/// An interactive shell session (`ShellSession`)
///
/// The C++ coroutines `ExecuteQuery` and `ExecuteCommand` suspend once on their effect and finish
/// when it completes. They become pending effects here: starting one encodes its envelope,
/// completing it renders the result.
pub struct ShellSession {
    /// The relations of successful DDL statements, if tracked
    session_relations: Option<SessionRelationCatalog>,
    /// The prompt
    prompt: PromptBuffer,
    /// The renderer of query results
    renderer: ArrowRenderer,
    /// The submitted queries, oldest first
    history: VecDeque<String>,
    /// The history entry shown in the prompt, the history length when not browsing
    history_cursor: usize,
    /// The prompt text before browsing the history
    history_draft: String,
    /// The text deleted by the last kill command, inserted by yank
    kill_buffer: String,
    /// The id of the next effect
    next_effect_id: u64,
    /// The effects that wait for the host
    pending_effects: Vec<PendingEffect>,
    /// Clear the screen when the terminal query finishes, requested by the last command
    clear_terminal_after_command: bool,
    /// Complete tables of non-default databases with their qualified name?
    auto_qualify_non_default_database_tables: bool,
    /// The keyword case of completions, 1 is upper case
    keyword_case: u32,
    /// The names of the dot commands
    commands: Vec<String>,
    /// The terminal prompt, the default prompt if empty
    terminal_prompt: Vec<u8>,
    /// The prefix of continuation lines, with `->` below the `>` of the prompt
    terminal_continuation: Vec<u8>,
    /// The SGR sequence of the prompt and continuation prefixes
    terminal_prompt_style: Vec<u8>,
    /// The number of terminal rows of the rendered prompt
    terminal_prompt_rows: usize,
    /// The prompt row of the cursor
    terminal_prompt_cursor_row: usize,
    /// What the host should do after the last terminal input
    terminal_action: PromptInputAction,
    /// The completion overlay, if open
    overlay: Option<TerminalCompletionOverlay>,
    /// The progress line of a running query, if shown
    progress: Option<TerminalQueryProgress>,
}

impl ShellSession {
    pub fn new(catalog: &Catalog, terminal_columns: u32, auto_qualify_non_default_database_tables: bool) -> Self {
        Self {
            session_relations: None,
            prompt: PromptBuffer::new(catalog),
            renderer: ArrowRenderer::new(terminal_columns),
            history: VecDeque::new(),
            history_cursor: 0,
            history_draft: String::new(),
            kill_buffer: String::new(),
            next_effect_id: 1,
            pending_effects: Vec::new(),
            clear_terminal_after_command: false,
            auto_qualify_non_default_database_tables,
            keyword_case: 0,
            commands: Vec::new(),
            terminal_prompt: Vec::new(),
            terminal_continuation: b"     -> ".to_vec(),
            terminal_prompt_style: vt100::BOLD.as_bytes().to_vec(),
            terminal_prompt_rows: 1,
            terminal_prompt_cursor_row: 0,
            terminal_action: PromptInputAction::None,
            overlay: None,
            progress: None,
        }
    }

    /// The prompt
    pub fn prompt(&self) -> &PromptBuffer {
        &self.prompt
    }

    pub fn prompt_mut(&mut self) -> &mut PromptBuffer {
        &mut self.prompt
    }

    /// Drop the session relations from the catalog (the destructor of the C++ session)
    pub fn detach(&mut self, catalog: &mut Catalog) {
        if let Some(relations) = self.session_relations.take() {
            relations.detach(catalog);
        }
    }

    pub fn resize(&mut self, terminal_columns: u32) {
        self.renderer.resize(terminal_columns);
    }

    /// Set the keyword case of completions, `KeywordCase` as in the C ABI (1 is upper case)
    pub fn set_keyword_case(&mut self, keyword_case: u32) {
        self.keyword_case = keyword_case;
    }

    /// Set the color of the terminal prompt, bold in the default foreground color if none
    pub fn set_terminal_prompt_color(&mut self, rgb: Option<[u8; 3]>) {
        self.terminal_prompt_style = match rgb {
            Some([r, g, b]) => format!("\x1b[1;38;2;{r};{g};{b}m").into_bytes(),
            None => vt100::BOLD.as_bytes().to_vec(),
        };
    }

    fn upper_keywords(&self) -> bool {
        // static_cast to the uint8 enum
        self.keyword_case as u8 == 1
    }

    /// Track relations of successful DDL statements in the catalog (`SetTrackSessionRelations`)
    pub fn set_track_session_relations(&mut self, enabled: bool, catalog: &mut Catalog) {
        if enabled == self.session_relations.is_some() {
            return;
        }
        if enabled {
            self.session_relations = Some(SessionRelationCatalog::new(catalog));
        } else {
            self.detach(catalog);
        }
    }

    /// Register the dot commands, one name per line (`SetCommands`)
    pub fn set_commands(&mut self, commands: &[u8]) -> ShellStatus {
        if !is_valid(commands) {
            return ShellStatus::InvalidArgument;
        }
        let mut parsed = Vec::new();
        let mut begin = 0;
        while begin < commands.len() {
            let end = find_from(commands, b'\n', begin);
            let name = &commands[begin..end.unwrap_or(commands.len())];
            if name.is_empty()
                || name[0] == b'.'
                || !name.iter().all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
            {
                return ShellStatus::InvalidArgument;
            }
            parsed.push(String::from_utf8(name.to_vec()).unwrap());
            match end {
                Some(end) => begin = end + 1,
                None => break,
            }
        }
        self.commands = parsed;
        ShellStatus::Ok
    }

    pub fn terminal_action(&self) -> PromptInputAction {
        self.terminal_action
    }

    fn snapshot_prompt(&self, status: ShellStatus, message: &str) -> PromptSnapshot {
        PromptSnapshot {
            status,
            revision: self.prompt.revision(),
            cursor_byte_offset: self.prompt.cursor_byte_offset() as u32,
            text: self.prompt.text(),
            message: message.to_string(),
            action: PromptInputAction::None,
        }
    }

    pub fn set_prompt(&mut self, text: &[u8]) -> PromptSnapshot {
        if !self.prompt.set_text(text) {
            return self.snapshot_prompt(ShellStatus::InvalidArgument, "prompt must contain valid UTF-8");
        }
        self.reset_history_cursor();
        self.snapshot_prompt(ShellStatus::Ok, "")
    }

    pub fn insert_prompt(&mut self, text: &[u8]) -> PromptSnapshot {
        if !self.prompt.insert(text) {
            return self
                .snapshot_prompt(ShellStatus::InvalidArgument, "prompt insertion must contain valid non-empty UTF-8");
        }
        self.reset_history_cursor();
        self.snapshot_prompt(ShellStatus::Ok, "")
    }

    pub fn move_prompt_left(&mut self) -> PromptSnapshot {
        self.prompt.move_left();
        self.snapshot_prompt(ShellStatus::Ok, "")
    }

    pub fn move_prompt_right(&mut self) -> PromptSnapshot {
        self.prompt.move_right();
        self.snapshot_prompt(ShellStatus::Ok, "")
    }

    pub fn delete_prompt_backward(&mut self) -> PromptSnapshot {
        self.prompt.delete_backward();
        self.snapshot_prompt(ShellStatus::Ok, "")
    }

    pub fn delete_prompt_forward(&mut self) -> PromptSnapshot {
        self.prompt.delete_forward();
        self.snapshot_prompt(ShellStatus::Ok, "")
    }

    /// Complete the prompt at the cursor (`CompletePrompt`). Errors are the messages of the C++ exceptions.
    pub fn complete_prompt(&mut self, limit: usize, catalog: &Catalog) -> Result<Vec<CompletionCandidate>, String> {
        let prompt_text = self.prompt.text();
        let text = prompt_text.as_bytes();
        let cursor = self.prompt.cursor_byte_offset();
        if let Some(command_begin) = find_first_not_of(text, b" \t") {
            if text[command_begin] == b'.'
                && cursor > command_begin
                && find_first_of(text, b"\r\n", command_begin).is_none()
            {
                let target_end = find_first_of(text, b" \t", command_begin).unwrap_or(text.len());
                if cursor <= target_end {
                    let prefix = &text[command_begin + 1..cursor];
                    let mut candidates = Vec::with_capacity(limit.min(self.commands.len()));
                    for command in &self.commands {
                        if !command.as_bytes().starts_with(prefix) {
                            continue;
                        }
                        let completion = format!(".{}", command);
                        candidates.push(CompletionCandidate {
                            display_text: completion.clone(),
                            completion_cursor_offset: completion.len() as u32,
                            completion_text: completion,
                            target_offset: command_begin as u32,
                            target_length: (target_end - command_begin) as u32,
                            qualification_target_offset: command_begin as u32,
                            qualification_target_length: (target_end - command_begin) as u32,
                            ..Default::default()
                        });
                        if candidates.len() == limit {
                            break;
                        }
                    }
                    return Ok(candidates);
                }
            }
        }

        let upper_keywords = self.upper_keywords();
        let auto_qualify = self.auto_qualify_non_default_database_tables;
        let script = self.prompt.script_mut();
        script.analyze(catalog, true).map_err(error_message)?;
        let cursor = script.move_cursor(catalog, cursor);
        let completion = Script::complete_at_cursor(&cursor, limit).map_err(error_message)?;
        let mut candidates = Vec::with_capacity(completion.top_candidates.len());
        for candidate in &completion.top_candidates {
            let upper_keyword = upper_keywords && candidate.keyword_symbol.is_some();
            let keyword_text =
                if upper_keyword { candidate.completion_text.to_ascii_uppercase() } else { String::new() };
            let mut completion_text = if upper_keyword {
                keyword_text.clone()
            } else if candidate.completion_text_is_verbatim {
                candidate.completion_text.to_string()
            } else {
                quote_identifier(&candidate.completion_text)
            };
            let objects: Vec<_> =
                candidate.catalog_objects.iter().map(|&co| &completion.candidate_objects[co]).collect();
            let is_function = objects.iter().any(|o| o.object.object_type() == CatalogObjectType::FunctionDeclaration);
            if is_function {
                completion_text.push_str("()");
            }
            let mut qualification_texts = Vec::new();
            for object in &objects {
                let auto_qualify_table = auto_qualify
                    && object.object.object_type() == CatalogObjectType::TableDeclaration
                    && object.qualified_name.len() == 3
                    && !ci_eq(object.qualified_name[0].as_bytes(), DEFAULT_DATABASE_NAME.as_bytes());
                if (object.prefer_qualified || auto_qualify_table) && !object.qualified_name.is_empty() {
                    let mut qualification_text = String::new();
                    for (i, name) in object.qualified_name.iter().enumerate() {
                        if i > 0 {
                            qualification_text.push('.');
                        }
                        qualification_text.push_str(&quote_identifier(name));
                    }
                    if is_function {
                        qualification_text.push_str("()");
                    }
                    let qualification_offset = candidate.target_location_qualified.offset() as usize;
                    let target_offset = candidate.target_location.offset() as usize;
                    let qualifier_already_present =
                        qualification_offset <= target_offset && target_offset <= text.len() && {
                            let mut present = text[qualification_offset..target_offset].to_vec();
                            present.extend_from_slice(completion_text.as_bytes());
                            qualification_text.as_bytes() == present
                        };
                    if !qualifier_already_present {
                        qualification_texts.push(qualification_text);
                    }
                }
            }
            let mut continuation = candidate.keyword_continuation.unwrap_or("").to_string();
            if upper_keywords {
                continuation = continuation.to_ascii_uppercase();
            }
            let cursor_offset = completion_text.len() - if completion_text.ends_with("()") { 1 } else { 0 };
            candidates.push(CompletionCandidate {
                display_text: if upper_keyword { keyword_text } else { candidate.completion_text.to_string() },
                completion_text,
                continuation_text: continuation,
                is_identity: candidate.candidate_tags & CandidateTag::IDENTITY.0 != 0,
                qualification_texts,
                completion_cursor_offset: cursor_offset as u32,
                target_offset: candidate.target_location.offset(),
                target_length: candidate.target_location.length(),
                qualification_target_offset: candidate.target_location_qualified.offset(),
                qualification_target_length: candidate.target_location_qualified.length(),
            });
        }
        Ok(candidates)
    }

    /// Replace the target of a candidate (`ApplyCompletion`)
    pub fn apply_completion(&mut self, candidate: &CompletionCandidate) -> PromptSnapshot {
        if !self.prompt.replace_byte_range(
            candidate.target_offset as usize,
            candidate.target_length as usize,
            &candidate.completion_text,
        ) {
            return self.snapshot_prompt(ShellStatus::InvalidArgument, "completion target is not on prompt boundaries");
        }
        self.prompt.move_to_byte_offset(candidate.target_offset as usize + candidate.completion_cursor_offset as usize);
        self.snapshot_prompt(ShellStatus::Ok, "")
    }

    /// Apply the completion of the C ABI, whose texts may be invalid UTF-8 (`dashql_shell_prompt_apply_completion`)
    pub fn apply_completion_bytes(
        &mut self,
        display_text: &[u8],
        completion_text: &[u8],
        target_offset: u32,
        target_length: u32,
    ) -> PromptSnapshot {
        match std::str::from_utf8(completion_text) {
            Ok(completion) => self.apply_completion(&CompletionCandidate {
                display_text: String::from_utf8_lossy(display_text).into_owned(),
                completion_text: completion.to_string(),
                completion_cursor_offset: completion_text.len() as u32,
                target_offset,
                target_length,
                qualification_target_offset: target_offset,
                qualification_target_length: target_length,
                ..Default::default()
            }),
            Err(_) => {
                self.snapshot_prompt(ShellStatus::InvalidArgument, "completion target is not on prompt boundaries")
            }
        }
    }

    /// Apply a semantic input to the prompt (`ConsumePromptInput`)
    pub fn consume_prompt_input(&mut self, key: PromptInputKey, text: &[u8]) -> PromptSnapshot {
        let mut action = PromptInputAction::None;
        match key {
            PromptInputKey::Text => {
                if !self.prompt.insert(text) {
                    return self.snapshot_prompt(
                        ShellStatus::InvalidArgument,
                        "prompt input must contain valid non-empty UTF-8",
                    );
                }
                self.reset_history_cursor();
            }
            PromptInputKey::Enter => {
                if self.prompt_is_complete() {
                    action = PromptInputAction::Submit;
                } else {
                    self.prompt.insert(b"\n");
                    self.reset_history_cursor();
                }
            }
            PromptInputKey::ForceSubmit => {
                if !self.prompt.text().is_empty() {
                    action = PromptInputAction::Submit;
                }
            }
            PromptInputKey::Tab => action = PromptInputAction::Complete,
            PromptInputKey::Backspace => {
                self.prompt.delete_backward();
                self.reset_history_cursor();
            }
            PromptInputKey::Delete => {
                self.prompt.delete_forward();
                self.reset_history_cursor();
            }
            PromptInputKey::Left => {
                self.prompt.move_left();
            }
            PromptInputKey::Right => {
                self.prompt.move_right();
            }
            PromptInputKey::Start => {
                self.prompt.move_to_start();
            }
            PromptInputKey::End => {
                self.prompt.move_to_end();
            }
            PromptInputKey::LineStart => {
                self.prompt.move_to_line_start();
            }
            PromptInputKey::LineEnd => {
                self.prompt.move_to_line_end();
            }
            PromptInputKey::WordLeft => {
                self.prompt.move_word_left();
            }
            PromptInputKey::WordRight => {
                self.prompt.move_word_right();
            }
            PromptInputKey::KillLine => {
                if self.prompt.delete_to_line_end(Some(&mut self.kill_buffer)) {
                    self.reset_history_cursor();
                }
            }
            PromptInputKey::BackwardKillLine => {
                if self.prompt.delete_to_line_start(Some(&mut self.kill_buffer)) {
                    self.reset_history_cursor();
                }
            }
            PromptInputKey::KillWord => {
                if self.prompt.delete_word_forward(Some(&mut self.kill_buffer)) {
                    self.reset_history_cursor();
                }
            }
            PromptInputKey::BackwardKillWord => {
                if self.prompt.delete_word_backward(Some(&mut self.kill_buffer)) {
                    self.reset_history_cursor();
                }
            }
            PromptInputKey::Yank => {
                if !self.kill_buffer.is_empty() {
                    let kill_buffer = self.kill_buffer.clone();
                    self.prompt.insert(kill_buffer.as_bytes());
                    self.reset_history_cursor();
                }
            }
            PromptInputKey::Transpose => {
                if self.prompt.transpose_characters() {
                    self.reset_history_cursor();
                }
            }
            PromptInputKey::ClearScreen | PromptInputKey::Abort | PromptInputKey::Escape => {}
            PromptInputKey::Eof => {
                if self.prompt.text().is_empty() {
                    action = PromptInputAction::Exit;
                } else {
                    self.prompt.delete_forward();
                    self.reset_history_cursor();
                }
            }
            PromptInputKey::Up | PromptInputKey::HistoryPrevious => {
                let moved =
                    key == PromptInputKey::Up && self.history_cursor == self.history.len() && self.prompt.move_up();
                if !moved && !self.history.is_empty() && self.history_cursor > 0 {
                    if self.history_cursor == self.history.len() {
                        self.history_draft = self.prompt.text();
                    }
                    self.history_cursor -= 1;
                    let entry = self.history[self.history_cursor].clone();
                    self.prompt.set_text(entry.as_bytes());
                }
            }
            PromptInputKey::Down | PromptInputKey::HistoryNext => {
                let moved =
                    key == PromptInputKey::Down && self.history_cursor == self.history.len() && self.prompt.move_down();
                if !moved && self.history_cursor < self.history.len() {
                    self.history_cursor += 1;
                    let entry = if self.history_cursor < self.history.len() {
                        self.history[self.history_cursor].clone()
                    } else {
                        self.history_draft.clone()
                    };
                    self.prompt.set_text(entry.as_bytes());
                }
            }
            PromptInputKey::Cancel => {
                self.prompt.set_text(b"");
                self.reset_history_cursor();
            }
        }
        let mut snapshot = self.snapshot_prompt(ShellStatus::Ok, "");
        snapshot.action = action;
        snapshot
    }

    fn terminal_prompt_text(&self) -> &[u8] {
        if self.terminal_prompt.is_empty() {
            DEFAULT_TERMINAL_PROMPT
        } else {
            &self.terminal_prompt
        }
    }

    fn terminal_output(&self, result: Result<ShellOperation, String>) -> TerminalOutput {
        match result {
            Ok(operation) => {
                TerminalOutput { status: operation.status, action: self.terminal_action, data: operation.data }
            }
            Err(message) => TerminalOutput {
                status: ShellStatus::InternalError,
                action: PromptInputAction::None,
                data: message.into_bytes(),
            },
        }
    }

    /// Open the terminal with a prompt, "dashql> " if empty (`OpenTerminal`)
    pub fn open_terminal(&mut self, prompt: &[u8]) -> TerminalOutput {
        self.terminal_action = PromptInputAction::None;
        self.overlay = None;
        let result = if !is_valid(prompt) {
            ShellOperation::new(ShellStatus::InvalidArgument, "terminal prompt must contain valid UTF-8")
        } else if prompt.len() > TERMINAL_PROMPT_CAPACITY {
            ShellOperation::new(ShellStatus::InvalidArgument, "terminal prompt is too long")
        } else {
            self.terminal_prompt = prompt.to_vec();
            let rendered_prompt = self.terminal_prompt_text().to_vec();
            let marker_column = match rendered_prompt.iter().rposition(|&c| c == b'>') {
                Some(marker) => display_width(&rendered_prompt[..marker]),
                None => display_width(&rendered_prompt),
            };
            self.terminal_continuation = vec![b' '; marker_column.saturating_sub(1)];
            self.terminal_continuation.extend_from_slice(b"-> ");
            self.terminal_prompt_rows = 1;
            self.terminal_prompt_cursor_row = 0;
            let mut output = Vec::new();
            push(&mut output, vt100::DISABLE_AUTO_WRAP);
            output.extend(self.render_terminal_prompt());
            ShellOperation::ok(output)
        };
        self.terminal_output(Ok(result))
    }

    /// Apply a semantic input to the terminal and render it (`ConsumeTerminalInput`)
    pub fn consume_terminal_input(&mut self, key: PromptInputKey, text: &[u8], catalog: &Catalog) -> TerminalOutput {
        let result = self.consume_terminal_input_impl(key, text, catalog);
        self.terminal_output(result)
    }

    fn consume_terminal_input_impl(
        &mut self,
        key: PromptInputKey,
        text: &[u8],
        catalog: &Catalog,
    ) -> Result<ShellOperation, String> {
        self.terminal_action = PromptInputAction::None;
        if let Some(overlay) = &self.overlay {
            if !overlay.hint_only {
                let variant_count = overlay.candidates[overlay.selection].qualification_texts.len();
                if key == PromptInputKey::HistoryPrevious || key == PromptInputKey::Up {
                    return Ok(self.move_terminal_completion(-1));
                }
                if key == PromptInputKey::HistoryNext || key == PromptInputKey::Down {
                    return Ok(self.move_terminal_completion(1));
                }
                if overlay.show_variant_info && variant_count > 1 && key == PromptInputKey::Left {
                    return Ok(self.move_terminal_completion_variant(-1));
                }
                if overlay.show_variant_info && variant_count > 1 && key == PromptInputKey::Right {
                    return Ok(self.move_terminal_completion_variant(1));
                }
            }
            let hint_only = overlay.hint_only;
            if key == PromptInputKey::Tab || (key == PromptInputKey::Enter && !hint_only) {
                return self.accept_terminal_completion(catalog);
            }
            if key == PromptInputKey::Escape || key == PromptInputKey::Abort {
                let mut output = self.clear_terminal_completion_overlay();
                self.overlay = None;
                output.extend(self.render_terminal_prompt());
                return Ok(ShellOperation::ok(output));
            }
        }
        if key == PromptInputKey::Abort {
            return Ok(ShellOperation::ok(Vec::new()));
        }
        if key == PromptInputKey::Escape {
            self.terminal_action = PromptInputAction::Exit;
            return Ok(ShellOperation::ok(vt100::ENABLE_AUTO_WRAP));
        }
        let mut output_prefix = Vec::new();
        if self.overlay.is_some() {
            output_prefix = self.clear_terminal_completion_overlay();
            self.overlay = None;
        }
        if key == PromptInputKey::ClearScreen {
            output_prefix.clear();
            self.terminal_prompt_rows = 1;
            self.terminal_prompt_cursor_row = 0;
            push(&mut output_prefix, vt100::CLEAR_SCREEN);
            output_prefix.extend(self.render_terminal_prompt());
            return Ok(ShellOperation::ok(output_prefix));
        }
        let snapshot = self.consume_prompt_input(key, text);
        if snapshot.status != ShellStatus::Ok {
            return Ok(ShellOperation::new(snapshot.status, snapshot.message));
        }
        let action = snapshot.action;
        if action == PromptInputAction::Exit {
            self.terminal_action = action;
            push(&mut output_prefix, vt100::ENABLE_AUTO_WRAP);
            return Ok(ShellOperation::ok(output_prefix));
        }
        if action == PromptInputAction::Submit {
            if !output_prefix.is_empty() {
                output_prefix.extend(self.render_terminal_prompt());
            }
            self.terminal_action = action;
            // The cursor row can be stale after prompt edits outside of the terminal, C++ wraps around like size_t
            let rows_below = self.terminal_prompt_rows.wrapping_sub(self.terminal_prompt_cursor_row).wrapping_sub(1);
            append_cursor_move(&mut output_prefix, rows_below, Command::CursorDown);
            self.terminal_prompt_rows = 1;
            self.terminal_prompt_cursor_row = 0;
            push(&mut output_prefix, vt100::ENABLE_AUTO_WRAP);
            push(&mut output_prefix, vt100::NEW_LINE);
            return Ok(ShellOperation::ok(output_prefix));
        }
        if action == PromptInputAction::Complete {
            let candidates = self.complete_prompt(50, catalog)?;
            if candidates.len() == 1 {
                let snapshot = self.apply_completion(&candidates[0]);
                if snapshot.status != ShellStatus::Ok {
                    return Ok(ShellOperation::new(snapshot.status, snapshot.message));
                }
                output_prefix.extend(self.render_terminal_prompt());
                output_prefix.extend(self.refresh_terminal_completion_overlay(catalog)?);
                return Ok(ShellOperation::ok(output_prefix));
            }
            if candidates.len() > 1 {
                output_prefix.extend(self.open_terminal_completion_overlay(candidates));
                return Ok(ShellOperation::ok(output_prefix));
            }
        }
        if key == PromptInputKey::Cancel {
            self.terminal_prompt_rows = 1;
            self.terminal_prompt_cursor_row = 0;
            let mut output = output_prefix;
            output.extend_from_slice(b"^C");
            push(&mut output, vt100::NEW_LINE);
            output.extend(self.render_terminal_prompt());
            return Ok(ShellOperation::ok(output));
        }
        output_prefix.extend(self.render_terminal_prompt());
        let navigation_key = matches!(
            key,
            PromptInputKey::Left
                | PromptInputKey::Right
                | PromptInputKey::Up
                | PromptInputKey::Down
                | PromptInputKey::Start
                | PromptInputKey::End
                | PromptInputKey::LineStart
                | PromptInputKey::LineEnd
                | PromptInputKey::WordLeft
                | PromptInputKey::WordRight
        );
        if key != PromptInputKey::ForceSubmit && key != PromptInputKey::Tab && !navigation_key {
            output_prefix.extend(self.refresh_terminal_completion_overlay(catalog)?);
        }
        Ok(ShellOperation::ok(output_prefix))
    }

    /// Print the output of a query and a fresh prompt (`FinishTerminalQuery`)
    pub fn finish_terminal_query(&mut self, output: &[u8], error: bool) -> TerminalOutput {
        self.terminal_action = PromptInputAction::None;
        let mut rendered = self.clear_terminal_completion_overlay();
        self.overlay = None;
        rendered.extend(self.clear_terminal_query_progress_output());
        push(&mut rendered, vt100::ENABLE_AUTO_WRAP);
        if self.clear_terminal_after_command {
            push(&mut rendered, vt100::CLEAR_SCREEN);
            self.clear_terminal_after_command = false;
        } else {
            if error {
                push(&mut rendered, vt100::FOREGROUND_RED);
            }
            rendered.extend_from_slice(output);
            if error {
                push(&mut rendered, vt100::RESET_ATTRIBUTES);
            }
            push(&mut rendered, vt100::NEW_LINE);
        }
        self.prompt.set_text(b"");
        self.terminal_prompt_rows = 1;
        self.terminal_prompt_cursor_row = 0;
        push(&mut rendered, vt100::DISABLE_AUTO_WRAP);
        rendered.extend(self.render_terminal_prompt());
        self.terminal_output(Ok(ShellOperation::ok(rendered)))
    }

    /// Render the spinner line of a running query (`RenderTerminalQueryProgress`)
    pub fn render_terminal_query_progress(&mut self, message: &[u8], advance_frame: bool) -> TerminalOutput {
        self.terminal_action = PromptInputAction::None;
        if !is_valid(message) {
            return self.terminal_output(Ok(ShellOperation::new(
                ShellStatus::InvalidArgument,
                "terminal query progress must contain valid UTF-8",
            )));
        }
        let normalized = normalize_terminal_progress_message(message);
        let active = self.progress.is_some();
        let progress = self.progress.get_or_insert_with(Default::default);
        if !normalized.is_empty() {
            progress.message = normalized;
        }
        if !active {
            progress.frame = 0;
            if progress.message.is_empty() {
                progress.message = b"Executing query".to_vec();
            }
        } else if advance_frame {
            progress.frame = (progress.frame + 1) % TERMINAL_QUERY_SPINNER_FRAMES.len();
        }
        let mut line = TERMINAL_QUERY_SPINNER_FRAMES[progress.frame].as_bytes().to_vec();
        line.push(b' ');
        line.extend_from_slice(&progress.message);
        let line = truncate_display_text(&line, (self.renderer.terminal_columns() as usize).max(1));
        let mut output = Vec::new();
        push(&mut output, vt100::DISABLE_AUTO_WRAP);
        push(&mut output, vt100::CARRIAGE_RETURN);
        push(&mut output, vt100::ERASE_ENTIRE_LINE);
        output.extend(line);
        self.terminal_output(Ok(ShellOperation::ok(output)))
    }

    pub fn clear_terminal_query_progress(&mut self) -> TerminalOutput {
        self.terminal_action = PromptInputAction::None;
        let output = self.clear_terminal_query_progress_output();
        self.terminal_output(Ok(ShellOperation::ok(output)))
    }

    fn clear_terminal_query_progress_output(&mut self) -> Vec<u8> {
        if self.progress.take().is_none() {
            return Vec::new();
        }
        let mut output = Vec::new();
        push(&mut output, vt100::CARRIAGE_RETURN);
        push(&mut output, vt100::ERASE_ENTIRE_LINE);
        push(&mut output, vt100::ENABLE_AUTO_WRAP);
        output
    }

    /// Print a status line and a fresh prompt (`RenderTerminalStatus`)
    pub fn render_terminal_status(&mut self, message: &[u8]) -> TerminalOutput {
        self.terminal_action = PromptInputAction::None;
        let mut output = self.clear_terminal_completion_overlay();
        self.overlay = None;
        output.extend(self.clear_terminal_query_progress_output());
        push(&mut output, vt100::ENABLE_AUTO_WRAP);
        push(&mut output, vt100::NEW_LINE);
        push(&mut output, vt100::FOREGROUND_BRIGHT_BLACK);
        output.extend_from_slice(message);
        push(&mut output, vt100::RESET_ATTRIBUTES);
        push(&mut output, vt100::NEW_LINE);
        self.terminal_prompt_rows = 1;
        self.terminal_prompt_cursor_row = 0;
        push(&mut output, vt100::DISABLE_AUTO_WRAP);
        output.extend(self.render_terminal_prompt());
        self.terminal_output(Ok(ShellOperation::ok(output)))
    }

    /// Execute the prompt as a dot command or a query (`SubmitPrompt`)
    pub fn submit_prompt(&mut self, catalog: &Catalog) -> ShellOperation {
        let query = self.prompt.text();
        if query.is_empty() {
            return ShellOperation::new(ShellStatus::InvalidArgument, "query must not be empty");
        }
        self.remember_prompt(&query);
        let bytes = query.as_bytes();
        if let Some(query_begin) = find_first_not_of(bytes, b" \t\r\n") {
            if bytes[query_begin] == b'.' {
                return self.suspend_effect(EffectType::ExecuteCommand, bytes[query_begin..].to_vec());
            }
        }
        if let Some(query_end) = find_last_not_of(bytes, b" \t\r\n") {
            if bytes[query_end] == b';' {
                return self.start_query(&bytes[..query_end], catalog);
            }
        }
        self.start_query(bytes, catalog)
    }

    /// Is the prompt a complete statement or dot command (`PromptIsComplete`)?
    fn prompt_is_complete(&mut self) -> bool {
        let text = self.prompt.text();
        let bytes = text.as_bytes();
        let ws = b" \t\r\n";
        let Some(begin) = find_first_not_of(bytes, ws) else {
            return false;
        };
        let end = find_last_not_of(bytes, ws);
        if bytes[begin] == b'.' {
            return find_first_of(bytes, b"\r\n", begin).is_none();
        }
        if end.is_none_or(|end| bytes[end] != b';') {
            return false;
        }
        let script = self.prompt.script_mut();
        script.parse();
        let Some(parsed) = script.parsed.as_ref() else {
            return false;
        };
        let symbols = &parsed.scanned.symbols;
        if symbols.len() < 2 || symbols[symbols.len() - 2].kind != S_SEMICOLON {
            return false;
        }
        // The remote grammar may accept syntax that the local parser does not recognize
        if !parsed.errors.is_empty() || !parsed.scanned.errors.is_empty() {
            return true;
        }
        parsed.statements.len() == 1
    }

    fn reset_history_cursor(&mut self) {
        self.history_cursor = self.history.len();
        self.history_draft.clear();
    }

    fn remember_prompt(&mut self, query: &str) {
        if self.history.back().is_none_or(|last| last != query) {
            self.history.push_back(query.to_string());
        }
        while self.history.len() > HISTORY_LIMIT {
            self.history.pop_front();
        }
        self.reset_history_cursor();
    }

    /// The history as length-prefixed (u32 little-endian) entries (`ExportHistory`)
    pub fn export_history(&self) -> Vec<u8> {
        let mut output = Vec::new();
        for entry in &self.history {
            output.extend_from_slice(&(entry.len() as u32).to_le_bytes());
            output.extend_from_slice(entry.as_bytes());
        }
        output
    }

    /// Replace the history with exported entries (`ImportHistory`)
    pub fn import_history(&mut self, data: &[u8]) -> ShellStatus {
        let mut history = VecDeque::new();
        let mut offset = 0;
        while offset < data.len() {
            if data.len() - offset < 4 {
                return ShellStatus::InvalidArgument;
            }
            let size = u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap()) as usize;
            offset += 4;
            if size > data.len() - offset {
                return ShellStatus::InvalidArgument;
            }
            let Ok(entry) = std::str::from_utf8(&data[offset..offset + size]) else {
                return ShellStatus::InvalidArgument;
            };
            history.push_back(entry.to_string());
            offset += size;
        }
        while history.len() > HISTORY_LIMIT {
            history.pop_front();
        }
        self.history = history;
        self.reset_history_cursor();
        ShellStatus::Ok
    }

    fn render_arrow_ipc(&self, data: &[u8]) -> ShellOperation {
        match self.renderer.render_ipc(data) {
            Ok(mut output) => {
                if !output.is_empty() {
                    push(&mut output, vt100::NEW_LINE);
                }
                ShellOperation::ok(output)
            }
            Err(message) => ShellOperation::new(ShellStatus::ArrowError, message),
        }
    }

    /// Start a query (`StartQuery`): returns the effect envelope of the query
    pub fn start_query(&mut self, query: &[u8], catalog: &Catalog) -> ShellOperation {
        if !self.pending_effects.is_empty() {
            return ShellOperation::new(ShellStatus::Busy, "the shell already has an active operation");
        }
        if query.is_empty() {
            return ShellOperation::new(ShellStatus::InvalidArgument, "query must not be empty");
        }
        let mut script = Script::new(catalog);
        let Ok(text) = std::str::from_utf8(query) else {
            // The rope rejects invalid UTF-8 with an exception
            return ShellOperation::new(ShellStatus::InternalError, "rope input must contain valid UTF-8");
        };
        script.insert_text_at(0, text);
        script.parse();
        if script.parsed.as_ref().is_some_and(|p| p.feature_flags & ParsedScriptFeature::VISUALIZE.0 != 0) {
            return ShellOperation::new(
                ShellStatus::InvalidArgument,
                "DashQL VISUALIZE syntax is not executable in the shell",
            );
        }
        self.suspend_effect(EffectType::ExecuteQuery, query.to_vec())
    }

    /// Suspend an operation on an effect and encode its envelope (`SuspendEffect`, `EncodeOutgoingEffect`)
    fn suspend_effect(&mut self, effect_type: EffectType, payload: Vec<u8>) -> ShellOperation {
        let id = self.next_effect_id;
        self.next_effect_id += 1;
        let mut encoded = Vec::with_capacity(EFFECT_ENVELOPE_HEADER_SIZE + payload.len());
        encoded.extend_from_slice(&EFFECT_ENVELOPE_VERSION.to_le_bytes());
        encoded.extend_from_slice(&(effect_type as u32).to_le_bytes());
        encoded.extend_from_slice(&id.to_le_bytes());
        encoded.extend_from_slice(&payload);
        self.pending_effects.push(PendingEffect { id, effect_type, payload });
        ShellOperation::new(ShellStatus::Pending, encoded)
    }

    /// Resume the operation of an effect with its result (`CompleteEffect`)
    pub fn complete_effect(
        &mut self,
        effect_id: u64,
        status: EffectCompletionStatus,
        data: &[u8],
        catalog: &mut Catalog,
    ) -> ShellOperation {
        let Some(index) = self.pending_effects.iter().position(|e| e.id == effect_id) else {
            return ShellOperation::new(ShellStatus::StaleEffect, "effect is no longer pending");
        };
        let effect = self.pending_effects.remove(index);
        if status == EffectCompletionStatus::Success && effect.effect_type == EffectType::ExecuteQuery {
            if let Some(relations) = self.session_relations.as_mut() {
                if let Ok(query) = std::str::from_utf8(&effect.payload) {
                    relations.apply_successful_query(query, catalog);
                }
            }
        }
        match (effect.effect_type, status) {
            (EffectType::ExecuteQuery, EffectCompletionStatus::Success) => self.render_arrow_ipc(data),
            (EffectType::ExecuteCommand, EffectCompletionStatus::Success) => {
                if data.is_empty() {
                    return ShellOperation::new(ShellStatus::InternalError, "invalid shell command result");
                }
                self.clear_terminal_after_command = (data[0] & 1) != 0;
                ShellOperation::ok(data[1..].to_vec())
            }
            (_, EffectCompletionStatus::Error) => ShellOperation::ok(normalize_error(data)),
            (_, EffectCompletionStatus::Cancelled) => ShellOperation::ok("Cancelled"),
        }
    }

    /// Cancel an effect (`CancelEffect`)
    pub fn cancel_effect(&mut self, effect_id: u64, catalog: &mut Catalog) -> ShellOperation {
        self.complete_effect(effect_id, EffectCompletionStatus::Cancelled, &[], catalog)
    }

    /// Redraw the prompt with highlighting (`RenderTerminalPrompt`)
    fn render_terminal_prompt(&mut self) -> Vec<u8> {
        let prompt_text = self.prompt.text();
        let text = prompt_text.as_bytes();
        let terminal_prompt = self.terminal_prompt_text().to_vec();
        let mut highlighted = Vec::new();
        let command_begin = find_first_not_of(text, b" \t");
        let command_end = command_begin.and_then(|begin| find_first_of(text, b" \t\r\n", begin));
        let command_name_end = command_end.unwrap_or(text.len());
        let command_name: &[u8] = match command_begin {
            Some(begin) if text[begin] == b'.' => &text[begin + 1..command_name_end],
            _ => &[],
        };
        let is_registered_command = self.commands.iter().any(|c| c.as_bytes() == command_name);
        if is_registered_command {
            let command_begin = command_begin.unwrap_or(text.len());
            highlighted.extend_from_slice(&text[..command_begin]);
            push(&mut highlighted, vt100::BOLD);
            highlighted.extend_from_slice(&text[command_begin..command_name_end]);
            push(&mut highlighted, vt100::RESET_ATTRIBUTES);
            highlighted.extend_from_slice(&text[command_name_end..]);
        } else {
            let script = self.prompt.script_mut();
            if script.parsed.as_ref().is_none_or(|p| p.scanned.text_version != script.text_version()) {
                script.parse();
            }
            let parsed = script.parsed.as_ref().unwrap();
            let packed = pack_tokens(parsed);
            let offsets = packed.token_offsets.unwrap_or_default();
            let lengths = packed.token_lengths.unwrap_or_default();
            let types = packed.token_types.unwrap_or_default();
            let comments = &parsed.scanned.comments;
            highlighted.reserve(text.len() + (offsets.len() + comments.len()) * 16);
            let clamp = |i: usize| i.min(text.len());
            let mut offset = 0;
            let mut token_idx = 0;
            let mut comment_idx = 0;
            while token_idx < offsets.len() || comment_idx < comments.len() {
                let token_begin = offsets.get(token_idx).map_or(usize::MAX, |&o| o as usize);
                let comment_begin = comments.get(comment_idx).map_or(usize::MAX, |c| c.offset as usize);
                let is_comment = comment_begin < token_begin;
                let begin = if is_comment { comment_begin } else { token_begin };
                let length =
                    if is_comment { comments[comment_idx].length as usize } else { lengths[token_idx] as usize };
                let token_type = if is_comment { ScannerTokenType::COMMENT } else { types[token_idx] };
                let end = begin + length;
                if begin > offset {
                    highlighted.extend_from_slice(&text[clamp(offset)..clamp(begin)]);
                }
                let style = token_style(token_type);
                push(&mut highlighted, style);
                highlighted.extend_from_slice(&text[clamp(begin)..clamp(end)]);
                if !style.is_empty() {
                    push(&mut highlighted, vt100::RESET_ATTRIBUTES);
                }
                offset = end;
                if is_comment {
                    comment_idx += 1;
                } else {
                    token_idx += 1;
                }
            }
            highlighted.extend_from_slice(&text[clamp(offset)..]);
        }

        let terminal_columns = self.renderer.terminal_columns() as usize;
        let continuation = self.terminal_continuation.clone();
        let desired_layout = layout_prompt(text, &terminal_prompt, &continuation, terminal_columns);
        let previous_rows = self.terminal_prompt_rows;
        let rows_to_clear = previous_rows.max(desired_layout.rows);

        let mut output = Vec::new();
        append_cursor_move(&mut output, self.terminal_prompt_cursor_row, Command::CursorUp);
        for i in 0..previous_rows {
            push(&mut output, vt100::CARRIAGE_RETURN);
            push(&mut output, vt100::ERASE_ENTIRE_LINE);
            if i + 1 < previous_rows {
                append_cursor_move(&mut output, 1, Command::CursorDown);
            }
        }
        for _ in previous_rows..desired_layout.rows {
            push(&mut output, vt100::NEW_LINE);
        }
        append_cursor_move(&mut output, rows_to_clear - 1, Command::CursorUp);
        if previous_rows > 1 || desired_layout.rows > 1 {
            push(&mut output, vt100::CARRIAGE_RETURN);
        }

        let rendered_layout = render_highlighted_prompt(
            &mut output,
            &highlighted,
            &terminal_prompt,
            &continuation,
            &self.terminal_prompt_style,
            terminal_columns,
        );
        self.terminal_prompt_rows = rendered_layout.rows;

        let cursor = self.prompt.cursor_byte_offset();
        let cursor_layout = layout_prompt(&text[..cursor], &terminal_prompt, &continuation, terminal_columns);
        self.terminal_prompt_cursor_row = cursor_layout.rows - 1;
        if let Some(overlay) = self.overlay.as_mut() {
            overlay.cursor_row = self.terminal_prompt_cursor_row;
        }
        push(&mut output, vt100::CARRIAGE_RETURN);
        append_cursor_move(&mut output, self.terminal_prompt_rows - 1, Command::CursorUp);
        append_cursor_move(&mut output, self.terminal_prompt_cursor_row, Command::CursorDown);
        append_cursor_move(&mut output, cursor_layout.column, Command::CursorForward);
        output
    }

    fn open_terminal_completion_overlay(&mut self, candidates: Vec<CompletionCandidate>) -> Vec<u8> {
        let mut overlay = TerminalCompletionOverlay { candidates, ..Default::default() };
        let prompt_text = self.prompt.text();
        let text = prompt_text.as_bytes();
        let target = (overlay.candidates[0].target_offset as usize).min(text.len());
        let follows_dot = target > 0 && text[target - 1] == b'.';
        overlay.hint_only = !follows_dot && (overlay.candidates.len() == 1 || overlay.candidates[0].target_length == 0);
        let terminal_prompt = self.terminal_prompt_text().to_vec();
        let terminal_columns = self.renderer.terminal_columns() as usize;
        let target_layout =
            layout_prompt(&text[..target], &terminal_prompt, &self.terminal_continuation, terminal_columns);
        let cursor_layout = layout_prompt(
            &text[..self.prompt.cursor_byte_offset()],
            &terminal_prompt,
            &self.terminal_continuation,
            terminal_columns,
        );
        overlay.cursor_row = cursor_layout.rows - 1;
        overlay.anchor_column = target_layout.column;
        let max_content_width = if terminal_columns > 4 { terminal_columns - 4 } else { 1 };
        if overlay.anchor_column + 4 > terminal_columns {
            overlay.anchor_column = 0;
        }
        let max_variant_info_width = overlay
            .candidates
            .iter()
            .map(|c| completion_variant_info_width(c.qualification_texts.len()))
            .max()
            .unwrap_or(0);
        overlay.show_variant_info = max_variant_info_width < max_content_width;
        for candidate in overlay.candidates.iter_mut() {
            let variant_info_width = if overlay.show_variant_info {
                completion_variant_info_width(candidate.qualification_texts.len())
            } else {
                0
            };
            let display = truncate_display_text(
                &escape_terminal_text(candidate.display_text.as_bytes()),
                max_content_width - variant_info_width,
            );
            overlay.content_width = overlay.content_width.max(display_width(&display) + variant_info_width);
            candidate.display_text = String::from_utf8_lossy(&display).into_owned();
        }
        select_terminal_completion_hint(&mut overlay, text);
        if overlay.anchor_column + overlay.content_width + 4 > terminal_columns {
            overlay.anchor_column = if terminal_columns > overlay.content_width + 4 {
                terminal_columns - overlay.content_width - 4
            } else {
                0
            };
        }
        self.overlay = Some(overlay);
        self.render_terminal_completion_overlay()
    }

    fn refresh_terminal_completion_overlay(&mut self, catalog: &Catalog) -> Result<Vec<u8>, String> {
        let candidates = self.complete_prompt(50, catalog)?;
        if candidates.is_empty() {
            self.overlay = None;
            return Ok(Vec::new());
        }
        Ok(self.open_terminal_completion_overlay(candidates))
    }

    fn render_terminal_completion_overlay(&mut self) -> Vec<u8> {
        let mut output = self.clear_terminal_completion_overlay();
        let Some(overlay) = self.overlay.as_ref() else {
            return output;
        };
        if overlay.rows == 0 && !output.is_empty() {
            output.extend(self.render_terminal_prompt());
        }
        output.extend(self.render_terminal_completion_hint());
        let overlay = self.overlay.as_mut().unwrap();
        if overlay.hint_only {
            return output;
        }
        let window_end = (overlay.window_begin + TERMINAL_COMPLETION_ROWS).min(overlay.candidates.len());
        let candidate_rows = window_end - overlay.window_begin;
        overlay.rows = candidate_rows + 2;
        let horizontal = "─".repeat(overlay.content_width + 2);
        push(&mut output, vt100::SAVE_CURSOR);
        push(&mut output, vt100::CARRIAGE_RETURN);
        append_cursor_move(&mut output, 1, Command::CursorDown);
        append_cursor_move(&mut output, overlay.anchor_column, Command::CursorForward);
        push(&mut output, vt100::FOREGROUND_BRIGHT_BLACK);
        push(&mut output, "╭");
        push(&mut output, &horizontal);
        push(&mut output, "╮");
        push(&mut output, vt100::RESET_ATTRIBUTES);
        push(&mut output, vt100::NEW_LINE);
        for i in overlay.window_begin..window_end {
            append_cursor_move(&mut output, overlay.anchor_column, Command::CursorForward);
            push(&mut output, vt100::FOREGROUND_BRIGHT_BLACK);
            push(&mut output, "│");
            push(&mut output, vt100::RESET_ATTRIBUTES);
            output.push(b' ');
            if i == overlay.selection {
                push(&mut output, vt100::REVERSE_VIDEO);
            }
            let candidate = &overlay.candidates[i];
            push(&mut output, &candidate.display_text);
            let width = display_width(candidate.display_text.as_bytes());
            let variant_count = candidate.qualification_texts.len();
            if i == overlay.selection && overlay.show_variant_info && variant_count > 1 {
                let variant_info = format!(" <- {}/{} ->", overlay.variant_selection + 1, variant_count);
                output.extend(std::iter::repeat_n(
                    b' ',
                    overlay.content_width - width - display_width(variant_info.as_bytes()),
                ));
                push(&mut output, &variant_info);
            } else {
                output.extend(std::iter::repeat_n(b' ', overlay.content_width - width));
            }
            if i == overlay.selection {
                push(&mut output, vt100::RESET_ATTRIBUTES);
            }
            output.push(b' ');
            push(&mut output, vt100::FOREGROUND_BRIGHT_BLACK);
            push(&mut output, "│");
            push(&mut output, vt100::RESET_ATTRIBUTES);
            push(&mut output, vt100::NEW_LINE);
        }
        append_cursor_move(&mut output, overlay.anchor_column, Command::CursorForward);
        push(&mut output, vt100::FOREGROUND_BRIGHT_BLACK);
        push(&mut output, "╰");
        push(&mut output, &horizontal);
        push(&mut output, "╯");
        push(&mut output, vt100::RESET_ATTRIBUTES);
        push(&mut output, vt100::RESTORE_CURSOR);
        output
    }

    fn clear_terminal_completion_overlay(&mut self) -> Vec<u8> {
        let Some(overlay) = self.overlay.as_mut() else {
            return Vec::new();
        };
        let mut output = Vec::new();
        if overlay.hint_suffix_width > 0 {
            if overlay.hint_suffix_inserted {
                append_cursor_move(&mut output, overlay.hint_suffix_width, Command::DeleteCharacter);
            } else {
                push(&mut output, vt100::ERASE_LINE_FROM_CURSOR);
            }
            overlay.hint_suffix_width = 0;
            overlay.hint_suffix_inserted = false;
        }
        if overlay.hint_prefix_width > 0 {
            append_cursor_move(
                &mut output,
                overlay.hint_current_width + overlay.hint_prefix_width,
                Command::CursorBackward,
            );
            append_cursor_move(&mut output, overlay.hint_prefix_width, Command::DeleteCharacter);
            append_cursor_move(&mut output, overlay.hint_current_width, Command::CursorForward);
            overlay.hint_prefix_width = 0;
            overlay.hint_current_width = 0;
        }
        if overlay.rows == 0 {
            return output;
        }
        push(&mut output, vt100::SAVE_CURSOR);
        push(&mut output, vt100::CARRIAGE_RETURN);
        append_cursor_move(&mut output, 1, Command::CursorDown);
        for i in 0..overlay.rows {
            push(&mut output, vt100::ERASE_ENTIRE_LINE);
            if i + 1 < overlay.rows {
                append_cursor_move(&mut output, 1, Command::CursorDown);
                push(&mut output, vt100::CARRIAGE_RETURN);
            }
        }
        push(&mut output, vt100::RESTORE_CURSOR);
        overlay.rows = 0;
        output
    }

    fn render_terminal_completion_hint(&mut self) -> Vec<u8> {
        let cursor = self.prompt.cursor_byte_offset();
        let prompt_text = self.prompt.text();
        let text = prompt_text.as_bytes();
        let Some(overlay) = self.overlay.as_mut() else {
            return Vec::new();
        };
        let candidate = &overlay.candidates[overlay.selection];
        let target_end = candidate.target_offset as usize + candidate.target_length as usize;
        if target_end != cursor {
            return Vec::new();
        }
        let current = &text[candidate.target_offset as usize..target_end];
        let completion_text = candidate.completion_text.as_bytes();
        let mut prefix: Vec<u8> = Vec::new();
        let mut suffix: Vec<u8> = Vec::new();
        if overlay.hint_only {
            match find_bytes(completion_text, current) {
                Some(completion) => {
                    prefix = completion_text[..completion].to_vec();
                    suffix = completion_text[completion + current.len()..].to_vec();
                }
                None => suffix = completion_text.to_vec(),
            }
        } else if !candidate.qualification_texts.is_empty() {
            let variant = overlay.variant_selection.min(candidate.qualification_texts.len() - 1);
            let qualified = candidate.qualification_texts[variant].as_bytes();
            let completion = find_bytes(qualified, completion_text);
            let typed = ci_find(completion_text, current);
            if let (Some(completion), Some(typed)) = (completion, typed) {
                prefix = qualified[..completion + typed].to_vec();
                suffix = completion_text[typed + current.len()..].to_vec();
                suffix.extend_from_slice(&qualified[completion + completion_text.len()..]);
            }
        } else if ci_eq(completion_text, current) && !candidate.continuation_text.is_empty() {
            suffix = format!(" {}", candidate.continuation_text).into_bytes();
        } else if ci_starts_with(completion_text, current) {
            suffix = completion_text[current.len()..].to_vec();
        }
        if prefix.is_empty() && suffix.is_empty() && !candidate.continuation_text.is_empty() {
            suffix = format!(" {}", candidate.continuation_text).into_bytes();
        }
        if prefix.is_empty() && suffix.is_empty() {
            return Vec::new();
        }
        overlay.hint_prefix_width = display_width(&prefix);
        overlay.hint_suffix_width = display_width(&suffix);
        overlay.hint_current_width = display_width(current);
        let mut output = Vec::new();
        if !prefix.is_empty() {
            append_cursor_move(&mut output, overlay.hint_current_width, Command::CursorBackward);
            append_cursor_move(&mut output, overlay.hint_prefix_width, Command::InsertCharacter);
            push(&mut output, vt100::FOREGROUND_BRIGHT_BLACK);
            output.extend_from_slice(&prefix);
            push(&mut output, vt100::RESET_ATTRIBUTES);
            append_cursor_move(&mut output, overlay.hint_current_width, Command::CursorForward);
        }
        if !suffix.is_empty() {
            push(&mut output, vt100::SAVE_CURSOR);
            if target_end < text.len() {
                append_cursor_move(&mut output, overlay.hint_suffix_width, Command::InsertCharacter);
                overlay.hint_suffix_inserted = true;
            }
            push(&mut output, vt100::FOREGROUND_BRIGHT_BLACK);
            output.extend_from_slice(&suffix);
            push(&mut output, vt100::RESET_ATTRIBUTES);
            push(&mut output, vt100::RESTORE_CURSOR);
        }
        output
    }

    fn accept_terminal_completion(&mut self, catalog: &Catalog) -> Result<ShellOperation, String> {
        let mut output = self.clear_terminal_completion_overlay();
        let overlay = self.overlay.take().unwrap();
        let hint_only = overlay.hint_only;
        let variant_selection = overlay.variant_selection;
        let mut candidate = overlay.candidates.into_iter().nth(overlay.selection).unwrap();
        let continuation = candidate.continuation_text.clone();
        let qualification = if candidate.qualification_texts.is_empty() {
            String::new()
        } else {
            candidate.qualification_texts[variant_selection.min(candidate.qualification_texts.len() - 1)].clone()
        };
        let apply_qualification = self.auto_qualify_non_default_database_tables
            && !candidate.completion_text.ends_with("()")
            && is_non_default_three_part_name(qualification.as_bytes());
        if apply_qualification && !qualification.is_empty() {
            candidate.completion_text = qualification.clone();
            candidate.completion_cursor_offset = qualification.len() as u32;
            candidate.target_offset = candidate.qualification_target_offset;
            candidate.target_length = candidate.qualification_target_length;
        }
        let snapshot = self.apply_completion(&candidate);
        if snapshot.status != ShellStatus::Ok {
            return Ok(ShellOperation::new(snapshot.status, snapshot.message));
        }
        self.prompt.script_mut().parse();
        output.extend(self.render_terminal_prompt());
        if !apply_qualification && !qualification.is_empty() && qualification != candidate.completion_text {
            let cursor = self.prompt.cursor_byte_offset();
            let prompt_text = self.prompt.text();
            let completion_length = candidate.completion_text.len() as u32;
            self.overlay = Some(TerminalCompletionOverlay {
                hint_only: true,
                cursor_row: prompt_text.as_bytes()[..cursor].iter().filter(|&&c| c == b'\n').count(),
                candidates: vec![CompletionCandidate {
                    display_text: candidate.completion_text,
                    completion_text: qualification.clone(),
                    continuation_text: continuation,
                    completion_cursor_offset: qualification.len() as u32,
                    target_offset: candidate.qualification_target_offset,
                    target_length: completion_length,
                    qualification_target_offset: candidate.qualification_target_offset,
                    qualification_target_length: completion_length,
                    ..Default::default()
                }],
                ..Default::default()
            });
            output.extend(self.render_terminal_completion_hint());
        } else if !continuation.is_empty() {
            let cursor = self.prompt.cursor_byte_offset();
            let prompt_text = self.prompt.text();
            self.overlay = Some(TerminalCompletionOverlay {
                hint_only: true,
                cursor_row: prompt_text.as_bytes()[..cursor].iter().filter(|&&c| c == b'\n').count(),
                candidates: vec![CompletionCandidate {
                    display_text: continuation.clone(),
                    completion_text: format!(" {}", continuation),
                    completion_cursor_offset: (continuation.len() + 1) as u32,
                    target_offset: cursor as u32,
                    target_length: 0,
                    qualification_target_offset: cursor as u32,
                    qualification_target_length: 0,
                    ..Default::default()
                }],
                ..Default::default()
            });
            output.extend(self.render_terminal_completion_hint());
        } else if !hint_only {
            output.extend(self.refresh_terminal_completion_overlay(catalog)?);
        }
        Ok(ShellOperation::ok(output))
    }

    fn move_terminal_completion(&mut self, direction: i32) -> ShellOperation {
        let overlay = self.overlay.as_mut().unwrap();
        let count = overlay.candidates.len();
        if direction < 0 {
            overlay.selection = if overlay.selection == 0 { count - 1 } else { overlay.selection - 1 };
        } else {
            overlay.selection = (overlay.selection + 1) % count;
        }
        overlay.variant_selection = 0;
        if overlay.selection < overlay.window_begin {
            overlay.window_begin = overlay.selection;
        } else if overlay.selection >= overlay.window_begin + TERMINAL_COMPLETION_ROWS {
            overlay.window_begin = overlay.selection - TERMINAL_COMPLETION_ROWS + 1;
        }
        ShellOperation::ok(self.render_terminal_completion_overlay())
    }

    fn move_terminal_completion_variant(&mut self, direction: i32) -> ShellOperation {
        let overlay = self.overlay.as_mut().unwrap();
        let count = overlay.candidates[overlay.selection].qualification_texts.len();
        if count < 2 {
            return ShellOperation::ok(Vec::new());
        }
        if direction < 0 {
            overlay.variant_selection =
                if overlay.variant_selection == 0 { count - 1 } else { overlay.variant_selection - 1 };
        } else {
            overlay.variant_selection = (overlay.variant_selection + 1) % count;
        }
        ShellOperation::ok(self.render_terminal_completion_overlay())
    }
}

/// `std::string_view::find(needle)`
fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}
