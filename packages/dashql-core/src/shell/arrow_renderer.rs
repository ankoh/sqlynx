//! Renders Arrow IPC results as box-drawn tables (`src/shell/arrow_renderer.cc`).
//!
//! Cell values are formatted by arrow-cast (`ArrayFormatter`): floats with their shortest round-trip digits,
//! temporal values in ISO 8601, binaries in hex, nested values like `[1, 2]` or `{a: 1}`.

use super::unicode::{display_width, graphemes};
use arrow_array::timezone::Tz;
use arrow_array::{make_array, Array, ArrayRef, RecordBatch};
use arrow_cast::display::{ArrayFormatter, FormatOptions};
use arrow_schema::{DataType, Schema};
use std::fmt::Write;
use std::io::Cursor;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Alignment {
    Left,
    Right,
}

const CELL_PADDING: usize = 2;
const MIN_CONTENT_WIDTH: usize = 1;
const MAX_ROW_HEIGHT: usize = 20;
const TRUNCATION_MARKER: &[u8] = b"...";
const NO_RESULTS_MESSAGE: &[u8] = b"No results";
/// Null cells stay empty, nulls inside nested values print as `null`
const FORMAT_OPTIONS: FormatOptions<'static> = FormatOptions::new().with_null("null");

/// A cell of a rendered table
struct Cell {
    /// The escaped cell text
    text: Vec<u8>,
    /// The horizontal alignment of the text
    alignment: Alignment,
}

/// A result table with formatted cells
struct Table {
    /// The escaped column names
    headers: Vec<Vec<u8>>,
    /// The alignment of every column, right for numeric and boolean columns
    alignments: Vec<Alignment>,
    /// The rows of cells
    rows: Vec<Vec<Cell>>,
}

