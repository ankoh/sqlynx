//! A port of the C++ `test/shell_api_test.cc`.
//!
//! The C++ tests drive the C ABI of the shell wasm. They drive [`Shell`] here, which maps the C ABI
//! one to one (keys and completion statuses as integers, the same results and actions).

use dashql_core::catalog::Catalog;
use dashql_core::script::Script;
use dashql_core::shell::vt100::{self, sequence, Command};
use dashql_core::shell::{PromptInputAction, PromptInputKey as Key, SharedCatalog, Shell, ShellStatus, TerminalOutput};
use std::cell::RefCell;
use std::rc::Rc;

const EFFECT_SUCCESS: u32 = 0;
const EFFECT_ERROR: u32 = 1;

fn catalog() -> SharedCatalog {
    Rc::new(RefCell::new(Catalog::new()))
}

/// Analyze a script and load it into the catalog with rank 0. The script must stay alive.
fn load_schema(catalog: &SharedCatalog, text: &str) -> Script {
    let mut schema = Script::new(&catalog.borrow());
    schema.insert_text_at(0, text);
    schema.analyze(&catalog.borrow(), true).unwrap();
    catalog.borrow_mut().load_script(schema.analyzed.clone().unwrap(), 0).unwrap();
    schema
}

fn shell(catalog: &SharedCatalog, columns: u32) -> Shell {
    Shell::new(catalog.clone(), columns, false)
}

fn data(output: &TerminalOutput) -> String {
    String::from_utf8_lossy(&output.data).into_owned()
}

fn consume(shell: &mut Shell, key: Key, text: &str) -> TerminalOutput {
    shell.terminal_consume(key as u32, text.as_bytes())
}

fn count_occurrences(text: &str, needle: &str) -> usize {
    text.matches(needle).count()
}

fn read_u64(data: &[u8]) -> u64 {
    u64::from_le_bytes(data[..8].try_into().unwrap())
}

fn complete_query(shell: &mut Shell, query: &str, completion_status: u32) -> ShellStatus {
    let result = shell.start_query(query.as_bytes());
    assert_eq!(result.status, ShellStatus::Pending);
    if result.status != ShellStatus::Pending || result.data.len() < 16 {
        return ShellStatus::InternalError;
    }
    let effect_id = read_u64(&result.data[8..]);
    shell.complete_effect(effect_id, completion_status, &[]).status
}

fn complete_text(shell: &mut Shell, query: &str) -> Vec<String> {
    assert_eq!(shell.prompt_set(query.as_bytes()).status, ShellStatus::Ok);
    shell.prompt_complete(50).unwrap().into_iter().map(|c| c.completion_text).collect()
}

fn has_completion(shell: &mut Shell, query: &str, expected: &str) -> bool {
    complete_text(shell, query).iter().any(|c| c == expected)
}

fn completion_texts(shell: &mut Shell) -> Vec<String> {
    shell.prompt_complete(50).unwrap().into_iter().map(|c| c.completion_text).collect()
}

/// Select a terminal candidate by its inserted text and return its index and the rendered hint
fn select_terminal_completion(shell: &mut Shell, completion_text: &str) -> (usize, TerminalOutput) {
    let candidates = completion_texts(shell);
    let index = candidates.iter().position(|c| c == completion_text);
    assert!(index.is_some(), "{candidates:?}");
    let index = index.unwrap_or(candidates.len());
    let mut output = TerminalOutput {
        status: ShellStatus::Ok,
        action: PromptInputAction::None,
        data: Vec::new(),
    };
    for _ in 0..index {
        output = consume(shell, Key::HistoryNext, "");
        assert_eq!(output.status, ShellStatus::Ok);
    }
    if index == 0 {
        assert_eq!(consume(shell, Key::HistoryNext, "").status, ShellStatus::Ok);
        output = consume(shell, Key::HistoryPrevious, "");
        assert_eq!(output.status, ShellStatus::Ok);
    }
    (index, output)
}

fn history(entries: &[&str]) -> Vec<u8> {
    let mut out = Vec::new();
    for entry in entries {
        out.extend_from_slice(&(entry.len() as u32).to_le_bytes());
        out.extend_from_slice(entry.as_bytes());
    }
    out
}

fn bright(text: &str) -> String {
    format!("{}{}", vt100::FOREGROUND_BRIGHT_BLACK, text)
}

#[test]
fn edits_and_submits_prompt() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    let query = "select 1";
    let prompt = shell.prompt_set(query.as_bytes());
    assert_eq!(prompt.status, ShellStatus::Ok);
    assert_eq!(prompt.text, query);
    assert_eq!(prompt.cursor_byte_offset as usize, query.len());
    assert_eq!(prompt.revision, 1);

    let prompt = shell.prompt_move_left();
    assert_eq!(prompt.cursor_byte_offset as usize, query.len() - 1);

    let prompt = shell.prompt_insert(b"0");
    assert_eq!(prompt.text, "select 01");

    let operation = shell.prompt_submit();
    assert_eq!(operation.status, ShellStatus::Pending);
    assert!(operation.data.len() >= 16);
    assert_eq!(&operation.data[16..], b"select 01");
}

#[test]
fn tracks_created_and_dropped_session_relations() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);
    shell.set_session_relations(true);

    assert_eq!(complete_query(&mut shell, "CREATE TABLE orders (order_id BIGINT, amount DOUBLE)", EFFECT_SUCCESS), ShellStatus::ArrowError);
    assert!(has_completion(&mut shell, "select * from ord", "orders"));
    assert!(has_completion(&mut shell, "select * from orders where orders.", "order_id"));

    assert_eq!(complete_query(&mut shell, "DROP TABLE orders", EFFECT_SUCCESS), ShellStatus::ArrowError);
    assert!(!has_completion(&mut shell, "select * from ord", "orders"));
}

#[test]
fn tracks_qualified_and_derived_session_relations() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);
    shell.set_session_relations(true);

    assert_eq!(complete_query(&mut shell, "CREATE TABLE source (id BIGINT, amount DOUBLE)", EFFECT_SUCCESS), ShellStatus::ArrowError);
    assert_eq!(
        complete_query(&mut shell, "CREATE TABLE analytics.totals AS SELECT id, amount AS total FROM source", EFFECT_SUCCESS),
        ShellStatus::ArrowError
    );
    assert_eq!(complete_query(&mut shell, "CREATE VIEW report AS SELECT * FROM analytics.totals", EFFECT_SUCCESS), ShellStatus::ArrowError);
    assert_eq!(
        complete_query(&mut shell, "SELECT id AS copied_id INTO warehouse.reporting.copied FROM source", EFFECT_SUCCESS),
        ShellStatus::ArrowError
    );

    assert!(has_completion(&mut shell, "select * from analytics.tot", "totals"));
    assert!(has_completion(&mut shell, "select * from analytics.totals t where t.", "total"));
    assert!(has_completion(&mut shell, "select * from report where report.", "total"));
    assert!(has_completion(&mut shell, "select * from warehouse.reporting.copied where copied.", "copied_id"));
}

