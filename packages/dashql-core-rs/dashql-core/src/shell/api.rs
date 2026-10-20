//! A shell with a shared catalog and the argument checks of the C ABI (`src/shell/api.cc`).
//!
//! [`Shell`] maps the `dashql_shell_*` functions one to one: keys and completion statuses arrive as
//! integers and invalid values fail like in C, results carry the same status, data and action.
//! The wasm-bindgen module and the tests drive the shell through it.

use super::*;
use crate::catalog::Catalog;
use std::cell::RefCell;
use std::rc::Rc;

/// A catalog shared by the shell and its owner (the JS catalog object)
pub type SharedCatalog = Rc<RefCell<Catalog>>;

/// A shell session with its catalog (`DashQLShell`)
pub struct Shell {
    catalog: SharedCatalog,
    session: ShellSession,
}

fn invalid_prompt(message: &str) -> PromptSnapshot {
    PromptSnapshot {
        status: ShellStatus::InvalidArgument,
        revision: 0,
        cursor_byte_offset: 0,
        text: String::new(),
        message: message.to_string(),
        action: PromptInputAction::None,
    }
}

fn invalid_terminal(message: &str) -> TerminalOutput {
    TerminalOutput {
        status: ShellStatus::InvalidArgument,
        action: PromptInputAction::None,
        data: message.as_bytes().to_vec(),
    }
}

impl Shell {
    /// `dashql_shell_new`
    pub fn new(catalog: SharedCatalog, terminal_columns: u32, auto_qualify_non_default_database_tables: bool) -> Self {
        let session = ShellSession::new(&catalog.borrow(), terminal_columns, auto_qualify_non_default_database_tables);
        Self { catalog, session }
    }

    pub fn catalog(&self) -> &SharedCatalog {
        &self.catalog
    }

    pub fn session(&self) -> &ShellSession {
        &self.session
    }

    pub fn session_mut(&mut self) -> &mut ShellSession {
        &mut self.session
    }

    /// `dashql_shell_resize`
    pub fn resize(&mut self, terminal_columns: u32) {
        self.session.resize(terminal_columns);
    }

    /// `dashql_shell_keyword_case_set`
    pub fn set_keyword_case(&mut self, keyword_case: u32) {
        self.session.set_keyword_case(keyword_case);
    }

    /// `dashql_shell_session_relations_set`
    pub fn set_session_relations(&mut self, enabled: bool) -> ShellStatus {
        self.session.set_track_session_relations(enabled, &mut self.catalog.borrow_mut());
        ShellStatus::Ok
    }

    /// `dashql_shell_commands_set`
    pub fn set_commands(&mut self, commands: &[u8]) -> ShellStatus {
        self.session.set_commands(commands)
    }

    /// `dashql_shell_prompt_set`
    pub fn prompt_set(&mut self, text: &[u8]) -> PromptSnapshot {
        self.session.set_prompt(text)
    }

    /// `dashql_shell_prompt_insert`
    pub fn prompt_insert(&mut self, text: &[u8]) -> PromptSnapshot {
        self.session.insert_prompt(text)
    }

    /// `dashql_shell_prompt_move_left`
    pub fn prompt_move_left(&mut self) -> PromptSnapshot {
        self.session.move_prompt_left()
    }

    /// `dashql_shell_prompt_move_right`
    pub fn prompt_move_right(&mut self) -> PromptSnapshot {
        self.session.move_prompt_right()
    }

    /// `dashql_shell_prompt_delete_backward`
    pub fn prompt_delete_backward(&mut self) -> PromptSnapshot {
        self.session.delete_prompt_backward()
    }

    /// `dashql_shell_prompt_delete_forward`
    pub fn prompt_delete_forward(&mut self) -> PromptSnapshot {
        self.session.delete_prompt_forward()
    }

