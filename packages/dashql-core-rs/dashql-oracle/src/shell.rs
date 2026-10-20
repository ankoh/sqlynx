//! The C++ shell as an oracle: its C ABI (`include/dashql/shell/api.h`) and the helpers of
//! `tools/oracle_ffi_shell.cc`.

use crate::{take_bytes, OracleResult};
use std::ffi::c_void;
use std::os::raw::c_char;
use std::ptr;

#[repr(C)]
struct DashQLShellResult {
    status: u32,
    data_length: u32,
    data_ptr: *const u8,
    owner_ptr: *mut c_void,
}

#[repr(C)]
struct DashQLShellPromptResult {
    status: u32,
    revision_low: u32,
    revision_high: u32,
    cursor_byte_offset: u32,
    text_length: u32,
    text_ptr: *const u8,
    message_length: u32,
    message_ptr: *const u8,
    owner_ptr: *mut c_void,
    action: u32,
}

#[repr(C)]
struct DashQLShellTerminalResult {
    status: u32,
    action: u32,
    data_length: u32,
    data_ptr: *const u8,
    owner_ptr: *mut c_void,
}

#[repr(C)]
struct DashQLShellCompletionResult {
    count: u32,
    candidates_ptr: *const DashQLShellCompletionCandidate,
    owner_ptr: *mut c_void,
}

#[repr(C)]
struct DashQLShellCompletionCandidate {
    display_text_length: u32,
    display_text_ptr: *const u8,
    completion_text_length: u32,
    completion_text_ptr: *const u8,
    target_offset: u32,
    target_length: u32,
}

macro_rules! zeroed {
    ($t:ty) => {
        // SAFETY: the result structs are plain data, all-zero is their reset state
        unsafe { std::mem::zeroed::<$t>() }
    };
}

extern "C" {
    fn dashql_shell_new(catalog: *mut c_void, terminal_columns: u32, auto_qualify: bool) -> *mut c_void;
    fn dashql_shell_destroy(shell: *mut c_void);
    fn dashql_shell_resize(shell: *mut c_void, terminal_columns: u32);
    fn dashql_shell_keyword_case_set(shell: *mut c_void, keyword_case: u32);
    fn dashql_shell_session_relations_set(shell: *mut c_void, enabled: bool) -> u32;
    fn dashql_shell_commands_set(shell: *mut c_void, commands: *const u8, length: usize) -> u32;
    fn dashql_shell_prompt_set(shell: *mut c_void, text: *const u8, length: usize, result: *mut DashQLShellPromptResult) -> u32;
    fn dashql_shell_prompt_insert(shell: *mut c_void, text: *const u8, length: usize, result: *mut DashQLShellPromptResult) -> u32;
    fn dashql_shell_prompt_move_left(shell: *mut c_void, result: *mut DashQLShellPromptResult) -> u32;
    fn dashql_shell_prompt_move_right(shell: *mut c_void, result: *mut DashQLShellPromptResult) -> u32;
    fn dashql_shell_prompt_delete_backward(shell: *mut c_void, result: *mut DashQLShellPromptResult) -> u32;
    fn dashql_shell_prompt_delete_forward(shell: *mut c_void, result: *mut DashQLShellPromptResult) -> u32;
    fn dashql_shell_prompt_complete(shell: *mut c_void, limit: usize, result: *mut DashQLShellCompletionResult) -> u32;
    fn dashql_shell_prompt_apply_completion(
        shell: *mut c_void,
        candidate: *const DashQLShellCompletionCandidate,
        result: *mut DashQLShellPromptResult,
    ) -> u32;
    fn dashql_shell_prompt_consume(shell: *mut c_void, key: u32, text: *const u8, length: usize, result: *mut DashQLShellPromptResult) -> u32;
    fn dashql_shell_prompt_submit(shell: *mut c_void, result: *mut DashQLShellResult) -> u32;
    fn dashql_shell_prompt_result_destroy(result: *mut DashQLShellPromptResult);
    fn dashql_shell_completion_result_destroy(result: *mut DashQLShellCompletionResult);
    fn dashql_shell_terminal_open(shell: *mut c_void, prompt: *const u8, length: usize, result: *mut DashQLShellTerminalResult) -> u32;
    fn dashql_shell_terminal_consume(shell: *mut c_void, key: u32, text: *const u8, length: usize, result: *mut DashQLShellTerminalResult) -> u32;
    fn dashql_shell_terminal_finish_query(
        shell: *mut c_void,
        output: *const u8,
        length: usize,
        error: bool,
        result: *mut DashQLShellTerminalResult,
    ) -> u32;
    fn dashql_shell_terminal_query_progress(
        shell: *mut c_void,
        message: *const u8,
        length: usize,
        advance_frame: bool,
        result: *mut DashQLShellTerminalResult,
    ) -> u32;
    fn dashql_shell_terminal_query_progress_clear(shell: *mut c_void, result: *mut DashQLShellTerminalResult) -> u32;
    fn dashql_shell_terminal_status(shell: *mut c_void, message: *const u8, length: usize, result: *mut DashQLShellTerminalResult) -> u32;
    fn dashql_shell_terminal_result_destroy(result: *mut DashQLShellTerminalResult);
    fn dashql_shell_history_export(shell: *mut c_void, result: *mut DashQLShellResult) -> u32;
    fn dashql_shell_history_import(shell: *mut c_void, data: *const u8, length: usize, result: *mut DashQLShellResult) -> u32;
    fn dashql_shell_start_query(shell: *mut c_void, query: *const u8, length: usize, result: *mut DashQLShellResult) -> u32;
    fn dashql_shell_complete_effect(
        shell: *mut c_void,
        effect_id_low: u32,
        effect_id_high: u32,
        completion_status: u32,
        data: *const u8,
        length: usize,
        result: *mut DashQLShellResult,
    ) -> u32;
    fn dashql_shell_cancel_effect(shell: *mut c_void, effect_id_low: u32, effect_id_high: u32, result: *mut DashQLShellResult) -> u32;
    fn dashql_shell_result_destroy(result: *mut DashQLShellResult);

    fn dashql_oracle_catalog_new() -> *mut c_void;
    fn dashql_oracle_catalog_destroy(catalog: *mut c_void);
    fn dashql_oracle_catalog_script_load(catalog: *mut c_void, text: *const c_char, length: usize, rank: u32) -> *mut c_void;
    fn dashql_oracle_catalog_script_destroy(script: *mut c_void);
    fn dashql_oracle_shell_render_ipc(data: *const u8, length: usize, terminal_columns: u32) -> OracleResult;
    fn dashql_oracle_utf8_next_grapheme(text: *const c_char, length: usize, offset: usize) -> usize;
    fn dashql_oracle_utf8_previous_grapheme(text: *const c_char, length: usize, offset: usize) -> usize;
    fn dashql_oracle_utf8_render_width(text: *const c_char, length: usize, offset: usize) -> usize;
}