#[test]
fn replaces_and_selectively_drops_session_relations() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);
    shell.set_session_relations(true);

    assert_eq!(complete_query(&mut shell, "CREATE TABLE inventory (old_id BIGINT)", EFFECT_SUCCESS), ShellStatus::ArrowError);
    assert_eq!(
        complete_query(&mut shell, "CREATE TABLE inventory (new_id BIGINT, quantity INTEGER)", EFFECT_SUCCESS),
        ShellStatus::ArrowError
    );
    assert!(!has_completion(&mut shell, "select * from inventory i where i.old", "old_id"));
    assert!(has_completion(&mut shell, "select * from inventory i where i.new", "new_id"));
    assert!(has_completion(&mut shell, "select * from inventory i where i.quan", "quantity"));

    assert_eq!(complete_query(&mut shell, "CREATE TABLE public.events (public_id BIGINT)", EFFECT_SUCCESS), ShellStatus::ArrowError);
    assert_eq!(complete_query(&mut shell, "CREATE TABLE analytics.events (analytics_id BIGINT)", EFFECT_SUCCESS), ShellStatus::ArrowError);
    assert_eq!(complete_query(&mut shell, "DROP TABLE analytics.events", EFFECT_SUCCESS), ShellStatus::ArrowError);
    assert!(has_completion(&mut shell, "select * from public.events e where e.", "public_id"));
    assert!(!has_completion(&mut shell, "select * from analytics.eve", "events"));
}

#[test]
fn session_relations_only_track_successful_single_ddl_statements() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);
    shell.set_session_relations(true);

    assert_eq!(complete_query(&mut shell, "CREATE TABLE failed (id BIGINT)", EFFECT_ERROR), ShellStatus::Ok);
    assert_eq!(
        complete_query(&mut shell, "CREATE TABLE alpha_untracked (id BIGINT); CREATE TABLE beta_untracked (id BIGINT)", EFFECT_SUCCESS),
        ShellStatus::ArrowError
    );
    assert_eq!(complete_query(&mut shell, "ATTACH DATABASE source AS attached", EFFECT_SUCCESS), ShellStatus::ArrowError);

    assert!(!has_completion(&mut shell, "select * from fail", "failed"));
    assert!(!has_completion(&mut shell, "select * from alpha_untr", "alpha_untracked"));
    assert!(!has_completion(&mut shell, "select * from beta_untr", "beta_untracked"));
    assert!(!has_completion(&mut shell, "select * from atta", "attached"));
}

#[test]
fn session_relation_tracking_is_opt_in() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(complete_query(&mut shell, "CREATE TABLE untracked (id BIGINT)", EFFECT_SUCCESS), ShellStatus::ArrowError);
    assert!(!has_completion(&mut shell, "select * from untr", "untracked"));
}

#[test]
fn strips_trailing_semicolon_when_submitting_prompt() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    let query = "SELECT ';' AS value;  \n";
    assert_eq!(shell.prompt_set(query.as_bytes()).status, ShellStatus::Ok);

    let operation = shell.prompt_submit();
    assert_eq!(operation.status, ShellStatus::Pending);
    assert!(operation.data.len() >= 16);
    assert_eq!(&operation.data[16..], b"SELECT ';' AS value");

    let history = shell.history_export();
    assert!(history.len() >= 4);
    assert_eq!(&history[4..], query.as_bytes());
}

#[test]
fn returns_completion_candidates() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(shell.prompt_set(b"sel").status, ShellStatus::Ok);
    let completions = shell.prompt_complete(10).unwrap();
    assert!(!completions.is_empty());
}

#[test]
fn switches_keyword_completion_case_without_recreating_shell() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);
    assert!(has_completion(&mut shell, "sel", "select"));
    shell.set_keyword_case(1);
    assert!(has_completion(&mut shell, "sel", "SELECT"));
    assert!(!has_completion(&mut shell, "sel", "\"SELECT\""));
    shell.set_keyword_case(0);
    assert!(has_completion(&mut shell, "sel", "select"));
}

#[test]
fn uppercase_terminal_hint_extends_lowercase_typed_keyword() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);
    shell.set_keyword_case(1);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    let output = consume(&mut shell, Key::Text, "sel");
    assert_eq!(output.status, ShellStatus::Ok);
    let rendered = data(&output);
    assert!(rendered.contains("SELECT"), "{rendered}");
    assert!(rendered.contains(&bright("ECT")), "{rendered}");
    assert!(!rendered.contains(&bright("SELECT")), "{rendered}");
}

#[test]
fn drives_prompt_interaction_and_history() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    let prompt = shell.prompt_consume(Key::Text as u32, b"select 1");
    assert_eq!(prompt.status, ShellStatus::Ok);
    assert_eq!(prompt.action, PromptInputAction::None);

    let prompt = shell.prompt_consume(Key::Enter as u32, b"");
    assert_eq!(prompt.status, ShellStatus::Ok);
    assert_eq!(prompt.action, PromptInputAction::None);
    assert_eq!(prompt.text, "select 1\n");

    assert_eq!(shell.prompt_consume(Key::Text as u32, b";").status, ShellStatus::Ok);
    let prompt = shell.prompt_consume(Key::Enter as u32, b"");
    assert_eq!(prompt.status, ShellStatus::Ok);
    assert_eq!(prompt.action, PromptInputAction::Submit);

    assert_eq!(shell.prompt_submit().status, ShellStatus::Pending);
}

#[test]
fn submits_semicolon_terminated_prompt_with_local_parse_errors() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    let query = "fooo;";
    assert_eq!(shell.prompt_consume(Key::Text as u32, query.as_bytes()).status, ShellStatus::Ok);
    let prompt = shell.prompt_consume(Key::Enter as u32, b"");
    assert_eq!(prompt.status, ShellStatus::Ok);
    assert_eq!(prompt.action, PromptInputAction::Submit);
    assert_eq!(prompt.text, query);

    let operation = shell.prompt_submit();
    assert_eq!(operation.status, ShellStatus::Pending);
    assert!(operation.data.len() >= 16);
    assert_eq!(&operation.data[16..], b"fooo");
}