/// Make cell text safe for a terminal (`EscapeCellText`)
fn escape_cell_text(text: &[u8]) -> Vec<u8> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = Vec::with_capacity(text.len());
    for (i, &value) in text.iter().enumerate() {
        if value == b'\n' {
            output.push(b'\n');
        } else if value == b'\r' {
            if i + 1 >= text.len() || text[i + 1] != b'\n' {
                output.push(b'\n');
            }
        } else if value == b'\t' {
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

/// Numbers and booleans are right-aligned
fn is_right_aligned(data_type: &DataType) -> bool {
    data_type.is_numeric() || *data_type == DataType::Boolean
}

fn create_table(schema: &Schema) -> Table {
    Table {
        headers: schema.fields().iter().map(|f| escape_cell_text(f.name().as_bytes())).collect(),
        alignments: schema
            .fields()
            .iter()
            .map(|f| if is_right_aligned(f.data_type()) { Alignment::Right } else { Alignment::Left })
            .collect(),
        rows: Vec::new(),
    }
}

/// arrow-cast resolves named time zones only with chrono-tz, which the shell does not link. Timestamp columns
/// with such a time zone are shown in UTC.
fn displayable(column: &ArrayRef) -> ArrayRef {
    match column.data_type() {
        DataType::Timestamp(unit, Some(tz)) if tz.parse::<Tz>().is_err() => {
            let utc = DataType::Timestamp(*unit, Some("+00:00".into()));
            make_array(column.to_data().into_builder().data_type(utc).build().expect("timestamps keep their layout"))
        }
        _ => column.clone(),
    }
}

fn append_batch(table: &mut Table, batch: &RecordBatch) {
    let columns: Vec<ArrayRef> = batch.columns().iter().map(displayable).collect();
    let nulls: Vec<_> = columns.iter().map(|column| column.logical_nulls()).collect();
    // A column that arrow-cast cannot format shows its type
    let formatters: Vec<_> =
        columns.iter().map(|column| ArrayFormatter::try_new(column.as_ref(), &FORMAT_OPTIONS).ok()).collect();
    let mut text = String::new();
    for row in 0..batch.num_rows() {
        let mut cells = Vec::with_capacity(columns.len());
        for column in 0..columns.len() {
            text.clear();
            if !nulls[column].as_ref().is_some_and(|nulls| nulls.is_null(row)) {
                let _ = match &formatters[column] {
                    Some(formatter) => write!(text, "{}", formatter.value(row)),
                    None => write!(text, "{}", columns[column].data_type()),
                };
            }
            cells.push(Cell { text: escape_cell_text(text.as_bytes()), alignment: table.alignments[column] });
        }
        table.rows.push(cells);
    }
}

/// Read an Arrow IPC file, or an IPC stream if the data is no file (`ReadIPC`). Errors carry the Arrow status
/// text; the messages of Arrow C++ are only reproduced for empty buffers.
fn read_ipc(data: &[u8]) -> Result<Table, String> {
    if data.is_empty() {
        return Err("Invalid: Arrow IPC buffer is empty".into());
    }
    if let Ok(reader) = arrow_ipc::reader::FileReader::try_new(Cursor::new(data), None) {
        let mut table = create_table(&reader.schema());
        for batch in reader {
            let batch = batch.map_err(|e| format!("Invalid: {}", e))?;
            append_batch(&mut table, &batch);
        }
        return Ok(table);
    }
    check_stream_framing(data)?;
    let reader =
        arrow_ipc::reader::StreamReader::try_new(Cursor::new(data), None).map_err(|e| format!("Invalid: {}", e))?;
    let mut table = create_table(&reader.schema());
    for batch in reader {
        let batch = batch.map_err(|e| format!("Invalid: {}", e))?;
        append_batch(&mut table, &batch);
    }
    Ok(table)
}

/// Check the message framing of an IPC stream like the Arrow C++ `DecodeMessage`: arrow-rs ends a stream at a
/// truncated message prefix, Arrow C++ reports it. Messages are read up to the end-of-stream marker.
fn check_stream_framing(data: &[u8]) -> Result<(), String> {
    let read_i32 = |pos: usize| i32::from_le_bytes(data[pos..pos + 4].try_into().unwrap());
    let mut pos = 0;
    loop {
        let remaining = data.len() - pos;
        if remaining == 0 {
            return Ok(());
        }
        if remaining < 4 {
            return Err(format!("Invalid: Corrupted message, only {} bytes available", remaining));
        }
        let continuation = read_i32(pos);
        pos += 4;
        let metadata_length = match continuation {
            -1 => {
                let remaining = data.len() - pos;
                if remaining < 4 {
                    return Err(format!("Invalid: Corrupted metadata length, only {} bytes available", remaining));
                }
                let length = read_i32(pos);
                pos += 4;
                match length {
                    0 => return Ok(()),
                    l if l < 0 => return Err("IOError: Invalid IPC message: negative metadata length".into()),
                    l => l as usize,
                }
            }
            0 => return Ok(()),
            l if l > 0 => l as usize,
            _ => return Err("IOError: Invalid IPC stream: negative continuation token".into()),
        };
        let remaining = data.len() - pos;
        if remaining < metadata_length {
            return Err(format!(
                "Invalid: Expected to read {} metadata bytes, but only read {}",
                metadata_length, remaining
            ));
        }
        let message =
            arrow_ipc::root_as_message(&data[pos..pos + metadata_length]).map_err(|e| format!("Invalid: {}", e))?;
        pos += metadata_length;
        let body_length = message.bodyLength().max(0) as usize;
        let remaining = data.len() - pos;
        if remaining < body_length {
            return Err(format!(
                "IOError: Expected to be able to read {} bytes for message body, got {}",
                body_length, remaining
            ));
        }
        pos += body_length;
    }
}

/// A grapheme cluster of a text
struct Grapheme {
    /// The byte offset of the cluster
    begin: usize,
    /// The byte offset after the cluster
    end: usize,
    /// The display width in terminal columns
    width: usize,
}

fn text_graphemes(text: &[u8]) -> Vec<Grapheme> {
    graphemes(text)
        .into_iter()
        .map(|(begin, end)| Grapheme { begin, end, width: display_width(&text[begin..end]) })
        .collect()
}

/// Cut a text to a width and append "..." (`MarkTruncated`)
fn mark_truncated(text: &[u8], width: usize) -> Vec<u8> {
    let marker_width = width.min(TRUNCATION_MARKER.len());
    let content_width = width - marker_width;
    let mut end = 0;
    let mut rendered = 0;
    for grapheme in text_graphemes(text) {
        if rendered + grapheme.width > content_width {
            break;
        }
        rendered += grapheme.width;
        end = grapheme.end;
    }
    let mut output = text[..end].to_vec();
    output.extend_from_slice(&TRUNCATION_MARKER[..marker_width]);
    output
}

/// `std::isspace` in the C locale
fn is_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r')
}

fn wrap_line(text: &[u8], width: usize) -> Vec<Vec<u8>> {
    let width = width.max(1);
    if text.is_empty() {
        return vec![Vec::new()];
    }
    let graphemes = text_graphemes(text);
    let is_space_grapheme = |g: &Grapheme| g.end - g.begin == 1 && is_space(text[g.begin]);
    let mut lines = Vec::new();
    let mut begin = 0;
    while begin < graphemes.len() {
        let mut end = begin;
        let mut rendered: usize = 0;
        let mut whitespace = None;
        while end < graphemes.len() && (rendered == 0 || rendered.saturating_add(graphemes[end].width) <= width) {
            rendered += graphemes[end].width;
            if is_space_grapheme(&graphemes[end]) {
                whitespace = Some(end);
            }
            end += 1;
        }
        if let Some(whitespace) = whitespace {
            if end < graphemes.len() && whitespace >= begin {
                end = whitespace + 1;
            }
        }
        let mut content_end = end;
        while content_end > begin && is_space_grapheme(&graphemes[content_end - 1]) {
            content_end -= 1;
        }
        let byte_begin = graphemes[begin].begin;
        let byte_end = if content_end > begin { graphemes[content_end - 1].end } else { byte_begin };
        lines.push(text[byte_begin..byte_end].to_vec());
        begin = end;
    }
    lines
}

fn wrap_text(text: &[u8], width: usize) -> Vec<Vec<u8>> {
    let mut lines = Vec::new();
    let mut begin = 0;
    loop {
        let end = text[begin..].iter().position(|&c| c == b'\n').map(|i| i + begin);
        lines.extend(wrap_line(&text[begin..end.unwrap_or(text.len())], width));
        match end {
            Some(end) => begin = end + 1,
            None => break,
        }
    }
    lines
}

fn frame_width(column_count: usize) -> usize {
    if column_count == 0 {
        0
    } else {
        (CELL_PADDING + 1) * column_count + 1
    }
}

fn visible_column_count(mut column_count: usize, terminal_columns: usize) -> usize {
    while column_count > 1 && frame_width(column_count) + column_count * MIN_CONTENT_WIDTH > terminal_columns {
        column_count -= 1;
    }
    column_count
}

fn resolve_column_widths(table: &Table, terminal_columns: usize) -> Vec<usize> {
    let column_count = visible_column_count(table.headers.len(), terminal_columns);
    let mut widths: Vec<usize> = (0..column_count).map(|c| display_width(&table.headers[c]).max(1)).collect();
    for row in &table.rows {
        for column in 0..row.len().min(column_count) {
            for line in wrap_text(&row[column].text, usize::MAX) {
                widths[column] = widths[column].max(display_width(&line));
            }
        }
    }
    if column_count == 0 {
        return widths;
    }
    let frame = frame_width(column_count);
    let available = if terminal_columns > frame { terminal_columns - frame } else { column_count };
    if available < column_count {
        return vec![MIN_CONTENT_WIDTH; column_count];
    }
    // The C++ loop recomputes the total only right before it breaks, so it runs while the initial total
    // exceeds the available width
    let total: usize = widths.iter().sum();
    if total <= available {
        return widths;
    }
    let mut fixed = vec![false; column_count];
    loop {
        let mut remaining_width = available;
        let mut remaining_columns = 0;
        for column in 0..column_count {
            if fixed[column] {
                remaining_width = remaining_width.saturating_sub(widths[column]);
            } else {
                remaining_columns += 1;
            }
        }
        if remaining_columns == 0 {
            break;
        }
        let share = MIN_CONTENT_WIDTH.max(remaining_width / remaining_columns);
        let mut found_small = false;
        for column in 0..column_count {
            if !fixed[column] && widths[column] <= share {
                fixed[column] = true;
                found_small = true;
            }
        }
        if found_small {
            continue;
        }
        let base = MIN_CONTENT_WIDTH.max(remaining_width / remaining_columns);
        let mut excess = remaining_width.saturating_sub(base * remaining_columns);
        for column in 0..column_count {
            if !fixed[column] {
                widths[column] = base + if excess > 0 { 1 } else { 0 };
                excess = excess.saturating_sub(1);
            }
        }
        break;
    }
    widths
}

fn append_rule(output: &mut Vec<u8>, left: &str, middle: &str, right: &str, fill: &str, widths: &[usize]) {
    output.extend_from_slice(left.as_bytes());
    for (column, width) in widths.iter().enumerate() {
        if column != 0 {
            output.extend_from_slice(middle.as_bytes());
        }
        for _ in 0..width + 2 {
            output.extend_from_slice(fill.as_bytes());
        }
    }
    output.extend_from_slice(right.as_bytes());
    output.push(b'\n');
}

fn append_cell(output: &mut Vec<u8>, text: &[u8], width: usize, alignment: Alignment) {
    let padding = width.saturating_sub(display_width(text));
    if alignment == Alignment::Right {
        output.extend(std::iter::repeat_n(b' ', padding));
    }
    output.extend_from_slice(text);
    if alignment == Alignment::Left {
        output.extend(std::iter::repeat_n(b' ', padding));
    }
}

fn append_row(output: &mut Vec<u8>, cells: &[Cell], widths: &[usize], separator: &str) {
    let mut wrapped = Vec::with_capacity(widths.len());
    let mut row_height = 1;
    for (column, &width) in widths.iter().enumerate() {
        let text: &[u8] = cells.get(column).map_or(&[], |c| &c.text);
        let mut lines = wrap_text(text, width);
        if lines.len() > MAX_ROW_HEIGHT {
            lines.truncate(MAX_ROW_HEIGHT);
            let last = lines.last_mut().unwrap();
            *last = mark_truncated(last, width);
        }
        row_height = row_height.max(lines.len());
        wrapped.push(lines);
    }
    for line in 0..row_height {
        output.extend_from_slice("│ ".as_bytes());
        for (column, &width) in widths.iter().enumerate() {
            if column != 0 {
                output.push(b' ');
                output.extend_from_slice(separator.as_bytes());
                output.push(b' ');
            }
            let text: &[u8] = wrapped[column].get(line).map_or(&[], |l| l);
            let alignment = cells.get(column).map_or(Alignment::Left, |c| c.alignment);
            append_cell(output, text, width, alignment);
        }
        output.extend_from_slice(" │\n".as_bytes());
    }
}

fn render_table(table: &Table, terminal_columns: usize) -> Vec<u8> {
    if table.headers.is_empty() {
        return NO_RESULTS_MESSAGE.to_vec();
    }
    let widths = resolve_column_widths(table, terminal_columns);
    let mut output = Vec::new();
    append_rule(&mut output, "╭", "┬", "╮", "─", &widths);
    let headers: Vec<Cell> = (0..widths.len())
        .map(|column| {
            let mut header = table.headers[column].clone();
            if column + 1 == widths.len() && widths.len() < table.headers.len() {
                header = mark_truncated(&header, widths[column]);
            }
            Cell { text: header, alignment: Alignment::Left }
        })
        .collect();
    append_row(&mut output, &headers, &widths, "│");
    append_rule(&mut output, "╞", "╪", "╡", "═", &widths);
    for row in &table.rows {
        append_row(&mut output, row, &widths, "│");
    }
    append_rule(&mut output, "╰", "┴", "╯", "─", &widths);
    output.pop();
    output
}

/// Renders Arrow IPC results for a terminal width (`ArrowRenderer`)
#[derive(Clone, Debug)]
pub struct ArrowRenderer {
    /// The terminal width in columns, at least 1
    terminal_columns: u32,
}

impl ArrowRenderer {
    pub fn new(terminal_columns: u32) -> Self {
        Self { terminal_columns: terminal_columns.max(1) }
    }

    pub fn resize(&mut self, terminal_columns: u32) {
        self.terminal_columns = terminal_columns.max(1);
    }

    pub fn terminal_columns(&self) -> u32 {
        self.terminal_columns
    }

    /// Render an Arrow IPC file or stream (`RenderIPC`). Errors are Arrow status texts.
    pub fn render_ipc(&self, data: &[u8]) -> Result<Vec<u8>, String> {
        let table = read_ipc(data)?;
        Ok(render_table(&table, self.terminal_columns as usize))
    }
}

impl Default for ArrowRenderer {
    fn default() -> Self {
        Self::new(100)
    }
}
