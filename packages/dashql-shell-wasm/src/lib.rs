//! The wasm-bindgen API of the shell, the replacement of the C ABI in the C++ `src/shell/api.cc`.
//!
//! Like the C++ shell wasm, the module carries the whole core: it re-exports the core bindings
//! (`Catalog`, `Script`, `ScriptBatch`, `PlanViewModel`, `processBatch`, ...) with their JS names, so a shell
//! takes a `Catalog` of the same module and JS uses one initialized module for the core and the shell.
//!
//! Keys, completion statuses and statuses are the numbers of the C ABI enums (`DashQLShellPromptInputKey`,
//! `DashQLShellEffectCompletionStatus`, `DashQLShellStatus`). Results carry the status instead of throwing, like
//! the C ABI, except `completePrompt`, which throws when the completion fails (C ABI: `INTERNAL_ERROR`).

pub use dashql_core_wasm_lib::*;

use dashql_core::shell::{CompletionCandidate, PromptSnapshot, ShellOperation as CoreOperation, TerminalOutput};
use wasm_bindgen::prelude::*;

/// A prompt after an input (`DashQLShellPromptResult`)
#[wasm_bindgen]
pub struct ShellPromptResult {
    /// The core prompt snapshot
    inner: PromptSnapshot,
}

#[wasm_bindgen]
impl ShellPromptResult {
    /// The `DashQLShellStatus`
    #[wasm_bindgen(getter)]
    pub fn status(&self) -> u32 {
        self.inner.status as u32
    }

    /// The prompt revision, bumped by every edit
    #[wasm_bindgen(getter)]
    pub fn revision(&self) -> u64 {
        self.inner.revision
    }

    /// The UTF-8 byte offset of the cursor
    #[wasm_bindgen(getter, js_name = cursorByteOffset)]
    pub fn cursor_byte_offset(&self) -> u32 {
        self.inner.cursor_byte_offset
    }

    #[wasm_bindgen(getter)]
    pub fn text(&self) -> String {
        self.inner.text.clone()
    }

    /// The error message if the status is not OK
    #[wasm_bindgen(getter)]
    pub fn message(&self) -> String {
        self.inner.message.clone()
    }

    /// The `DashQLShellPromptInputAction`
    #[wasm_bindgen(getter)]
    pub fn action(&self) -> u32 {
        self.inner.action as u32
    }
}

/// Terminal output (`DashQLShellTerminalResult`)
#[wasm_bindgen]
pub struct ShellTerminalResult {
    /// The core terminal output
    inner: TerminalOutput,
}

#[wasm_bindgen]
impl ShellTerminalResult {
    /// The `DashQLShellStatus`
    #[wasm_bindgen(getter)]
    pub fn status(&self) -> u32 {
        self.inner.status as u32
    }

    /// The `DashQLShellPromptInputAction`
    #[wasm_bindgen(getter)]
    pub fn action(&self) -> u32 {
        self.inner.action as u32
    }

    /// The VT100 output, or the error message if the status is not OK
    #[wasm_bindgen(getter)]
    pub fn data(&self) -> String {
        String::from_utf8_lossy(&self.inner.data).into_owned()
    }
}

/// The result of an operation: rendered output, an effect or an error (`DashQLShellResult`)
#[wasm_bindgen]
pub struct ShellOperation {
    /// The core operation result
    inner: CoreOperation,
}

impl ShellOperation {
    fn effect_header(&self) -> Option<(u32, u64)> {
        if self.inner.status != dashql_core::shell::ShellStatus::Pending || self.inner.data.len() < 16 {
            return None;
        }
        let data = &self.inner.data;
        Some((u32::from_le_bytes(data[4..8].try_into().unwrap()), u64::from_le_bytes(data[8..16].try_into().unwrap())))
    }
}

#[wasm_bindgen]
impl ShellOperation {
    /// The `DashQLShellStatus`, `PENDING` if the operation waits for an effect
    #[wasm_bindgen(getter)]
    pub fn status(&self) -> u32 {
        self.inner.status as u32
    }

    /// The raw data: the output, the error message, or the effect envelope (version u32, type u32, id u64, payload)
    #[wasm_bindgen(getter)]
    pub fn data(&self) -> Vec<u8> {
        self.inner.data.clone()
    }