#[test]
fn continues_prompt_when_final_semicolon_is_inside_unterminated_string() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(shell.prompt_consume(Key::Text as u32, b"SELECT ';").status, ShellStatus::Ok);
    let prompt = shell.prompt_consume(Key::Enter as u32, b"");
    assert_eq!(prompt.status, ShellStatus::Ok);
    assert_eq!(prompt.action, PromptInputAction::None);
    assert_eq!(prompt.text, "SELECT ';\n");
}

#[test]
fn navigates_multiline_prompt_with_up_and_down() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    let query = "SELECT ab\nFROM table";
    assert_eq!(shell.prompt_consume(Key::Text as u32, query.as_bytes()).status, ShellStatus::Ok);

    let prompt = shell.prompt_consume(Key::Up as u32, b"");
    assert_eq!(prompt.cursor_byte_offset as usize, "SELECT ab".len());

    let prompt = shell.prompt_consume(Key::Down as u32, b"");
    assert_eq!(prompt.cursor_byte_offset as usize, query.len() - 1);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    assert_eq!(consume(&mut shell, Key::Up, "").status, ShellStatus::Ok);

    let prompt = shell.prompt_consume(Key::Escape as u32, b"");
    assert_eq!(prompt.status, ShellStatus::Ok);
    assert_eq!(prompt.cursor_byte_offset as usize, "SELECT ab".len());
}

#[test]
fn continues_history_navigation_after_loading_multiline_prompt() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(shell.history_import(&history(&["SELECT 1;", "SELECT 2\n;"])), ShellStatus::Ok);
    assert_eq!(shell.prompt_set(b"").status, ShellStatus::Ok);

    assert_eq!(shell.prompt_consume(Key::Up as u32, b"").text, "SELECT 2\n;");
    assert_eq!(shell.prompt_consume(Key::Up as u32, b"").text, "SELECT 1;");
    assert_eq!(shell.prompt_consume(Key::Down as u32, b"").text, "SELECT 2\n;");
    assert!(shell.prompt_consume(Key::Down as u32, b"").text.is_empty());
}

#[test]
fn continues_terminal_history_navigation_past_completion_overlay() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(shell.history_import(&history(&["SELECT 1;", "SELECT 2;"])), ShellStatus::Ok);
    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);

    assert_eq!(consume(&mut shell, Key::Up, "").status, ShellStatus::Ok);
    assert_eq!(consume(&mut shell, Key::Up, "").status, ShellStatus::Ok);
    assert_eq!(shell.prompt_move_right().text, "SELECT 1;");

    assert_eq!(consume(&mut shell, Key::Down, "").status, ShellStatus::Ok);
    assert_eq!(shell.prompt_move_right().text, "SELECT 2;");

    assert_eq!(consume(&mut shell, Key::Down, "").status, ShellStatus::Ok);
    assert!(shell.prompt_move_right().text.is_empty());
}

#[test]
fn navigates_to_prompt_start_and_end() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    let query = "SELECT 👩‍💻";
    assert_eq!(shell.prompt_consume(Key::Text as u32, query.as_bytes()).status, ShellStatus::Ok);
    assert_eq!(shell.prompt_consume(Key::Start as u32, b"").cursor_byte_offset, 0);
    assert_eq!(shell.prompt_consume(Key::End as u32, b"").cursor_byte_offset as usize, query.len());
}

#[test]
fn applies_readline_editing_actions() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    let query = "SELECT one two\nFROM table";
    assert_eq!(shell.prompt_consume(Key::Text as u32, query.as_bytes()).status, ShellStatus::Ok);

    let prompt = shell.prompt_consume(Key::LineStart as u32, b"");
    assert_eq!(prompt.cursor_byte_offset as usize, "SELECT one two\n".len());
    assert_eq!(shell.prompt_consume(Key::KillWord as u32, b"").text, "SELECT one two\n table");
    assert_eq!(shell.prompt_consume(Key::Yank as u32, b"").text, query);

    assert_eq!(shell.prompt_consume(Key::LineEnd as u32, b"").status, ShellStatus::Ok);
    assert_eq!(shell.prompt_consume(Key::BackwardKillWord as u32, b"").text, "SELECT one two\nFROM ");
}

#[test]
fn treats_readline_eof_as_delete_or_exit() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(shell.prompt_consume(Key::Eof as u32, b"").action, PromptInputAction::Exit);

    assert_eq!(shell.prompt_consume(Key::Text as u32, b"ab").status, ShellStatus::Ok);
    assert_eq!(shell.prompt_consume(Key::LineStart as u32, b"").status, ShellStatus::Ok);
    let prompt = shell.prompt_consume(Key::Eof as u32, b"");
    assert_eq!(prompt.action, PromptInputAction::None);
    assert_eq!(prompt.text, "b");
}

#[test]
fn clears_terminal_for_readline_clear_screen() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    assert_eq!(consume(&mut shell, Key::Text, "SELECT 1").status, ShellStatus::Ok);

    let output = consume(&mut shell, Key::ClearScreen, "");
    assert_eq!(output.status, ShellStatus::Ok);
    assert!(data(&output).starts_with(vt100::CLEAR_SCREEN), "{}", data(&output));
    assert!(data(&output).contains("SELECT"), "{}", data(&output));
}

#[test]
fn aborts_readline_completion_without_exiting() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    let output = consume(&mut shell, Key::Text, "sel");
    assert!(data(&output).contains(vt100::REVERSE_VIDEO));

    let output = consume(&mut shell, Key::Abort, "");
    assert_eq!(output.status, ShellStatus::Ok);
    assert_eq!(output.action, PromptInputAction::None);
    let output = consume(&mut shell, Key::Abort, "");
    assert_eq!(output.status, ShellStatus::Ok);
    assert_eq!(output.action, PromptInputAction::None);
    assert!(output.data.is_empty());
}

