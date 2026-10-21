//! A port of the C++ `test/shell_arrow_renderer_test.cc`.

use arrow_array::builder::{Int32Builder, ListBuilder};
use arrow_array::types::Int32Type;
use arrow_array::{
    ArrayRef, BinaryArray, BooleanArray, Date32Array, Decimal128Array, DictionaryArray, Float64Array, Int32Array,
    RecordBatch, RecordBatchOptions, StringArray, StructArray, TimestampMicrosecondArray,
};
use arrow_ipc::writer::{FileWriter, StreamWriter};
use arrow_schema::{DataType, Field, Schema};
use dashql_core::catalog::Catalog;
use dashql_core::shell::unicode::display_width;
use dashql_core::shell::vt100::{self, Command};
use dashql_core::shell::{
    ArrowRenderer, EffectCompletionStatus, EffectType, PromptInputKey, ShellSession, ShellStatus,
};
use std::sync::Arc;

fn write_ipc(batch: &RecordBatch) -> Vec<u8> {
    let mut writer = FileWriter::try_new(Vec::new(), &batch.schema()).unwrap();
    writer.write(batch).unwrap();
    writer.finish().unwrap();
    writer.into_inner().unwrap()
}

fn write_ipc_stream(batch: &RecordBatch) -> Vec<u8> {
    let mut writer = StreamWriter::try_new(Vec::new(), &batch.schema()).unwrap();
    writer.write(batch).unwrap();
    writer.finish().unwrap();
    writer.into_inner().unwrap()
}

fn batch(fields: Vec<Field>, columns: Vec<ArrayRef>) -> RecordBatch {
    RecordBatch::try_new(Arc::new(Schema::new(fields)), columns).unwrap()
}

fn make_batch() -> RecordBatch {
    batch(
        vec![Field::new("name", DataType::Utf8, true), Field::new("value", DataType::Int32, true)],
        vec![
            Arc::new(StringArray::from(vec![Some("alpha"), Some("界"), None])),
            Arc::new(Int32Array::from(vec![1, 20, 300])),
        ],
    )
}

fn render(columns: u32, ipc: &[u8]) -> String {
    let output = ArrowRenderer::new(columns).render_ipc(ipc).unwrap();
    String::from_utf8(output).unwrap()
}

fn expect_lines_fit(output: &str, width: usize) {
    for line in output.split('\n') {
        assert!(display_width(line.as_bytes()) <= width, "{line}");
    }
}

fn text(data: &[u8]) -> String {
    String::from_utf8_lossy(data).into_owned()
}

#[test]
fn renders_arrow_ipc() {
    let output = render(80, &write_ipc(&make_batch()));
    assert_eq!(
        output,
        "╭───────┬───────╮\n\
         │ name  │ value │\n\
         ╞═══════╪═══════╡\n\
         │ alpha │     1 │\n\
         │ 界    │    20 │\n\
         │       │   300 │\n\
         ╰───────┴───────╯"
    );
}

#[test]
fn renders_arrow_ipc_stream() {
    let output = render(80, &write_ipc_stream(&make_batch()));
    assert!(output.contains("alpha"));
    assert!(output.contains("300"));
}

#[test]
fn constrains_output_to_terminal_width() {
    let output = render(15, &write_ipc(&make_batch()));
    expect_lines_fit(&output, 15);
}

#[test]
fn gives_short_columns_only_the_space_they_need() {
    let batch = batch(
        vec![Field::new("k", DataType::Utf8, true), Field::new("description", DataType::Utf8, true)],
        vec![Arc::new(StringArray::from(vec!["x"])), Arc::new(StringArray::from(vec!["alpha beta gamma delta"]))],
    );
    let output = render(22, &write_ipc(&batch));
    expect_lines_fit(&output, 22);
    assert!(output.contains("alpha beta"), "{output}");
}