    /// The data as text (output or error message)
    #[wasm_bindgen(getter)]
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.inner.data).into_owned()
    }

    /// The effect type of a pending operation (`DashQLShellEffectType`)
    #[wasm_bindgen(getter, js_name = effectType)]
    pub fn effect_type(&self) -> Option<u32> {
        self.effect_header().map(|(t, _)| t)
    }

    /// The effect id of a pending operation
    #[wasm_bindgen(getter, js_name = effectId)]
    pub fn effect_id(&self) -> Option<u64> {
        self.effect_header().map(|(_, id)| id)
    }

    /// The effect payload of a pending operation: the query or the dot command
    #[wasm_bindgen(getter, js_name = effectPayload)]
    pub fn effect_payload(&self) -> Option<String> {
        self.effect_header().map(|_| String::from_utf8_lossy(&self.inner.data[16..]).into_owned())
    }
}

/// A completion candidate (`DashQLShellCompletionCandidate`)
#[wasm_bindgen]
pub struct ShellCompletionCandidate {
    /// The core completion candidate
    inner: CompletionCandidate,
}

#[wasm_bindgen]
impl ShellCompletionCandidate {
    #[wasm_bindgen(getter, js_name = displayText)]
    pub fn display_text(&self) -> String {
        self.inner.display_text.clone()
    }

    #[wasm_bindgen(getter, js_name = completionText)]
    pub fn completion_text(&self) -> String {
        self.inner.completion_text.clone()
    }

    /// The UTF-8 byte offset of the replaced text
    #[wasm_bindgen(getter, js_name = targetOffset)]
    pub fn target_offset(&self) -> u32 {
        self.inner.target_offset
    }

    /// The UTF-8 byte length of the replaced text
    #[wasm_bindgen(getter, js_name = targetLength)]
    pub fn target_length(&self) -> u32 {
        self.inner.target_length
    }
}

fn prompt(inner: PromptSnapshot) -> ShellPromptResult {
    ShellPromptResult { inner }
}

fn terminal(inner: TerminalOutput) -> ShellTerminalResult {
    ShellTerminalResult { inner }
}

fn operation(inner: CoreOperation) -> ShellOperation {
    ShellOperation { inner }
}

/// A shell session on a catalog (`dashql_shell_*`). Freeing it drops the session relations from the catalog.
#[wasm_bindgen]
pub struct Shell {
    /// The core shell
    inner: dashql_core::shell::Shell,
}

#[wasm_bindgen]
impl Shell {
    /// `dashql_shell_new`
    #[wasm_bindgen(constructor)]
    pub fn new(catalog: &Catalog, terminal_columns: u32, auto_qualify_non_default_database_tables: bool) -> Shell {
        Shell {
            inner: dashql_core::shell::Shell::new(catalog.shared(), terminal_columns, auto_qualify_non_default_database_tables),
        }
    }

    pub fn resize(&mut self, terminal_columns: u32) {
        self.inner.resize(terminal_columns);
    }