/// A byte slice as a C ABI pointer, null for empty slices like the TS caller
fn ptr_of(data: &[u8]) -> *const u8 {
    if data.is_empty() {
        ptr::null()
    } else {
        data.as_ptr()
    }
}

/// Copy C ABI bytes
fn bytes(data: *const u8, length: u32) -> Vec<u8> {
    if length == 0 {
        return Vec::new();
    }
    // SAFETY: the shell owns `length` bytes at `data` until the result is destroyed
    unsafe { std::slice::from_raw_parts(data, length as usize).to_vec() }
}

/// A prompt result of the C ABI
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CxxPrompt {
    pub status: u32,
    pub revision: u64,
    pub cursor_byte_offset: u32,
    pub text: Vec<u8>,
    pub message: Vec<u8>,
    pub action: u32,
}

/// A terminal result of the C ABI
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CxxTerminal {
    pub status: u32,
    pub action: u32,
    pub data: Vec<u8>,
}

/// An operation result of the C ABI
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CxxOperation {
    pub status: u32,
    pub data: Vec<u8>,
}

/// A completion candidate of the C ABI
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CxxCandidate {
    pub display_text: Vec<u8>,
    pub completion_text: Vec<u8>,
    pub target_offset: u32,
    pub target_length: u32,
}

/// A C++ catalog
pub struct CxxCatalog {
    catalog: *mut c_void,
    scripts: Vec<*mut c_void>,
}

impl CxxCatalog {
    pub fn new() -> Self {
        // SAFETY: creates an owned catalog
        Self {
            catalog: unsafe { dashql_oracle_catalog_new() },
            scripts: Vec::new(),
        }
    }

    /// Analyze a script and load it with a rank, false if it cannot be loaded
    pub fn load_script(&mut self, text: &str, rank: u32) -> bool {
        // SAFETY: the catalog is alive, the oracle reads `length` bytes of the text
        let script = unsafe { dashql_oracle_catalog_script_load(self.catalog, text.as_ptr() as *const c_char, text.len(), rank) };
        if script.is_null() {
            return false;
        }
        self.scripts.push(script);
        true
    }
}