#[test]
fn renders_highlighted_terminal_prompt() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    let output = shell.terminal_open(b"db> ");
    assert_eq!(output.status, ShellStatus::Ok);
    let expected = format!(
        "{}{}{}{}db> {}{}{}",
        vt100::DISABLE_AUTO_WRAP,
        vt100::CARRIAGE_RETURN,
        vt100::ERASE_ENTIRE_LINE,
        vt100::BOLD,
        vt100::RESET_ATTRIBUTES,
        vt100::CARRIAGE_RETURN,
        sequence(4, Command::CursorForward)
    );
    assert_eq!(data(&output), expected);

    let output = consume(&mut shell, Key::Text, "SELECT '界' FROM t");
    assert_eq!(output.status, ShellStatus::Ok);
    let rendered = data(&output);
    assert!(rendered.contains(&format!("{}SELECT{}", vt100::BOLD_FOREGROUND_PINK, vt100::RESET_ATTRIBUTES)));
    assert!(rendered.contains(&format!("{}'界'{}", vt100::FOREGROUND_CORAL, vt100::RESET_ATTRIBUTES)));
    assert!(rendered.contains(&format!("{}t{}", vt100::FOREGROUND_SILVER, vt100::RESET_ATTRIBUTES)));
}

#[test]
fn consumes_semantic_terminal_input() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);

    let output = consume(&mut shell, Key::Text, "SELECT 1;");
    assert_eq!(output.status, ShellStatus::Ok);
    assert_eq!(output.action, PromptInputAction::None);

    let output = consume(&mut shell, Key::Enter, "");
    assert_eq!(output.status, ShellStatus::Ok);
    assert_eq!(output.action, PromptInputAction::Submit);
    assert!(data(&output).contains(vt100::ENABLE_AUTO_WRAP));

    let output = consume(&mut shell, Key::Escape, "");
    assert_eq!(output.status, ShellStatus::Ok);
    assert_eq!(output.action, PromptInputAction::Exit);
    assert!(data(&output).contains(vt100::ENABLE_AUTO_WRAP));
}

#[test]
fn scopes_auto_wrap_to_terminal_output() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    let opened = data(&shell.terminal_open(b""));
    assert!(opened.starts_with(vt100::DISABLE_AUTO_WRAP), "{opened}");

    let query_output = "a query result";
    let finished = shell.terminal_finish_query(query_output.as_bytes(), false);
    assert_eq!(finished.status, ShellStatus::Ok);
    let finished = data(&finished);
    let enabled = finished.find(vt100::ENABLE_AUTO_WRAP).unwrap();
    let result = finished.find(query_output).unwrap();
    let disabled = finished.find(vt100::DISABLE_AUTO_WRAP).unwrap();
    assert!(enabled < result, "{finished}");
    assert!(result < disabled, "{finished}");

    let status = "working";
    let status_output = shell.terminal_status(status.as_bytes());
    assert_eq!(status_output.status, ShellStatus::Ok);
    let status_output = data(&status_output);
    assert!(status_output.find(vt100::ENABLE_AUTO_WRAP).unwrap() < status_output.find(status).unwrap(), "{status_output}");
    assert!(status_output.find(status).unwrap() < status_output.find(vt100::DISABLE_AUTO_WRAP).unwrap(), "{status_output}");
}

#[test]
fn leaves_blank_line_after_terminal_result() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    let query_output = "╰────────╯\r\n";
    let output = shell.terminal_finish_query(query_output.as_bytes(), false);
    assert_eq!(output.status, ShellStatus::Ok);
    assert!(data(&output).contains(&format!("{}{}", query_output, vt100::NEW_LINE)), "{}", data(&output));
}

#[test]
fn renders_and_clears_single_line_query_progress() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 20);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);

    let output = shell.terminal_query_progress(b"  Executing\nquery\tbatch  ", false);
    assert_eq!(output.status, ShellStatus::Ok);
    let first = data(&output);
    assert!(first.contains("⠋ Executing query..."), "{first}");
    assert!(!first.contains('\n'), "{first}");
    assert!(first.starts_with(vt100::DISABLE_AUTO_WRAP), "{first}");

    let output = shell.terminal_query_progress(b"", true);
    assert_eq!(output.status, ShellStatus::Ok);
    assert!(data(&output).contains("⠙ Executing query..."), "{}", data(&output));

    let output = shell.terminal_query_progress_clear();
    assert_eq!(output.status, ShellStatus::Ok);
    assert_eq!(data(&output), format!("{}{}{}", vt100::CARRIAGE_RETURN, vt100::ERASE_ENTIRE_LINE, vt100::ENABLE_AUTO_WRAP));

    let output = shell.terminal_query_progress_clear();
    assert_eq!(output.status, ShellStatus::Ok);
    assert!(output.data.is_empty());
}

#[test]
fn starts_query_progress_after_last_multiline_prompt_row() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(shell.prompt_set(b"SELECT 42\n;").status, ShellStatus::Ok);
    assert_eq!(shell.prompt_consume(Key::Up as u32, b"").status, ShellStatus::Ok);
    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);

    let output = consume(&mut shell, Key::Enter, "");
    assert_eq!(output.status, ShellStatus::Ok);
    assert_eq!(output.action, PromptInputAction::Submit);
    let submitted = data(&output);
    let cursor_down = sequence(1, Command::CursorDown);
    assert!(submitted.contains(&format!("{}{}{}", cursor_down, vt100::ENABLE_AUTO_WRAP, vt100::NEW_LINE)), "{submitted}");

    let output = shell.terminal_query_progress(b"Executing query", false);
    assert_eq!(output.status, ShellStatus::Ok);
    assert!(data(&output).contains("⠋ Executing query"), "{}", data(&output));
}

#[test]
fn reflows_long_prompt_without_repeating_previous_render() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 16);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    let output = consume(&mut shell, Key::Text, "SELECT 123456789");
    assert_eq!(output.status, ShellStatus::Ok);
    assert!(data(&output).contains(&format!("{}{}     -> {}", sequence(1, Command::CursorDown), vt100::BOLD, vt100::RESET_ATTRIBUTES)));

    let output = consume(&mut shell, Key::Text, "0");
    assert_eq!(output.status, ShellStatus::Ok);
    let rendered = data(&output);
    assert_eq!(count_occurrences(&rendered, "SELECT"), 1, "{rendered}");
    assert_eq!(count_occurrences(&rendered, "23456789"), 1, "{rendered}");
    assert_eq!(count_occurrences(&rendered, "     -> "), 2, "{rendered}");
    assert!(count_occurrences(&rendered, vt100::ERASE_ENTIRE_LINE) >= 2, "{rendered}");
}