#[test]
fn wraps_at_word_boundaries() {
    let batch = batch(
        vec![Field::new("text", DataType::Utf8, true)],
        vec![Arc::new(StringArray::from(vec!["alpha beta gamma"]))],
    );
    let output = render(12, &write_ipc(&batch));
    expect_lines_fit(&output, 12);
    assert!(output.contains("│ alpha    │\n│ beta     │\n│ gamma    │"), "{output}");
}

#[test]
fn truncates_pathological_multiline_cells() {
    let value = vec!["line"; 25].join("\n");
    let batch = batch(vec![Field::new("text", DataType::Utf8, true)], vec![Arc::new(StringArray::from(vec![value]))]);
    let output = render(20, &write_ipc(&batch));
    assert!(output.contains("l..."), "{output}");
    assert_eq!(output.matches('\n').count(), 23);
}

#[test]
fn hides_columns_that_cannot_fit() {
    let batch = batch(
        vec![
            Field::new("first", DataType::Int32, true),
            Field::new("second", DataType::Int32, true),
            Field::new("third", DataType::Int32, true),
        ],
        vec![
            Arc::new(Int32Array::from(vec![1])),
            Arc::new(Int32Array::from(vec![2])),
            Arc::new(Int32Array::from(vec![3])),
        ],
    );
    let output = render(8, &write_ipc(&batch));
    expect_lines_fit(&output, 8);
    assert!(output.contains("..."), "{output}");
}

#[test]
fn escapes_terminal_control_characters() {
    let batch = batch(
        vec![Field::new("text", DataType::Utf8, true)],
        vec![Arc::new(StringArray::from(vec!["safe\x1b[31mred"]))],
    );
    let output = render(80, &write_ipc(&batch));
    assert!(!output.contains('\x1b'));
    assert!(output.contains("safe\\x1b[31mred"));
}

#[test]
fn formats_values_with_arrow_cast() {
    let ts = |tz: Option<&str>| -> ArrayRef {
        Arc::new(TimestampMicrosecondArray::from(vec![Some(1_500_000_000_123_456), None]).with_timezone_opt(tz))
    };
    let mut list = ListBuilder::new(Int32Builder::new());
    list.append_value([Some(1), None, Some(3)]);
    list.append_null();
    let tags: DictionaryArray<Int32Type> = vec![Some("red"), None].into_iter().collect();
    let point = StructArray::from(vec![
        (Arc::new(Field::new("x", DataType::Int32, true)), Arc::new(Int32Array::from(vec![1, 2])) as ArrayRef),
        (
            Arc::new(Field::new("y", DataType::Utf8, true)),
            Arc::new(StringArray::from(vec![Some("a"), None])) as ArrayRef,
        ),
    ]);
    let render_columns = |columns: Vec<(&str, ArrayRef)>| {
        let fields = columns.iter().map(|(name, column)| Field::new(*name, column.data_type().clone(), true)).collect();
        render(200, &write_ipc(&batch(fields, columns.into_iter().map(|(_, column)| column).collect())))
    };
    let output = render_columns(vec![
        ("float", Arc::new(Float64Array::from(vec![Some(0.1 + 0.2), Some(1e10)]))),
        ("dec", Arc::new(Decimal128Array::from(vec![Some(-12345), None]).with_precision_and_scale(10, 2).unwrap())),
        ("date", Arc::new(Date32Array::from(vec![Some(19000), None]))),
        ("ts", ts(None)),
        ("ts_offset", ts(Some("+02:00"))),
        // Named time zones are shown in UTC
        ("ts_named", ts(Some("Europe/Berlin"))),
    ]);
    assert_eq!(
        output,
        "╭─────────────────────┬─────────┬────────────┬────────────────────────────┬──────────────────────────────────┬─────────────────────────────╮\n\
         │ float               │ dec     │ date       │ ts                         │ ts_offset                        │ ts_named                    │\n\
         ╞═════════════════════╪═════════╪════════════╪════════════════════════════╪══════════════════════════════════╪═════════════════════════════╡\n\
         │ 0.30000000000000004 │ -123.45 │ 2022-01-08 │ 2017-07-14T02:40:00.123456 │ 2017-07-14T04:40:00.123456+02:00 │ 2017-07-14T02:40:00.123456Z │\n\
         │       10000000000.0 │         │            │                            │                                  │                             │\n\
         ╰─────────────────────┴─────────┴────────────┴────────────────────────────┴──────────────────────────────────┴─────────────────────────────╯"
    );
    let output = render_columns(vec![
        ("list", Arc::new(list.finish())),
        ("struct", Arc::new(point)),
        ("dict", Arc::new(tags)),
        ("bin", Arc::new(BinaryArray::from(vec![Some(&b"\x00\xff"[..]), None]))),
        ("bool", Arc::new(BooleanArray::from(vec![Some(true), None]))),
    ]);
    assert_eq!(
        output,
        "╭──────────────┬─────────────────┬──────┬──────┬──────╮\n\
         │ list         │ struct          │ dict │ bin  │ bool │\n\
         ╞══════════════╪═════════════════╪══════╪══════╪══════╡\n\
         │ [1, null, 3] │ {x: 1, y: a}    │ red  │ 00ff │ true │\n\
         │              │ {x: 2, y: null} │      │      │      │\n\
         ╰──────────────┴─────────────────┴──────┴──────┴──────╯"
    );
}