impl Default for CxxCatalog {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for CxxCatalog {
    fn drop(&mut self) {
        // SAFETY: scripts are destroyed before their catalog, each once
        unsafe {
            for script in self.scripts.drain(..).rev() {
                dashql_oracle_catalog_script_destroy(script);
            }
            dashql_oracle_catalog_destroy(self.catalog);
        }
    }
}

/// A C++ shell driven through its C ABI. Must be dropped before its catalog.
pub struct CxxShell {
    shell: *mut c_void,
}

macro_rules! prompt_call {
    ($f:ident($($arg:expr),*)) => {{
        let mut result = zeroed!(DashQLShellPromptResult);
        // SAFETY: the shell is alive and the result is destroyed after copying
        unsafe {
            $f($($arg,)* &mut result);
            let out = CxxPrompt {
                status: result.status,
                revision: result.revision_low as u64 | ((result.revision_high as u64) << 32),
                cursor_byte_offset: result.cursor_byte_offset,
                text: bytes(result.text_ptr, result.text_length),
                message: bytes(result.message_ptr, result.message_length),
                action: result.action,
            };
            dashql_shell_prompt_result_destroy(&mut result);
            out
        }
    }};
}

macro_rules! terminal_call {
    ($f:ident($($arg:expr),*)) => {{
        let mut result = zeroed!(DashQLShellTerminalResult);
        // SAFETY: the shell is alive and the result is destroyed after copying
        unsafe {
            $f($($arg,)* &mut result);
            let out = CxxTerminal {
                status: result.status,
                action: result.action,
                data: bytes(result.data_ptr, result.data_length),
            };
            dashql_shell_terminal_result_destroy(&mut result);
            out
        }
    }};
}

macro_rules! operation_call {
    ($f:ident($($arg:expr),*)) => {{
        let mut result = zeroed!(DashQLShellResult);
        // SAFETY: the shell is alive and the result is destroyed after copying
        unsafe {
            $f($($arg,)* &mut result);
            let out = CxxOperation {
                status: result.status,
                data: bytes(result.data_ptr, result.data_length),
            };
            dashql_shell_result_destroy(&mut result);
            out
        }
    }};
}

impl CxxShell {
    pub fn new(catalog: &CxxCatalog, terminal_columns: u32, auto_qualify: bool) -> Self {
        // SAFETY: the catalog outlives the shell (callers drop the shell first)
        Self {
            shell: unsafe { dashql_shell_new(catalog.catalog, terminal_columns, auto_qualify) },
        }
    }

    pub fn resize(&mut self, terminal_columns: u32) {
        // SAFETY: the shell is alive
        unsafe { dashql_shell_resize(self.shell, terminal_columns) }
    }

    pub fn set_keyword_case(&mut self, keyword_case: u32) {
        // SAFETY: the shell is alive
        unsafe { dashql_shell_keyword_case_set(self.shell, keyword_case) }
    }

    pub fn set_session_relations(&mut self, enabled: bool) -> u32 {
        // SAFETY: the shell is alive
        unsafe { dashql_shell_session_relations_set(self.shell, enabled) }
    }

    pub fn set_commands(&mut self, commands: &[u8]) -> u32 {
        // SAFETY: the shell is alive, the shell reads `length` bytes
        unsafe { dashql_shell_commands_set(self.shell, ptr_of(commands), commands.len()) }
    }

    pub fn prompt_set(&mut self, text: &[u8]) -> CxxPrompt {
        prompt_call!(dashql_shell_prompt_set(self.shell, ptr_of(text), text.len()))
    }

    pub fn prompt_insert(&mut self, text: &[u8]) -> CxxPrompt {
        prompt_call!(dashql_shell_prompt_insert(self.shell, ptr_of(text), text.len()))
    }

    pub fn prompt_move_left(&mut self) -> CxxPrompt {
        prompt_call!(dashql_shell_prompt_move_left(self.shell))
    }

    pub fn prompt_move_right(&mut self) -> CxxPrompt {
        prompt_call!(dashql_shell_prompt_move_right(self.shell))
    }

    pub fn prompt_delete_backward(&mut self) -> CxxPrompt {
        prompt_call!(dashql_shell_prompt_delete_backward(self.shell))
    }

    pub fn prompt_delete_forward(&mut self) -> CxxPrompt {
        prompt_call!(dashql_shell_prompt_delete_forward(self.shell))
    }

    /// Complete the prompt, the status if it fails
    pub fn prompt_complete(&mut self, limit: usize) -> Result<Vec<CxxCandidate>, u32> {
        let mut result = zeroed!(DashQLShellCompletionResult);
        // SAFETY: the shell is alive and the result is destroyed after copying
        unsafe {
            let status = dashql_shell_prompt_complete(self.shell, limit, &mut result);
            let mut out = Vec::new();
            for i in 0..result.count as usize {
                let c = &*result.candidates_ptr.add(i);
                out.push(CxxCandidate {
                    display_text: bytes(c.display_text_ptr, c.display_text_length),
                    completion_text: bytes(c.completion_text_ptr, c.completion_text_length),
                    target_offset: c.target_offset,
                    target_length: c.target_length,
                });
            }
            dashql_shell_completion_result_destroy(&mut result);
            if status == 0 {
                Ok(out)
            } else {
                Err(status)
            }
        }
    }