#[test]
fn reflows_long_prompt_from_continuation_row() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 16);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    assert_eq!(consume(&mut shell, Key::Text, "SELECT 12").status, ShellStatus::Ok);

    let output = consume(&mut shell, Key::Text, "3");
    assert_eq!(output.status, ShellStatus::Ok);
    let rendered = data(&output);
    assert_eq!(count_occurrences(&rendered, "SELECT"), 1, "{rendered}");
    assert_eq!(count_occurrences(&rendered, "     -> "), 1, "{rendered}");
    let cursor_up = sequence(1, Command::CursorUp);
    let cursor_down = sequence(1, Command::CursorDown);
    let cleared_rows = format!(
        "{}{}{}{}{}{}{}{}",
        cursor_up,
        vt100::CARRIAGE_RETURN,
        vt100::ERASE_ENTIRE_LINE,
        cursor_down,
        vt100::CARRIAGE_RETURN,
        vt100::ERASE_ENTIRE_LINE,
        cursor_up,
        vt100::CARRIAGE_RETURN
    );
    assert!(rendered.starts_with(&cleared_rows), "{rendered}");
    assert!(
        !rendered.starts_with(&format!("{}{}{}{}", cursor_up, vt100::CARRIAGE_RETURN, vt100::ERASE_ENTIRE_LINE, vt100::NEW_LINE)),
        "{rendered}"
    );
}

#[test]
fn redraws_long_string_without_scrolling_during_cleanup() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(shell.terminal_open(b"hyper> ").status, ShellStatus::Ok);
    let query = format!("select '{}'", "o".repeat(170));
    assert_eq!(consume(&mut shell, Key::Text, &query).status, ShellStatus::Ok);

    let output = consume(&mut shell, Key::Text, "f");
    assert_eq!(output.status, ShellStatus::Ok);
    let rendered = data(&output);
    assert_eq!(count_occurrences(&rendered, "hyper> "), 1, "{rendered}");
    assert_eq!(count_occurrences(&rendered, "select"), 1, "{rendered}");
    let first_rendered_row = rendered.find("hyper> ").unwrap();
    assert!(!rendered[..first_rendered_row].contains(vt100::NEW_LINE), "{rendered}");
}

#[test]
fn allocates_new_rows_before_redrawing_long_prompt() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(shell.terminal_open(b"hyper> ").status, ShellStatus::Ok);
    let query = format!("select '{}'", "o".repeat(135));
    assert_eq!(consume(&mut shell, Key::Text, &query).status, ShellStatus::Ok);

    let output = consume(&mut shell, Key::Text, " as select");
    assert_eq!(output.status, ShellStatus::Ok);
    let rendered = data(&output);
    assert_eq!(count_occurrences(&rendered, "hyper> "), 1, "{rendered}");
    let first_prompt = rendered.find("hyper> ").unwrap();
    assert!(rendered[..first_prompt].contains(vt100::NEW_LINE), "{rendered}");
    assert!(rendered[..first_prompt].contains(&sequence(2, Command::CursorUp)), "{rendered}");
}

#[test]
fn renders_inline_completion_hint_at_right_margin_with_auto_wrap_disabled() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 173);

    assert_eq!(shell.terminal_open(b"hyper> ").status, ShellStatus::Ok);
    let query = format!("select '{}' a", "o".repeat(154));
    let output = consume(&mut shell, Key::Text, &query);
    assert_eq!(output.status, ShellStatus::Ok);
    let rendered = data(&output);
    assert_eq!(count_occurrences(&rendered, "hyper> "), 1, "{rendered}");
    assert!(rendered.contains(&bright(" into")), "{rendered}");
    assert!(rendered.contains(vt100::SAVE_CURSOR), "{rendered}");
    assert!(rendered.contains(vt100::RESTORE_CURSOR), "{rendered}");

    let output = consume(&mut shell, Key::Text, "s");
    assert_eq!(output.status, ShellStatus::Ok);
    assert_eq!(count_occurrences(&data(&output), "hyper> "), 1, "{}", data(&output));
}

#[test]
fn keeps_completion_overlay_inside_right_border() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 12);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    let output = consume(&mut shell, Key::Text, " sel");
    assert_eq!(output.status, ShellStatus::Ok);
    let rendered = data(&output);
    assert!(rendered.contains('╭'), "{rendered}");
    assert!(rendered.contains("╭─────────╮"), "{rendered}");
    assert!(
        !rendered.contains(&format!("{}{}{}╭", sequence(9, Command::CursorForward), vt100::ERASE_ENTIRE_LINE, vt100::FOREGROUND_BRIGHT_BLACK)),
        "{rendered}"
    );
}

#[test]
fn navigates_and_accepts_terminal_completion_overlay() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    let output = consume(&mut shell, Key::Text, "sel");
    assert_eq!(output.status, ShellStatus::Ok, "{}", data(&output));
    assert_eq!(output.action, PromptInputAction::None);
    let initial_output = data(&output);
    assert!(initial_output.contains(vt100::REVERSE_VIDEO));
    assert!(initial_output.contains("select"));
    let completion_anchor = format!("{}{}", sequence(1, Command::CursorDown), sequence(8, Command::CursorForward));
    assert!(initial_output.contains(&format!("{}{}╭", completion_anchor, vt100::FOREGROUND_BRIGHT_BLACK)));
    assert!(!initial_output.contains(&format!("{}{}", sequence(8, Command::CursorForward), vt100::ERASE_ENTIRE_LINE)));
    assert!(initial_output.contains(&bright("╰")));
    assert!(!initial_output.contains(&format!("{}> ", vt100::ERASE_ENTIRE_LINE)));

    let completions = completion_texts(&mut shell);
    assert!(completions.len() > 1);
    let select_index = completions.iter().position(|c| c == "select").unwrap();

    let mut selected_output = String::new();
    for _ in 0..select_index {
        let output = consume(&mut shell, Key::HistoryNext, "");
        assert_eq!(output.status, ShellStatus::Ok);
        assert_eq!(output.action, PromptInputAction::None);
        selected_output = data(&output);
    }
    if select_index == 0 {
        selected_output = initial_output;
    }
    assert!(selected_output.contains(&bright("ect")));

    let output = consume(&mut shell, Key::Tab, "");
    assert_eq!(output.status, ShellStatus::Ok);
    assert_eq!(output.action, PromptInputAction::None);
    assert!(data(&output).contains(&format!("{}select{}", vt100::BOLD_FOREGROUND_PINK, vt100::RESET_ATTRIBUTES)), "{}", data(&output));

    assert_eq!(shell.prompt_move_right().text, "select");
}