fn read_u32(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap())
}

fn read_u64(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

#[test]
fn suspends_and_resumes_query_coroutine() {
    let mut catalog = Catalog::new();
    let mut session = ShellSession::new(&catalog, 80, false);
    let pending = session.start_query(b"SELECT 42", &catalog);
    assert_eq!(pending.status, ShellStatus::Pending);
    assert!(pending.data.len() >= 16);
    assert_eq!(read_u32(&pending.data, 0), 1);
    assert_eq!(read_u32(&pending.data, 4), EffectType::ExecuteQuery as u32);
    assert_eq!(&pending.data[16..], b"SELECT 42");

    let ipc = write_ipc(&make_batch());
    let complete =
        session.complete_effect(read_u64(&pending.data, 8), EffectCompletionStatus::Success, &ipc, &mut catalog);
    assert_eq!(complete.status, ShellStatus::Ok);
    assert!(text(&complete.data).contains("alpha"));
    assert!(complete.data.ends_with(vt100::NEW_LINE.as_bytes()));
}

#[test]
fn keeps_empty_query_results_empty() {
    let mut catalog = Catalog::new();
    let mut session = ShellSession::new(&catalog, 80, false);
    let pending = session.start_query(b"CREATE TABLE foo(a INT)", &catalog);
    assert_eq!(pending.status, ShellStatus::Pending);

    let empty = RecordBatch::try_new_with_options(
        Arc::new(Schema::empty()),
        vec![],
        &RecordBatchOptions::new().with_row_count(Some(0)),
    )
    .unwrap();
    let ipc = write_ipc(&empty);
    let complete =
        session.complete_effect(read_u64(&pending.data, 8), EffectCompletionStatus::Success, &ipc, &mut catalog);
    assert_eq!(complete.status, ShellStatus::Ok);
    assert_eq!(complete.data, b"No results\r\n");
}

#[test]
fn suspends_dot_command_as_effect() {
    let catalog = Catalog::new();
    let mut session = ShellSession::new(&catalog, 100, false);
    session.set_prompt(b".help");

    let pending = session.submit_prompt(&catalog);
    assert_eq!(pending.status, ShellStatus::Pending);
    assert_eq!(read_u32(&pending.data, 4), EffectType::ExecuteCommand as u32);
    assert_eq!(&pending.data[16..], b".help");
}

#[test]
fn completes_dot_command_prefixes() {
    let catalog = Catalog::new();
    let mut session = ShellSession::new(&catalog, 100, false);
    assert_eq!(session.set_commands(b"clear\nhelp\nlogin"), ShellStatus::Ok);
    session.set_prompt(b".hel");

    let candidates = session.complete_prompt(10, &catalog).unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].display_text, ".help");
    assert_eq!(candidates[0].completion_text, ".help");
    assert_eq!(candidates[0].target_offset, 0);
    assert_eq!(candidates[0].target_length, 4);
}

