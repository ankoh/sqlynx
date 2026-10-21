//! Scans, parses and analyzes scripts with dashql-core and collects their diagnostics

use dashql_core::batch::{check_script, DiagnosticSeverity, ProcessingStage};
use dashql_core::catalog::Catalog;

/// A script that should be linted
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Input {
    /// The path relative to the invoking directory, `<stdin>` for standard input
    pub id: String,
    /// The script text
    pub text: String,
}

/// The stage that reported a diagnostic, `Failure` if processing failed
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Scan,
    Parse,
    Analyze,
    Failure,
}

impl Stage {
    pub fn name(self) -> &'static str {
        match self {
            Stage::Scan => "scan",
            Stage::Parse => "parse",
            Stage::Analyze => "analyze",
            Stage::Failure => "failure",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

impl Severity {
    pub fn name(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
        }
    }
}

/// Where a diagnostic points into its script
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Location {
    /// 1-based line and column, the column counts code points
    pub line: usize,
    /// The 1-based column in code points
    pub column: usize,
    /// UTF-8 byte offset and length in the script
    pub offset: usize,
    /// The UTF-8 byte length in the script
    pub length: usize,
}

/// A diagnostic reported for a script
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    /// The stage that reported the diagnostic
    pub stage: Stage,
    /// Whether the diagnostic is an error or a warning
    pub severity: Severity,
    /// The diagnostic message
    pub message: String,
    /// Absent for failures
    pub location: Option<Location>,
}

impl Diagnostic {
    fn failure(message: String) -> Self {
        Diagnostic { stage: Stage::Failure, severity: Severity::Error, message, location: None }
    }
}

/// Resolve a UTF-8 byte offset to a 1-based line and column, the column counts code points
pub fn line_column(text: &str, offset: usize) -> (usize, usize) {
    let mut line = 1;
    let mut column = 1;
    for &byte in &text.as_bytes()[..offset.min(text.len())] {
        if byte == b'\n' {
            line += 1;
            column = 1;
        } else if byte & 0xc0 != 0x80 {
            // Continuation bytes belong to the code point that was already counted
            column += 1;
        }
    }
    (line, column)
}

/// Runs scripts through the DashQL scanner, parser and analyzer against a catalog of schema scripts
#[derive(Default)]
pub struct Linter {
    /// The catalog holding the loaded schema scripts
    catalog: Catalog,
    /// The number of schema scripts loaded so far, used as the catalog rank of the next one
    schemas: u32,
}

impl Linter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a schema script (e.g. CREATE TABLE statements) to the catalog that later scripts resolve names against.
    /// Returns the diagnostics of the schema script itself, a schema with errors is not added.
    pub fn add_schema(&mut self, input: &Input) -> Vec<Diagnostic> {
        let checked = check_script(&self.catalog, &input.text, ProcessingStage::ANALYZE);
        let mut diagnostics = to_diagnostics(&input.text, &checked);
        if let (false, Some(analyzed)) = (checked.has_errors(), checked.script.analyzed) {
            if let Err(e) = self.catalog.load_script(analyzed, self.schemas) {
                diagnostics.push(Diagnostic::failure(e.message));
            }
            self.schemas += 1;
        }
        diagnostics
    }

    /// Lint a script against the loaded schemas
    pub fn lint(&self, input: &Input) -> Vec<Diagnostic> {
        to_diagnostics(&input.text, &check_script(&self.catalog, &input.text, ProcessingStage::ANALYZE))
    }
}

fn to_diagnostics(text: &str, checked: &dashql_core::batch::CheckedScript) -> Vec<Diagnostic> {
    let mut out: Vec<Diagnostic> = checked
        .diagnostics
        .iter()
        .map(|d| {
            let offset = d.span.offset as usize;
            let (line, column) = line_column(text, offset);
            Diagnostic {
                stage: match d.stage {
                    ProcessingStage::SCAN => Stage::Scan,
                    ProcessingStage::PARSE => Stage::Parse,
                    _ => Stage::Analyze,
                },
                severity: if d.severity == DiagnosticSeverity::WARNING { Severity::Warning } else { Severity::Error },
                message: d.message.clone(),
                location: Some(Location { line, column, offset, length: d.span.length as usize }),
            }
        })
        .collect();
    if let Some(failure) = &checked.failure {
        out.push(Diagnostic::failure(failure.clone()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lint_one(linter: &Linter, text: &str) -> Vec<Diagnostic> {
        linter.lint(&Input { id: "test.sql".into(), text: text.into() })
    }

    #[test]
    fn resolves_byte_offsets_to_lines_and_code_point_columns() {
        let text = "ab\näöc\nx";
        assert_eq!(line_column(text, 0), (1, 1));
        assert_eq!(line_column(text, 3), (2, 1));
        // ä and ö take two bytes each
        assert_eq!(line_column(text, 7), (2, 3));
        assert_eq!(line_column(text, 9), (3, 1));
        assert_eq!(line_column(text, 100), (3, 2));
    }

    #[test]
    fn reports_nothing_for_a_clean_script() {
        assert_eq!(lint_one(&Linter::new(), "select 1;\nselect a from b where c = 42;"), vec![]);
    }

    #[test]
    fn reports_scanner_errors() {
        let diagnostics = lint_one(&Linter::new(), "select 'unterminated");
        assert!(diagnostics.iter().any(|d| d.stage == Stage::Scan && d.severity == Severity::Error));
    }

    #[test]
    fn reports_parser_errors_with_their_position() {
        let diagnostics = lint_one(&Linter::new(), "select 1;\nselect 1 +;");
        let parse = diagnostics.iter().find(|d| d.stage == Stage::Parse).unwrap();
        assert_eq!(parse.severity, Severity::Error);
        let location = parse.location.unwrap();
        assert_eq!((location.line, location.column), (2, 11));
        assert!(!parse.message.is_empty());
    }

    #[test]
    fn reports_analyzer_errors_against_a_schema() {
        let mut linter = Linter::new();
        let schema = "create table a (id integer); create table b (id integer);";
        assert_eq!(linter.add_schema(&Input { id: "schema.sql".into(), text: schema.into() }), vec![]);
        let diagnostics = lint_one(&linter, "select id from a, b;");
        assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
        assert_eq!((diagnostics[0].stage, diagnostics[0].severity), (Stage::Analyze, Severity::Error));
        let location = diagnostics[0].location.unwrap();
        assert_eq!((location.line, location.column), (1, 8));
    }

    #[test]
    fn skips_schemas_with_errors() {
        let mut linter = Linter::new();
        let diagnostics = linter.add_schema(&Input { id: "schema.sql".into(), text: "create table a (id integer".into() });
        assert!(diagnostics.iter().any(|d| d.severity == Severity::Error));
        assert_eq!(linter.schemas, 0);
    }
}