#[test]
fn lists_hints_and_accepts_column_after_fully_qualified_table_alias() {
    let catalog = catalog();
    let _schema = load_schema(&catalog, "CREATE TABLE uip_iceberg.cdp_usage_nonprod_events.hyperdb_queries(event_id BIGINT, processed_rows BIGINT);");

    let mut shell = shell(&catalog, 160);
    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);

    let query = "select * from uip_iceberg.cdp_usage_nonprod_events.hyperdb_queries q where q.";
    let mut output = None;
    for c in query.chars() {
        let o = consume(&mut shell, Key::Text, &c.to_string());
        assert_eq!(o.status, ShellStatus::Ok);
        output = Some(o);
    }
    let rendered = data(&output.unwrap());
    assert!(rendered.contains(vt100::FOREGROUND_BRIGHT_BLACK), "{rendered}");
    assert!(rendered.contains("event_id") || rendered.contains("processed_rows"), "{rendered}");
    assert!(rendered.contains('╭'), "{rendered}");
    assert!(rendered.contains(vt100::REVERSE_VIDEO), "{rendered}");

    let completions = shell.prompt_complete(50).unwrap();
    assert!(!completions.is_empty());
    assert_eq!(completions[0].target_offset as usize, query.len());
    assert_eq!(completions[0].target_length, 0);

    let output = consume(&mut shell, Key::Tab, "");
    assert_eq!(output.status, ShellStatus::Ok);
    assert_eq!(output.action, PromptInputAction::None);

    let text = shell.prompt_move_right().text;
    assert!(text == format!("{query}event_id") || text == format!("{query}processed_rows"), "{text}");
}

#[test]
fn lists_columns_after_short_table_alias() {
    let catalog = catalog();
    let _schema = load_schema(&catalog, "CREATE TABLE foo(only_column BIGINT);");

    let mut shell = shell(&catalog, 80);
    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);

    let mut output = None;
    for c in "select * from foo x where x.".chars() {
        let o = consume(&mut shell, Key::Text, &c.to_string());
        assert_eq!(o.status, ShellStatus::Ok);
        output = Some(o);
    }
    let rendered = data(&output.unwrap());
    assert!(rendered.contains("only_column"), "{rendered}");
    assert!(rendered.contains('╭'), "{rendered}");
    assert!(rendered.contains(vt100::REVERSE_VIDEO), "{rendered}");
}

#[test]
fn lists_columns_after_qualified_alias_before_later_prompt_lines() {
    let catalog = catalog();
    let _schema = load_schema(&catalog, "CREATE TABLE uip_iceberg.cdp_usage_nonprod_events.hyperdb_queries(event_id BIGINT, processed_rows BIGINT);");

    let mut shell = shell(&catalog, 160);
    assert_eq!(shell.terminal_open(b"trino> ").status, ShellStatus::Ok);

    let query = "with foo as (\nselect * from uip_iceberg.cdp_usage_nonprod_events.hyperdb_queries q where q.\n\n) ";
    assert_eq!(consume(&mut shell, Key::Text, query).status, ShellStatus::Ok);

    let trailing = "\n\n) ";
    for _ in 0..trailing.len() {
        assert_eq!(shell.prompt_move_left().status, ShellStatus::Ok);
    }
    assert_eq!(shell.prompt_move_right().cursor_byte_offset as usize, query.len() - trailing.len() + 1);
    assert_eq!(shell.prompt_move_left().cursor_byte_offset as usize, query.len() - trailing.len());

    let completions = completion_texts(&mut shell);
    assert!(!completions.is_empty());
    assert!(completions.iter().any(|c| c == "event_id" || c == "processed_rows"));

    assert_eq!(consume(&mut shell, Key::Text, "x").status, ShellStatus::Ok);
    let output = consume(&mut shell, Key::Backspace, "");
    assert_eq!(output.status, ShellStatus::Ok);
    let rendered = data(&output);
    assert!(rendered.contains("event_id") || rendered.contains("processed_rows"), "{rendered}");
}

#[test]
fn shows_only_inline_hint_before_completion_prefix() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    let output = consume(&mut shell, Key::Text, " ");
    assert_eq!(output.status, ShellStatus::Ok);
    assert!(data(&output).contains(vt100::FOREGROUND_BRIGHT_BLACK));
    assert!(!data(&output).contains('╭'));
    assert!(!data(&output).contains(vt100::REVERSE_VIDEO));

    let output = consume(&mut shell, Key::Text, "s");
    assert_eq!(output.status, ShellStatus::Ok);
    assert!(data(&output).contains('╭'));
    assert!(data(&output).contains(vt100::REVERSE_VIDEO));

    assert_eq!(consume(&mut shell, Key::Tab, "").status, ShellStatus::Ok);
    assert!(shell.prompt_move_right().text.len() > 2);
}

#[test]
fn accepts_selected_completion_with_enter() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    assert_eq!(consume(&mut shell, Key::Text, "sel").status, ShellStatus::Ok);

    let completions = completion_texts(&mut shell);
    assert!(completions.len() > 1);
    let selected = completions[0].clone();

    let output = consume(&mut shell, Key::Enter, "");
    assert_eq!(output.status, ShellStatus::Ok);
    assert_eq!(output.action, PromptInputAction::None);
    assert_eq!(shell.prompt_move_right().text, selected);
}

#[test]
fn does_not_cycle_terminal_candidates_with_left_and_right() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    assert_eq!(consume(&mut shell, Key::Text, "sel").status, ShellStatus::Ok);

    let completions = completion_texts(&mut shell);
    assert!(completions.len() > 1);
    let expected = completions[0].clone();

    assert_eq!(consume(&mut shell, Key::Right, "").status, ShellStatus::Ok);
    assert_eq!(consume(&mut shell, Key::Left, "").status, ShellStatus::Ok);
    assert_eq!(consume(&mut shell, Key::Right, "").status, ShellStatus::Ok);

    assert_eq!(consume(&mut shell, Key::End, "").status, ShellStatus::Ok);
    let output = consume(&mut shell, Key::Tab, "");
    assert_eq!(output.status, ShellStatus::Ok);
    assert!(data(&output).contains('╭'), "{}", data(&output));
    assert_eq!(consume(&mut shell, Key::Tab, "").status, ShellStatus::Ok);

    assert_eq!(shell.prompt_move_right().text, expected);
}