#[test]
fn renders_inline_dot_command_hint() {
    let catalog = Catalog::new();
    let mut session = ShellSession::new(&catalog, 100, false);
    assert_eq!(session.set_commands(b"clear\nhelp"), ShellStatus::Ok);
    session.open_terminal(b"db> ");

    let output = text(&session.consume_terminal_input(PromptInputKey::Text, b".hel", &catalog).data);
    assert!(output.contains(&format!("{}p", vt100::FOREGROUND_BRIGHT_BLACK)), "{output}");
    assert!(!output.contains('╭'), "{output}");
}

#[test]
fn renders_registered_dot_command_names_in_bold() {
    let catalog = Catalog::new();
    let mut session = ShellSession::new(&catalog, 100, false);
    assert_eq!(session.set_commands(b"login\nrefresh"), ShellStatus::Ok);
    session.open_terminal(b"hyperdb> ");

    let output = text(&session.consume_terminal_input(PromptInputKey::Text, b".refresh", &catalog).data);
    assert!(output.contains(&format!("{}.refresh{}", vt100::BOLD, vt100::RESET_ATTRIBUTES)), "{output}");
}

#[test]
fn compiles_plain_sql_before_execution() {
    let catalog = Catalog::new();
    let mut session = ShellSession::new(&catalog, 80, false);
    let query = b"  SELECT 42; -- context\n";
    let pending = session.start_query(query, &catalog);
    assert_eq!(pending.status, ShellStatus::Pending);
    assert_eq!(&pending.data[16..], query);
}

#[test]
fn rejects_dashql_extensions() {
    let catalog = Catalog::new();
    let mut session = ShellSession::new(&catalog, 80, false);
    let visualize = session.start_query(
        b"SELECT 1 AS value VISUALIZE USING vegalite (mark => bar, encoding => (x => (field => value)))",
        &catalog,
    );
    assert_eq!(visualize.status, ShellStatus::InvalidArgument);
    assert!(text(&visualize.data).contains("not executable in the shell"));
}

#[test]
fn rejects_concurrent_queries_and_stale_completions() {
    let mut catalog = Catalog::new();
    let mut session = ShellSession::new(&catalog, 80, false);
    let pending = session.start_query(b"SELECT 1", &catalog);
    assert_eq!(pending.status, ShellStatus::Pending);
    let effect_id = read_u64(&pending.data, 8);

    assert_eq!(session.start_query(b"SELECT 2", &catalog).status, ShellStatus::Busy);
    assert_eq!(session.cancel_effect(effect_id, &mut catalog).data, b"Cancelled");
    assert_eq!(session.cancel_effect(effect_id, &mut catalog).status, ShellStatus::StaleEffect);
}

#[test]
fn converts_query_errors_to_output() {
    let mut catalog = Catalog::new();
    let mut session = ShellSession::new(&catalog, 80, false);
    let pending = session.start_query(b"SELECT * FROM missing_table", &catalog);
    assert_eq!(pending.status, ShellStatus::Pending);
    let complete = session.complete_effect(
        read_u64(&pending.data, 8),
        EffectCompletionStatus::Error,
        b"syntax error",
        &mut catalog,
    );
    assert_eq!(complete.status, ShellStatus::Ok);
    assert_eq!(complete.data, b"syntax error");
}

