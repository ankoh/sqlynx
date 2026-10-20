//! Oracle functions for the formatter port (`tools/oracle_ffi_formatter.cc`).

use crate::{take_result, OracleResult};
use std::os::raw::c_char;

/// A formatting config (`DashQLOracleFormattingConfig`), the values of the FlatBuffers enums
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FormattingConfig {
    pub dialect: u8,
    pub mode: u8,
    pub keyword_case: u8,
    pub debug_mode: u8,
    pub max_width: u32,
    pub indentation_width: u32,
}

extern "C" {
    fn dashql_oracle_format(text: *const c_char, length: usize, config: *const FormattingConfig) -> OracleResult;
    fn dashql_oracle_format_node(
        text: *const c_char,
        length: usize,
        node_id: u32,
        config: *const FormattingConfig,
    ) -> OracleResult;
}

/// The output of the C++ formatter
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Formatted {
    /// The unformattable nodes, in the order the formatter recorded them
    pub unformattable_nodes: Vec<u32>,
    /// The formatted text (lossy UTF-8, wrapped comments may split UTF-8 sequences)
    pub text: String,
}

fn read_output(out: String) -> Result<Formatted, String> {
    let (header, text) = out.split_once('\n').ok_or_else(|| format!("invalid oracle output {out:?}"))?;
    let ids = header.strip_prefix('U').ok_or_else(|| format!("invalid oracle output {out:?}"))?;
    let unformattable_nodes =
        ids.split_whitespace().map(|id| id.parse::<u32>().map_err(|e| e.to_string())).collect::<Result<_, _>>()?;
    Ok(Formatted { unformattable_nodes, text: text.to_string() })
}

/// Scan, parse and format a script with the C++ formatter (`Formatter::Format`)
pub fn format(text: &str, config: &FormattingConfig) -> Result<Formatted, String> {
    // SAFETY: the oracle reads `length` bytes of `text` and the config, and returns an unreleased result.
    let out = unsafe { take_result(dashql_oracle_format(text.as_ptr() as *const c_char, text.len(), config))? };
    read_output(out)
}

/// Format a single node with executable literals (`Formatter::FormatNodeAt` after `ReplaceObfuscatedLiterals`)
pub fn format_node(text: &str, node_id: u32, config: &FormattingConfig) -> Result<Formatted, String> {
    // SAFETY: as in `format`
    let out =
        unsafe { take_result(dashql_oracle_format_node(text.as_ptr() as *const c_char, text.len(), node_id, config))? };
    read_output(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        let config = FormattingConfig { mode: 1, max_width: 120, indentation_width: 2, ..Default::default() };
        let out = format("SELECT 1 FROM t", &config).unwrap();
        assert_eq!(out, Formatted { unformattable_nodes: vec![], text: "select 1 from t;".into() });
    }
}