#[test]
fn cursor_movement_dismisses_completion_without_reopening_it() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    let output = consume(&mut shell, Key::Text, "sel");
    assert!(data(&output).contains('╭'), "{}", data(&output));

    let output = consume(&mut shell, Key::Left, "");
    assert_eq!(output.status, ShellStatus::Ok);
    assert!(!data(&output).contains('╭'), "{}", data(&output));

    let output = consume(&mut shell, Key::Left, "");
    assert_eq!(output.status, ShellStatus::Ok);
    assert!(!data(&output).contains('╭'), "{}", data(&output));

    let prompt = shell.prompt_move_right();
    assert_eq!(prompt.cursor_byte_offset, 2);
    assert_eq!(prompt.text, "sel");
}

#[test]
fn cycles_inline_qualification_hints_with_left_and_right() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 100);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    let query = "CREATE TABLE orders(customer_id BIGINT); CREATE TABLE customers(customer_id BIGINT); \
                 SELECT customer_id FROM orders o JOIN customers c ON o.customer_id = c.customer_id \
                 WHERE customer_id";
    assert_eq!(consume(&mut shell, Key::Text, query).status, ShellStatus::Ok);

    let completions = completion_texts(&mut shell);
    let customer_id_index = completions.iter().position(|c| c == "customer_id").unwrap();
    for _ in 0..customer_id_index {
        assert_eq!(consume(&mut shell, Key::HistoryNext, "").status, ShellStatus::Ok);
    }

    let output = consume(&mut shell, Key::Right, "");
    assert_eq!(output.status, ShellStatus::Ok);
    let right_output = data(&output);
    assert!(right_output.contains(&sequence(2, Command::InsertCharacter)));
    assert!(right_output.contains("c."));

    let output = consume(&mut shell, Key::Left, "");
    assert_eq!(output.status, ShellStatus::Ok);
    assert!(data(&output).contains("o."));

    assert_eq!(consume(&mut shell, Key::Tab, "").status, ShellStatus::Ok);
    assert_eq!(consume(&mut shell, Key::Tab, "").status, ShellStatus::Ok);

    assert!(shell.prompt_move_right().text.contains("o.customer_id"));
}

#[test]
fn applies_keyword_completion_in_multiple_steps() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 100);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    assert_eq!(consume(&mut shell, Key::Text, "SELECT * FROM supplier gro").status, ShellStatus::Ok);

    let completions = completion_texts(&mut shell);
    let group_index = completions.iter().position(|c| c == "group").unwrap();
    for _ in 0..group_index {
        assert_eq!(consume(&mut shell, Key::HistoryNext, "").status, ShellStatus::Ok);
    }

    let output = consume(&mut shell, Key::Tab, "");
    assert_eq!(output.status, ShellStatus::Ok);
    let rendered = data(&output);
    assert!(rendered.contains(&format!("{}SELECT{}", vt100::BOLD_FOREGROUND_PINK, vt100::RESET_ATTRIBUTES)), "{rendered}");
    assert!(rendered.contains(&format!("{}supplier{}", vt100::FOREGROUND_SILVER, vt100::RESET_ATTRIBUTES)), "{rendered}");
    assert!(rendered.contains(&format!("{}group{}", vt100::BOLD_FOREGROUND_PINK, vt100::RESET_ATTRIBUTES)), "{rendered}");
    assert!(rendered.contains(&bright(" by")), "{rendered}");

    assert_eq!(shell.prompt_move_right().text, "SELECT * FROM supplier group");

    assert_eq!(consume(&mut shell, Key::Tab, "").status, ShellStatus::Ok);
    assert_eq!(shell.prompt_move_right().text, "SELECT * FROM supplier group by");
}

#[test]
fn anchors_completion_below_cursor_in_multiline_prompt() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 100);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    assert_eq!(consume(&mut shell, Key::Text, "sel\nFROM supplier").status, ShellStatus::Ok);
    for _ in 0.."\nFROM supplier".len() {
        assert_eq!(shell.prompt_move_left().status, ShellStatus::Ok);
    }

    assert_eq!(consume(&mut shell, Key::Text, "x").status, ShellStatus::Ok);
    let output = consume(&mut shell, Key::Backspace, "");
    assert_eq!(output.status, ShellStatus::Ok);
    let rendered = data(&output);
    assert!(!rendered.contains(&sequence(9, Command::InsertLine)));
    assert!(rendered.contains(&format!(
        "{}{}{}╭",
        sequence(1, Command::CursorDown),
        sequence(8, Command::CursorForward),
        vt100::FOREGROUND_BRIGHT_BLACK
    )));
    assert!(!rendered.contains(&format!("{}{}", sequence(8, Command::CursorForward), vt100::ERASE_ENTIRE_LINE)));

    let output = consume(&mut shell, Key::Escape, "");
    assert_eq!(output.status, ShellStatus::Ok);
    assert!(!data(&output).contains(&sequence(9, Command::DeleteLine)));
}

#[test]
fn renders_inline_completion_hint_before_later_prompt_lines() {
    let catalog = catalog();
    let _schema = load_schema(&catalog, "CREATE TABLE hyperdb_queries(query_id BIGINT);");

    let mut shell = shell(&catalog, 100);
    assert_eq!(shell.terminal_open(b"trino> ").status, ShellStatus::Ok);

    assert_eq!(consume(&mut shell, Key::Text, "with foo as (\nselect * from hyperdb_quer\n\n) ").status, ShellStatus::Ok);
    for _ in 0.."\n\n) ".len() {
        assert_eq!(shell.prompt_move_left().status, ShellStatus::Ok);
    }

    assert_eq!(consume(&mut shell, Key::Text, "x").status, ShellStatus::Ok);
    let output = consume(&mut shell, Key::Backspace, "");
    assert_eq!(output.status, ShellStatus::Ok);
    let rendered = data(&output);
    assert!(rendered.contains(&bright("ies")), "{rendered}");
    assert!(rendered.contains(&sequence(3, Command::InsertCharacter)), "{rendered}");
}