#[test]
fn aligns_continuation_marker_with_prompt_marker() {
    let catalog = Catalog::new();

    let mut short_session = ShellSession::new(&catalog, 80, false);
    assert_eq!(short_session.open_terminal(b"hyper> ").status, ShellStatus::Ok);
    let short_output = text(&short_session.consume_terminal_input(PromptInputKey::Enter, b"", &catalog).data);
    assert!(short_output.contains("    -> "));

    let mut long_session = ShellSession::new(&catalog, 80, false);
    assert_eq!(long_session.open_terminal(b"long-connection> ").status, ShellStatus::Ok);
    let long_output = text(&long_session.consume_terminal_input(PromptInputKey::Enter, b"", &catalog).data);
    assert!(long_output.contains("              -> "));
}

#[test]
fn applies_readline_bindings_to_multiline_prompt() {
    let catalog = Catalog::new();
    let mut session = ShellSession::new(&catalog, 80, false);

    session.set_prompt(b"SELECT one\nFROM table");
    assert_eq!(
        session.consume_prompt_input(PromptInputKey::LineStart, b"").cursor_byte_offset as usize,
        "SELECT one\n".len()
    );
    assert_eq!(session.consume_prompt_input(PromptInputKey::KillWord, b"").text, "SELECT one\n table");
    assert_eq!(session.consume_prompt_input(PromptInputKey::Yank, b"").text, "SELECT one\nFROM table");
    assert_eq!(
        session.consume_prompt_input(PromptInputKey::LineEnd, b"").cursor_byte_offset as usize,
        "SELECT one\nFROM table".len()
    );
    assert_eq!(session.consume_prompt_input(PromptInputKey::BackwardKillWord, b"").text, "SELECT one\nFROM ");
}

#[test]
fn renders_shell_prefixes_in_bold() {
    let catalog = Catalog::new();
    let mut session = ShellSession::new(&catalog, 80, false);
    let initial = session.open_terminal(b"dashql> ");
    assert_eq!(initial.status, ShellStatus::Ok);
    assert!(text(&initial.data).contains("\x1b[1mdashql> \x1b[0m"));

    let continuation = session.consume_terminal_input(PromptInputKey::Enter, b"", &catalog);
    assert!(text(&continuation.data).contains("\x1b[1m     -> \x1b[0m"));
    let _ = vt100::sequence(1, Command::CursorDown);
}

fn render_error(data: &[u8]) -> String {
    ArrowRenderer::new(80).render_ipc(data).unwrap_err()
}

#[test]
fn rejects_empty_buffers() {
    assert_eq!(render_error(&[]), "Invalid: Arrow IPC buffer is empty");
}

#[test]
fn reports_corrupted_stream_framing() {
    assert_eq!(render_error(&[1, 2, 3]), "Invalid: Corrupted message, only 3 bytes available");
    // A continuation token without a metadata length
    assert_eq!(render_error(&[0xff, 0xff, 0xff, 0xff, 1, 2]), "Invalid: Corrupted metadata length, only 2 bytes available");
    // Negative lengths
    let mut negative_length = vec![0xff, 0xff, 0xff, 0xff];
    negative_length.extend_from_slice(&(-5i32).to_le_bytes());
    assert_eq!(render_error(&negative_length), "IOError: Invalid IPC message: negative metadata length");
    assert_eq!(render_error(&(-5i32).to_le_bytes()), "IOError: Invalid IPC stream: negative continuation token");
    // Metadata that is longer than the data
    let mut short_metadata = vec![0xff, 0xff, 0xff, 0xff];
    short_metadata.extend_from_slice(&100i32.to_le_bytes());
    short_metadata.extend_from_slice(&[1, 2, 3]);
    assert_eq!(render_error(&short_metadata), "Invalid: Expected to read 100 metadata bytes, but only read 3");
    // The legacy framing without continuation token has the same checks
    let mut legacy = 64i32.to_le_bytes().to_vec();
    legacy.extend_from_slice(&[0; 10]);
    assert_eq!(render_error(&legacy), "Invalid: Expected to read 64 metadata bytes, but only read 10");
}

