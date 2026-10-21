//! The text output of the CLI

use crate::lint::{line_column, Diagnostic, Severity};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Color {
    Bold,
    Dim,
    Red,
    Yellow,
    Green,
    Cyan,
}

/// Applies text styles with ANSI escapes, they do not change the visible width
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Style {
    /// Whether to emit ANSI escapes at all
    pub colors: bool,
}

impl Style {
    /// Colors when stdout is a terminal. `FORCE_COLOR` (other than `0`) forces them, `NO_COLOR` turns them off.
    pub fn for_stdout() -> Self {
        use std::io::IsTerminal;
        let set = |name| std::env::var_os(name).is_some_and(|v| !v.is_empty());
        let colors = match std::env::var("FORCE_COLOR") {
            Ok(v) if !v.is_empty() => v != "0",
            _ => !set("NO_COLOR") && std::io::stdout().is_terminal(),
        };
        Style { colors }
    }

    pub fn apply(self, color: Color, text: &str) -> String {
        if !self.colors {
            return text.to_string();
        }
        let (on, off) = match color {
            Color::Bold => (1, 22),
            Color::Dim => (2, 22),
            Color::Red => (31, 39),
            Color::Green => (32, 39),
            Color::Yellow => (33, 39),
            Color::Cyan => (36, 39),
        };
        format!("\x1b[{on}m{text}\x1b[{off}m")
    }
}

/// "warning"
const LABEL_WIDTH: usize = 7;
/// "analyze", "failure"
const STAGE_WIDTH: usize = 7;

fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

/// A duration in milliseconds, in seconds from one second on
pub fn duration(d: Duration) -> String {
    let ms = d.as_secs_f64() * 1000.0;
    if ms < 1000.0 {
        format!("{} ms", ms.round())
    } else {
        format!("{:.1} s", ms / 1000.0)
    }
}

fn severity_color(severity: Severity) -> Color {
    match severity {
        Severity::Error => Color::Red,
        Severity::Warning => Color::Yellow,
    }
}

/// The source line of a diagnostic and the underline of its span
fn code_frame(text: &str, d: &Diagnostic) -> Option<(String, String)> {
    let location = d.location?;
    // Columns count code points, tabs are shown as a single space to keep the caret aligned
    let line = text.split('\n').nth(location.line - 1).unwrap_or("");
    let line = line.strip_suffix('\r').unwrap_or(line).replace('\t', " ");
    let (end_line, end_column) = line_column(text, location.offset + location.length);
    let end_column = if end_line == location.line { end_column } else { line.chars().count() + 1 };
    let width = end_column.saturating_sub(location.column).max(1);
    Some((line, format!("{}{}", " ".repeat(location.column - 1), "^".repeat(width))))
}

/// Format the diagnostics of one script, the file name followed by one indented line per finding
pub fn format_file(file: &str, text: &str, diagnostics: &[Diagnostic], style: Style) -> String {
    let locations: Vec<String> = diagnostics
        .iter()
        .map(|d| d.location.map(|l| format!("{}:{}", l.line, l.column)).unwrap_or_default())
        .collect();
    let location_width = locations.iter().map(String::len).max().unwrap_or(0);
    let indent = " ".repeat(2 + location_width + 2);
    let continuation = " ".repeat(indent.len() + LABEL_WIDTH + 2 + STAGE_WIDTH + 2);

    let mut out = vec![style.apply(Color::Bold, file)];
    for (d, location) in diagnostics.iter().zip(&locations) {
        let color = severity_color(d.severity);
        let mut lines = d.message.split('\n');
        out.push(format!(
            "  {}  {}  {}  {}",
            style.apply(Color::Cyan, &format!("{location:location_width$}")),
            style.apply(color, &format!("{:LABEL_WIDTH$}", d.severity.name())),
            style.apply(Color::Dim, &format!("{:STAGE_WIDTH$}", d.stage.name())),
            lines.next().unwrap_or(""),
        ));
        out.extend(lines.map(|line| format!("{continuation}{line}")));
        if let Some((line, underline)) = code_frame(text, d) {
            let bar = style.apply(Color::Dim, "│");
            out.push(format!("{indent}{bar} {line}"));
            out.push(format!("{indent}{bar} {}", style.apply(color, &underline)));
        }
    }
    out.join("\n")
}

pub fn format_summary(files: usize, errors: usize, warnings: usize, style: Style) -> String {
    let count = |n, word, color| style.apply(if n > 0 { color } else { Color::Green }, &plural(n, word));
    format!("{}, {}, {}", plural(files, "file"), count(errors, "error", Color::Red), count(warnings, "warning", Color::Yellow))
}

/// Where the time of a run went
pub fn format_timings(lint: Duration, style: Style) -> String {
    format!("{}  scan, parse and analyze {}", style.apply(Color::Dim, "dashql-core"), duration(lint))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lint::{Location, Stage};

    const PLAIN: Style = Style { colors: false };

    fn parse_error() -> Diagnostic {
        Diagnostic {
            stage: Stage::Parse,
            severity: Severity::Error,
            message: "syntax error, unexpected SEMICOLON".into(),
            location: Some(Location { line: 2, column: 11, offset: 20, length: 1 }),
        }
    }

    #[test]
    fn shows_diagnostics_with_the_underlined_source_line() {
        let text = "select 1;\nselect 1 +;\n";
        assert_eq!(
            format_file("q.sql", text, &[parse_error()], PLAIN),
            [
                "q.sql",
                "  2:11  error    parse    syntax error, unexpected SEMICOLON",
                "        │ select 1 +;",
                "        │           ^",
            ]
            .join("\n"),
        );
    }

    #[test]
    fn underlines_the_whole_span_in_code_points() {
        let text = "select 'ä' + bogus;";
        let d = Diagnostic {
            stage: Stage::Analyze,
            severity: Severity::Warning,
            message: "hm".into(),
            location: Some(Location { line: 1, column: 14, offset: 14, length: 5 }),
        };
        let out = format_file("q.sql", text, &[d], PLAIN);
        assert_eq!(out.split('\n').skip(2).collect::<Vec<_>>(), ["        │ select 'ä' + bogus;", "        │              ^^^^^"]);
    }

    #[test]
    fn indents_multi_line_messages_and_failures() {
        let failure = Diagnostic { stage: Stage::Failure, severity: Severity::Error, message: "boom\nmore".into(), location: None };
        assert_eq!(
            format_file("q.sql", "", &[failure], PLAIN),
            ["q.sql", "    error    failure  boom", "                      more"].join("\n"),
        );
    }

    #[test]
    fn styles_without_changing_the_text() {
        let style = Style { colors: true };
        assert_eq!(style.apply(Color::Red, "x"), "\x1b[31mx\x1b[39m");
        assert_eq!(style.apply(Color::Bold, "x"), "\x1b[1mx\x1b[22m");
    }

    #[test]
    fn counts_files_errors_and_warnings() {
        assert_eq!(format_summary(1, 0, 2, PLAIN), "1 file, 0 errors, 2 warnings");
        assert_eq!(format_summary(3, 1, 0, PLAIN), "3 files, 1 error, 0 warnings");
    }

    #[test]
    fn formats_durations() {
        assert_eq!(duration(Duration::from_micros(400)), "0 ms");
        assert_eq!(duration(Duration::from_millis(999)), "999 ms");
        assert_eq!(duration(Duration::from_millis(1260)), "1.3 s");
        assert_eq!(format_timings(Duration::from_millis(42), PLAIN), "dashql-core  scan, parse and analyze 42 ms");
    }
}