    pub fn prompt_apply_completion(&mut self, display_text: &[u8], completion_text: &[u8], target_offset: u32, target_length: u32) -> CxxPrompt {
        let candidate = DashQLShellCompletionCandidate {
            display_text_length: display_text.len() as u32,
            display_text_ptr: ptr_of(display_text),
            completion_text_length: completion_text.len() as u32,
            completion_text_ptr: ptr_of(completion_text),
            target_offset,
            target_length,
        };
        prompt_call!(dashql_shell_prompt_apply_completion(self.shell, &candidate))
    }

    pub fn prompt_consume(&mut self, key: u32, text: &[u8]) -> CxxPrompt {
        prompt_call!(dashql_shell_prompt_consume(self.shell, key, ptr_of(text), text.len()))
    }

    pub fn prompt_submit(&mut self) -> CxxOperation {
        operation_call!(dashql_shell_prompt_submit(self.shell))
    }

    pub fn terminal_open(&mut self, prompt: &[u8]) -> CxxTerminal {
        terminal_call!(dashql_shell_terminal_open(self.shell, ptr_of(prompt), prompt.len()))
    }

    pub fn terminal_consume(&mut self, key: u32, text: &[u8]) -> CxxTerminal {
        terminal_call!(dashql_shell_terminal_consume(self.shell, key, ptr_of(text), text.len()))
    }

    pub fn terminal_finish_query(&mut self, output: &[u8], error: bool) -> CxxTerminal {
        terminal_call!(dashql_shell_terminal_finish_query(self.shell, ptr_of(output), output.len(), error))
    }

    pub fn terminal_query_progress(&mut self, message: &[u8], advance_frame: bool) -> CxxTerminal {
        terminal_call!(dashql_shell_terminal_query_progress(self.shell, ptr_of(message), message.len(), advance_frame))
    }

    pub fn terminal_query_progress_clear(&mut self) -> CxxTerminal {
        terminal_call!(dashql_shell_terminal_query_progress_clear(self.shell))
    }

    pub fn terminal_status(&mut self, message: &[u8]) -> CxxTerminal {
        terminal_call!(dashql_shell_terminal_status(self.shell, ptr_of(message), message.len()))
    }

    pub fn history_export(&mut self) -> CxxOperation {
        operation_call!(dashql_shell_history_export(self.shell))
    }

    pub fn history_import(&mut self, data: &[u8]) -> CxxOperation {
        operation_call!(dashql_shell_history_import(self.shell, ptr_of(data), data.len()))
    }

    pub fn start_query(&mut self, query: &[u8]) -> CxxOperation {
        operation_call!(dashql_shell_start_query(self.shell, ptr_of(query), query.len()))
    }

    pub fn complete_effect(&mut self, effect_id: u64, completion_status: u32, data: &[u8]) -> CxxOperation {
        operation_call!(dashql_shell_complete_effect(
            self.shell,
            effect_id as u32,
            (effect_id >> 32) as u32,
            completion_status,
            ptr_of(data),
            data.len()
        ))
    }

    pub fn cancel_effect(&mut self, effect_id: u64) -> CxxOperation {
        operation_call!(dashql_shell_cancel_effect(self.shell, effect_id as u32, (effect_id >> 32) as u32))
    }
}

impl Drop for CxxShell {
    fn drop(&mut self) {
        // SAFETY: destroyed once
        unsafe { dashql_shell_destroy(self.shell) }
    }
}

/// Render Arrow IPC data with the C++ shell renderer: Ok with the table, Err with the Arrow status text
pub fn render_ipc(data: &[u8], terminal_columns: u32) -> Result<Vec<u8>, String> {
    // SAFETY: the oracle reads `length` bytes and returns an unreleased result
    unsafe { take_bytes(dashql_oracle_shell_render_ipc(ptr_of(data), data.len(), terminal_columns)) }
}

/// `Utf8Proc::NextGraphemeCluster`
pub fn utf8_next_grapheme(text: &[u8], offset: usize) -> usize {
    // SAFETY: the oracle copies `length` bytes
    unsafe { dashql_oracle_utf8_next_grapheme(text.as_ptr() as *const c_char, text.len(), offset) }
}

/// `Utf8Proc::PreviousGraphemeCluster`
pub fn utf8_previous_grapheme(text: &[u8], offset: usize) -> usize {
    // SAFETY: the oracle copies `length` bytes
    unsafe { dashql_oracle_utf8_previous_grapheme(text.as_ptr() as *const c_char, text.len(), offset) }
}

/// `Utf8Proc::RenderWidth(text, offset)`
pub fn utf8_render_width(text: &[u8], offset: usize) -> usize {
    // SAFETY: the oracle copies `length` bytes
    unsafe { dashql_oracle_utf8_render_width(text.as_ptr() as *const c_char, text.len(), offset) }
}