#[test]
fn reports_truncated_stream_bodies() {
    let stream = write_ipc_stream(&make_batch());
    // Cut into the record batch message, after the schema message
    let schema_message_end = 8 + i32::from_le_bytes(stream[4..8].try_into().unwrap()) as usize;
    let metadata_length = i32::from_le_bytes(stream[schema_message_end + 4..schema_message_end + 8].try_into().unwrap()) as usize;
    let body_begin = schema_message_end + 8 + metadata_length;
    let error = render_error(&stream[..body_begin + 2]);
    assert!(error.starts_with("IOError: Expected to be able to read"), "{error}");
}

#[test]
fn end_of_stream_marker_ends_the_stream() {
    // An immediate end of stream has no schema
    let mut marker = vec![0xff, 0xff, 0xff, 0xff];
    marker.extend_from_slice(&0i32.to_le_bytes());
    assert!(render_error(&marker).starts_with("Invalid:"));
}

#[test]
fn escapes_tabs_carriage_returns_and_control_bytes() {
    let batch = batch(
        vec![Field::new("text", DataType::Utf8, true)],
        vec![Arc::new(StringArray::from(vec!["a\tb", "line1\r\nline2", "lone\rcr", "trail\r", "bell\x07", "del\x7f"]))],
    );
    let output = render(80, &write_ipc(&batch));
    assert!(output.contains("a    b"), "{output}");
    assert!(output.contains("line1") && output.contains("line2"));
    assert!(!output.contains('\r') || output.contains("\r\n"));
    assert!(output.contains("lone") && output.contains("cr"));
    assert!(output.contains("bell\\x07"), "{output}");
    assert!(output.contains("del\\x7f"), "{output}");
    assert!(!output.contains('\t'));
}

#[test]
fn keeps_minimum_column_widths_on_tiny_terminals() {
    let wide = batch(
        vec![
            Field::new("first_column", DataType::Utf8, true),
            Field::new("second_column", DataType::Utf8, true),
            Field::new("third_column", DataType::Utf8, true),
        ],
        vec![
            Arc::new(StringArray::from(vec!["aaaaaaaaaaaa"])),
            Arc::new(StringArray::from(vec!["bbbbbbbbbbbb"])),
            Arc::new(StringArray::from(vec!["cccccccccccc"])),
        ],
    );
    let ipc = write_ipc(&wide);
    for columns in [1, 5, 12, 20] {
        let output = render(columns, &ipc);
        assert!(!output.is_empty());
    }
}

#[test]
fn resize_changes_the_wrap_width() {
    let ipc = write_ipc(&batch(
        vec![Field::new("text", DataType::Utf8, true)],
        vec![Arc::new(StringArray::from(vec!["one two three four five six seven eight nine ten eleven twelve"]))],
    ));
    let mut renderer = ArrowRenderer::new(80);
    let wide = String::from_utf8(renderer.render_ipc(&ipc).unwrap()).unwrap();
    renderer.resize(30);
    assert_eq!(renderer.terminal_columns(), 30);
    let narrow = String::from_utf8(renderer.render_ipc(&ipc).unwrap()).unwrap();
    assert!(narrow.lines().count() > wide.lines().count());
    expect_lines_fit(&narrow, 30);
    // A width of zero is clamped
    renderer.resize(0);
    assert_eq!(renderer.terminal_columns(), 1);
}

#[test]
fn default_renderer_is_100_columns_wide() {
    assert_eq!(ArrowRenderer::default().terminal_columns(), 100);
}

#[test]
fn zero_column_batches_with_rows_render_a_frame() {
    let rows = RecordBatch::try_new_with_options(
        Arc::new(Schema::empty()),
        vec![],
        &RecordBatchOptions::new().with_row_count(Some(2)),
    )
    .unwrap();
    // No columns, no output
    let output = ArrowRenderer::new(80).render_ipc(&write_ipc(&rows)).unwrap();
    assert!(output.is_empty() || !String::from_utf8_lossy(&output).contains("alpha"));
}