    /// The color of the terminal prompt as 0xRRGGBB, bold in the default foreground color if undefined
    #[wasm_bindgen(js_name = setTerminalPromptColor)]
    pub fn set_terminal_prompt_color(&mut self, rgb: Option<u32>) {
        self.inner.set_terminal_prompt_color(rgb.map(|rgb| [(rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8]));
    }

    /// The `KeywordCase` of completions (1 is upper case)
    #[wasm_bindgen(js_name = setKeywordCase)]
    pub fn set_keyword_case(&mut self, keyword_case: u32) {
        self.inner.set_keyword_case(keyword_case);
    }

    /// Track relations of successful DDL queries in the catalog, returns the status
    #[wasm_bindgen(js_name = setSessionRelations)]
    pub fn set_session_relations(&mut self, enabled: bool) -> u32 {
        self.inner.set_session_relations(enabled) as u32
    }

    /// Register dot commands, one name per line, returns the status
    #[wasm_bindgen(js_name = setCommands)]
    pub fn set_commands(&mut self, commands: &str) -> u32 {
        self.inner.set_commands(commands.as_bytes()) as u32
    }

    #[wasm_bindgen(js_name = setPrompt)]
    pub fn set_prompt(&mut self, text: &str) -> ShellPromptResult {
        prompt(self.inner.prompt_set(text.as_bytes()))
    }

    #[wasm_bindgen(js_name = insertPrompt)]
    pub fn insert_prompt(&mut self, text: &str) -> ShellPromptResult {
        prompt(self.inner.prompt_insert(text.as_bytes()))
    }

    #[wasm_bindgen(js_name = movePromptLeft)]
    pub fn move_prompt_left(&mut self) -> ShellPromptResult {
        prompt(self.inner.prompt_move_left())
    }

    #[wasm_bindgen(js_name = movePromptRight)]
    pub fn move_prompt_right(&mut self) -> ShellPromptResult {
        prompt(self.inner.prompt_move_right())
    }

    #[wasm_bindgen(js_name = deletePromptBackward)]
    pub fn delete_prompt_backward(&mut self) -> ShellPromptResult {
        prompt(self.inner.prompt_delete_backward())
    }

    #[wasm_bindgen(js_name = deletePromptForward)]
    pub fn delete_prompt_forward(&mut self) -> ShellPromptResult {
        prompt(self.inner.prompt_delete_forward())
    }

    /// Complete at the cursor, throws if the completion fails
    #[wasm_bindgen(js_name = completePrompt)]
    pub fn complete_prompt(&mut self, limit: usize) -> Result<Vec<ShellCompletionCandidate>, JsError> {
        match self.inner.prompt_complete(limit) {
            Ok(candidates) => Ok(candidates.into_iter().map(|inner| ShellCompletionCandidate { inner }).collect()),
            Err(_) => Err(JsError::new("failed to complete shell prompt")),
        }
    }

    #[wasm_bindgen(js_name = applyCompletion)]
    pub fn apply_completion(&mut self, display_text: &str, completion_text: &str, target_offset: u32, target_length: u32) -> ShellPromptResult {
        prompt(self.inner.prompt_apply_completion(display_text.as_bytes(), completion_text.as_bytes(), target_offset, target_length))
    }

    #[wasm_bindgen(js_name = consumePromptInput)]
    pub fn consume_prompt_input(&mut self, key: u32, text: &str) -> ShellPromptResult {
        prompt(self.inner.prompt_consume(key, text.as_bytes()))
    }

    #[wasm_bindgen(js_name = submitPrompt)]
    pub fn submit_prompt(&mut self) -> ShellOperation {
        operation(self.inner.prompt_submit())
    }

    #[wasm_bindgen(js_name = openTerminal)]
    pub fn open_terminal(&mut self, prompt: &str) -> ShellTerminalResult {
        terminal(self.inner.terminal_open(prompt.as_bytes()))
    }

    #[wasm_bindgen(js_name = consumeTerminalInput)]
    pub fn consume_terminal_input(&mut self, key: u32, text: &str) -> ShellTerminalResult {
        terminal(self.inner.terminal_consume(key, text.as_bytes()))
    }

    #[wasm_bindgen(js_name = finishTerminalQuery)]
    pub fn finish_terminal_query(&mut self, output: &str, error: bool) -> ShellTerminalResult {
        terminal(self.inner.terminal_finish_query(output.as_bytes(), error))
    }

    #[wasm_bindgen(js_name = renderTerminalQueryProgress)]
    pub fn render_terminal_query_progress(&mut self, message: &str, advance_frame: bool) -> ShellTerminalResult {
        terminal(self.inner.terminal_query_progress(message.as_bytes(), advance_frame))
    }

    #[wasm_bindgen(js_name = clearTerminalQueryProgress)]
    pub fn clear_terminal_query_progress(&mut self) -> ShellTerminalResult {
        terminal(self.inner.terminal_query_progress_clear())
    }

    #[wasm_bindgen(js_name = renderTerminalStatus)]
    pub fn render_terminal_status(&mut self, message: &str) -> ShellTerminalResult {
        terminal(self.inner.terminal_status(message.as_bytes()))
    }

    /// The history as length-prefixed (u32 little-endian) UTF-8 entries
    #[wasm_bindgen(js_name = exportHistory)]
    pub fn export_history(&self) -> Vec<u8> {
        self.inner.history_export()
    }

    /// Replace the history with exported entries, returns the status
    #[wasm_bindgen(js_name = importHistory)]
    pub fn import_history(&mut self, data: &[u8]) -> u32 {
        self.inner.history_import(data) as u32
    }

    #[wasm_bindgen(js_name = startQuery)]
    pub fn start_query(&mut self, query: &str) -> ShellOperation {
        operation(self.inner.start_query(query.as_bytes()))
    }

    /// Finish an effect with a `DashQLShellEffectCompletionStatus` and its data (Arrow IPC for queries, a flag
    /// byte and the output for dot commands, the message for errors)
    #[wasm_bindgen(js_name = completeEffect)]
    pub fn complete_effect(&mut self, effect_id: u64, completion_status: u32, data: &[u8]) -> ShellOperation {
        operation(self.inner.complete_effect(effect_id, completion_status, data))
    }

    #[wasm_bindgen(js_name = cancelEffect)]
    pub fn cancel_effect(&mut self, effect_id: u64) -> ShellOperation {
        operation(self.inner.cancel_effect(effect_id))
    }
}