#[test]
fn renders_and_accepts_qualification_hint_before_cursor() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 100);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    let schema = "CREATE TABLE orders(customer_id BIGINT); CREATE TABLE customers(customer_id BIGINT); ";
    let query = "SELECT customer_id FROM orders o JOIN customers c ON o.customer_id = c.customer_id WHERE customer_id";
    assert_eq!(consume(&mut shell, Key::Text, schema).status, ShellStatus::Ok);
    assert_eq!(consume(&mut shell, Key::Text, query).status, ShellStatus::Ok);

    let completions = completion_texts(&mut shell);
    let customer_id_index = completions.iter().position(|c| c == "customer_id").unwrap();

    let mut selected_output = String::new();
    for _ in 0..customer_id_index {
        let output = consume(&mut shell, Key::HistoryNext, "");
        assert_eq!(output.status, ShellStatus::Ok);
        selected_output = data(&output);
    }
    if customer_id_index == 0 {
        assert_eq!(consume(&mut shell, Key::HistoryNext, "").status, ShellStatus::Ok);
        let output = consume(&mut shell, Key::HistoryPrevious, "");
        assert_eq!(output.status, ShellStatus::Ok);
        selected_output = data(&output);
    }
    assert!(selected_output.contains(&sequence(2, Command::InsertCharacter)));
    assert!(selected_output.contains(vt100::FOREGROUND_BRIGHT_BLACK));

    let output = consume(&mut shell, Key::Tab, "");
    assert_eq!(output.status, ShellStatus::Ok);
    assert!(data(&output).contains(&sequence(2, Command::InsertCharacter)));

    assert_eq!(consume(&mut shell, Key::Tab, "").status, ShellStatus::Ok);
    assert!(shell.prompt_move_right().text.contains(".customer_id"));
}

#[test]
fn auto_qualifies_non_default_database_table_on_first_tab() {
    let catalog = catalog();
    let _schema = load_schema(&catalog, "CREATE TABLE \"Salesforce\".public.\"Account\"(id BIGINT);");

    let mut shell = Shell::new(catalog.clone(), 100, true);
    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    assert_eq!(consume(&mut shell, Key::Text, "select * from Acc").status, ShellStatus::Ok);
    let (index, output) = select_terminal_completion(&mut shell, "\"Account\"");
    assert!(index < 50);
    assert!(data(&output).contains("\"Salesforce\".public."), "{}", data(&output));

    assert_eq!(consume(&mut shell, Key::Tab, "").status, ShellStatus::Ok);
    assert_eq!(shell.prompt_move_right().text, "select * from \"Salesforce\".public.\"Account\"");
}

#[test]
fn cycles_auto_qualified_table_options_with_left_and_right() {
    let catalog = catalog();
    let _schema = load_schema(&catalog, "CREATE TABLE alpha.public.accounts(id BIGINT); CREATE TABLE beta.public.accounts(id BIGINT);");

    let mut shell = Shell::new(catalog.clone(), 100, true);
    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    assert_eq!(consume(&mut shell, Key::Text, "select * from acc").status, ShellStatus::Ok);
    let (index, output) = select_terminal_completion(&mut shell, "accounts");
    assert!(index < 50);
    let rendered = data(&output);
    assert!(rendered.contains("1/2"), "{rendered}");
    let first_is_alpha = rendered.contains("alpha.public.");
    let first_is_beta = rendered.contains("beta.public.");
    assert_ne!(first_is_alpha, first_is_beta, "{rendered}");

    let output = consume(&mut shell, Key::Right, "");
    assert_eq!(output.status, ShellStatus::Ok);
    let rendered = data(&output);
    assert!(rendered.contains("2/2"), "{rendered}");
    assert!(!rendered.contains(if first_is_alpha { "alpha.public." } else { "beta.public." }), "{rendered}");
    assert!(rendered.contains(if first_is_alpha { "beta.public." } else { "alpha.public." }), "{rendered}");

    let output = consume(&mut shell, Key::Left, "");
    assert!(data(&output).contains("1/2"), "{}", data(&output));

    let output = consume(&mut shell, Key::Left, "");
    assert!(data(&output).contains("2/2"), "{}", data(&output));

    assert_eq!(consume(&mut shell, Key::Tab, "").status, ShellStatus::Ok);
    assert_eq!(
        shell.prompt_move_right().text,
        if first_is_alpha { "select * from beta.public.accounts" } else { "select * from alpha.public.accounts" }
    );
}

#[test]
fn narrow_completion_list_keeps_left_and_right_as_cursor_keys() {
    let catalog = catalog();
    let _schema = load_schema(&catalog, "CREATE TABLE alpha.public.accounts(id BIGINT); CREATE TABLE beta.public.accounts(id BIGINT);");

    let mut shell = Shell::new(catalog.clone(), 12, true);
    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);

    let output = consume(&mut shell, Key::Text, "acc");
    assert_eq!(output.status, ShellStatus::Ok);
    assert!(!data(&output).contains("1/2"), "{}", data(&output));

    let output = consume(&mut shell, Key::Left, "");
    assert_eq!(output.status, ShellStatus::Ok);
    assert!(!data(&output).contains('╭'), "{}", data(&output));

    let prompt = shell.prompt_move_right();
    assert_eq!(prompt.cursor_byte_offset, 3);
    assert_eq!(prompt.text, "acc");
}

#[test]
fn does_not_auto_qualify_default_database_table() {
    let catalog = catalog();
    let _schema = load_schema(&catalog, "CREATE TABLE hyper.public.orders(id BIGINT);");

    let mut shell = Shell::new(catalog.clone(), 100, true);
    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    assert_eq!(consume(&mut shell, Key::Text, "select * from ord").status, ShellStatus::Ok);
    let (index, output) = select_terminal_completion(&mut shell, "orders");
    assert!(index < 50);
    assert!(!data(&output).contains("hyper.public."), "{}", data(&output));

    assert_eq!(consume(&mut shell, Key::Tab, "").status, ShellStatus::Ok);
    assert_eq!(shell.prompt_move_right().text, "select * from orders");
}

#[test]
fn escape_dismisses_terminal_completion_before_exiting() {
    let catalog = catalog();
    let mut shell = shell(&catalog, 80);

    assert_eq!(shell.terminal_open(b"").status, ShellStatus::Ok);
    assert_eq!(consume(&mut shell, Key::Text, "sel").status, ShellStatus::Ok);

    let output = consume(&mut shell, Key::Escape, "");
    assert_eq!(output.status, ShellStatus::Ok);
    assert_eq!(output.action, PromptInputAction::None);
    assert!(!output.data.is_empty());

    let output = consume(&mut shell, Key::Escape, "");
    assert_eq!(output.status, ShellStatus::Ok);
    assert_eq!(output.action, PromptInputAction::Exit);
}