    /// `dashql_shell_prompt_complete`: failures only report `InternalError`
    pub fn prompt_complete(&mut self, limit: usize) -> Result<Vec<CompletionCandidate>, ShellStatus> {
        self.session.complete_prompt(limit, &self.catalog.borrow()).map_err(|_| ShellStatus::InternalError)
    }

    /// `dashql_shell_prompt_apply_completion` with the fields of `DashQLShellCompletionCandidate`
    pub fn prompt_apply_completion(&mut self, display_text: &[u8], completion_text: &[u8], target_offset: u32, target_length: u32) -> PromptSnapshot {
        self.session.apply_completion_bytes(display_text, completion_text, target_offset, target_length)
    }

    /// `dashql_shell_prompt_consume`
    pub fn prompt_consume(&mut self, key: u32, text: &[u8]) -> PromptSnapshot {
        match PromptInputKey::from_u32(key) {
            Some(key) => self.session.consume_prompt_input(key, text),
            None => invalid_prompt("invalid prompt input"),
        }
    }

    /// `dashql_shell_prompt_submit`
    pub fn prompt_submit(&mut self) -> ShellOperation {
        self.session.submit_prompt(&self.catalog.borrow())
    }

    /// `dashql_shell_terminal_open`
    pub fn terminal_open(&mut self, prompt: &[u8]) -> TerminalOutput {
        self.session.open_terminal(prompt)
    }

    /// `dashql_shell_terminal_consume`
    pub fn terminal_consume(&mut self, key: u32, text: &[u8]) -> TerminalOutput {
        match PromptInputKey::from_u32(key) {
            Some(key) => self.session.consume_terminal_input(key, text, &self.catalog.borrow()),
            None => invalid_terminal("invalid terminal input"),
        }
    }

    /// `dashql_shell_terminal_finish_query`
    pub fn terminal_finish_query(&mut self, output: &[u8], error: bool) -> TerminalOutput {
        self.session.finish_terminal_query(output, error)
    }

    /// `dashql_shell_terminal_query_progress`
    pub fn terminal_query_progress(&mut self, message: &[u8], advance_frame: bool) -> TerminalOutput {
        self.session.render_terminal_query_progress(message, advance_frame)
    }

    /// `dashql_shell_terminal_query_progress_clear`
    pub fn terminal_query_progress_clear(&mut self) -> TerminalOutput {
        self.session.clear_terminal_query_progress()
    }

    /// `dashql_shell_terminal_status`
    pub fn terminal_status(&mut self, message: &[u8]) -> TerminalOutput {
        self.session.render_terminal_status(message)
    }

    /// `dashql_shell_history_export`
    pub fn history_export(&self) -> Vec<u8> {
        self.session.export_history()
    }

    /// `dashql_shell_history_import`
    pub fn history_import(&mut self, data: &[u8]) -> ShellStatus {
        self.session.import_history(data)
    }

    /// `dashql_shell_start_query`
    pub fn start_query(&mut self, query: &[u8]) -> ShellOperation {
        self.session.start_query(query, &self.catalog.borrow())
    }

    /// `dashql_shell_complete_effect`
    pub fn complete_effect(&mut self, effect_id: u64, completion_status: u32, data: &[u8]) -> ShellOperation {
        match EffectCompletionStatus::from_u32(completion_status) {
            Some(status) => self.session.complete_effect(effect_id, status, data, &mut self.catalog.borrow_mut()),
            None => ShellOperation::new(ShellStatus::InvalidArgument, "invalid effect completion"),
        }
    }

    /// `dashql_shell_cancel_effect`
    pub fn cancel_effect(&mut self, effect_id: u64) -> ShellOperation {
        self.session.cancel_effect(effect_id, &mut self.catalog.borrow_mut())
    }
}

impl Drop for Shell {
    /// `dashql_shell_destroy`: the session relations leave the catalog
    fn drop(&mut self) {
        if let Ok(mut catalog) = self.catalog.try_borrow_mut() {
            self.session.detach(&mut catalog);
        }
    }
}
