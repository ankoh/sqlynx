//! The formatter snapshot cases (`snapshots/formatter/*.yaml`).
//!
//! Reads the cases like the C++ loader (`src/testing/formatter_snapshot_test.cc`): every dialect of a
//! case carries formatting expectations and optionally a validation block that executes the
//! formatted output against a live database.

use crate::{load_category, SnapshotCase, Yaml};
use dashql_buffers::formatting::FormattingConfigT;
use dashql_core::formatter::{
    parse_formatting_dialect, parse_formatting_mode, FORMATTING_DEFAULT_INDENTATION_WIDTH, FORMATTING_DEFAULT_MAX_WIDTH,
};

/// One (config, expected output) pair
pub struct Expectation {
    /// The formatting config: dialect, mode, indentation and width
    pub config: FormattingConfigT,
    /// The expected output, trimmed of spaces and newlines on both ends
    pub formatted: String,
}

/// The validation of a dialect: run `setup`, then every formatted output, against a live database
pub struct Validation {
    /// The setup script, trimmed, empty if the case has none
    pub setup: String,
}

/// The expectations of a dialect
pub struct DialectExpectations {
    /// The dialect name, the key in the `dialects` map
    pub dialect: String,
    /// Is the dialect marked as skipped?
    pub skip: bool,
    /// The expected outputs of the dialect
    pub expectations: Vec<Expectation>,
    /// The validation against a live database, if the dialect has one
    pub validation: Option<Validation>,
}

/// A formatter snapshot case with at least one dialect
pub struct FormatterCase {
    /// The snapshot case
    pub case: SnapshotCase,
    /// The input, trimmed of spaces and newlines on both ends
    pub input: String,
    /// The dialects with expectations or a skip mark, in file order
    pub dialects: Vec<DialectExpectations>,
}

impl FormatterCase {
    /// The dialect expectations that carry a validation for `dialect`
    pub fn validation(&self, dialect: &str) -> Option<&DialectExpectations> {
        self.dialects.iter().find(|d| d.dialect == dialect && d.validation.is_some())
    }
}

/// Trim spaces and newlines on both ends (`trim_view(..., is_no_space)`)
fn trim_no_space(text: &str) -> String {
    text.trim_matches([' ', '\n']).to_string()
}

/// A scalar as text, like ryml's `val()`
fn scalar(node: &Yaml) -> Option<String> {
    match node {
        Yaml::String(s) => Some(s.clone()),
        Yaml::Integer(i) => Some(i.to_string()),
        Yaml::Real(r) => Some(r.clone()),
        Yaml::Boolean(b) => Some(b.to_string()),
        _ => None,
    }
}

/// `std::atoi`: leading whitespace, an optional sign, then digits
fn atoi(text: &str) -> usize {
    let text = text.trim_start();
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let value: i64 = digits.bytes().take_while(u8::is_ascii_digit).fold(0, |v, d| v * 10 + (d - b'0') as i64);
    (if negative { -value } else { value }) as usize
}

fn read_dialects(case: &Yaml) -> Vec<DialectExpectations> {
    let mut dialects = Vec::new();
    let Some(entries) = case["dialects"].as_hash() else { return dialects };
    for (key, dialect_node) in entries {
        let dialect = scalar(key).unwrap_or_default();
        let parsed_dialect = parse_formatting_dialect(&dialect);
        let skip = scalar(&dialect_node["skip"]).is_some_and(|v| v == "true" || v == "1");
        let mut expectations = Vec::new();
        for formatted in dialect_node["formatted"].as_vec().into_iter().flatten() {
            let mut config = FormattingConfigT::default();
            config.dialect = parsed_dialect;
            config.mode = parse_formatting_mode(&scalar(&formatted["mode"]).unwrap_or_else(|| "compact".into()));
            config.indentation_width =
                scalar(&formatted["indent"]).map(|v| atoi(&v)).unwrap_or(FORMATTING_DEFAULT_INDENTATION_WIDTH) as u32;
            config.max_width =
                scalar(&formatted["width"]).map(|v| atoi(&v)).unwrap_or(FORMATTING_DEFAULT_MAX_WIDTH) as u32;
            let formatted = scalar(&formatted["expected"]).map(|v| trim_no_space(&v)).unwrap_or_default();
            expectations.push(Expectation { config, formatted });
        }
        // A validation key without a setup map validates with an empty setup
        let validation = match &dialect_node["validation"] {
            Yaml::BadValue => None,
            node => Some(Validation { setup: scalar(&node["setup"]).map(|v| trim_no_space(&v)).unwrap_or_default() }),
        };
        if skip || !expectations.is_empty() {
            dialects.push(DialectExpectations { dialect, skip, expectations, validation });
        }
    }
    dialects
}

/// Load the formatter cases. Like the C++ loader, cases without dialect expectations are left out.
pub fn load_formatter_cases() -> Result<Vec<FormatterCase>, String> {
    let mut out = Vec::new();
    for case in load_category("formatter")? {
        let dialects = read_dialects(&case.node);
        if dialects.is_empty() {
            continue;
        }
        let input = scalar(&case.node["input"]).map(|v| trim_no_space(&v)).unwrap_or_default();
        out.push(FormatterCase { case, input, dialects });
    }
    Ok(out)
}
