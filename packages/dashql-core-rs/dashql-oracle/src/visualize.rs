//! Oracle functions for the visualization port (`tools/oracle_ffi_visualize.cc`).
//!
//! `visualize` and `compile_markdown` dump their results in a line format, strings are length-prefixed
//! (`<len>:<bytes>`):
//!
//! ```text
//! spec <index> renderer=<string|null> dashboard=<row|null>,<column|null>,<width>,<height>
//! vegalite <string>
//! roundtrip <string>
//! markdown template=<string> fields=<n> <string>...      (or `markdown: null`)
//!   <NODE_TYPE> value=<s> url=<s> title=<s> language=<s> level=<n> start=<n> ordered=<0|1> tight=<0|1>
//! umap vector=<s> category=<s> label=<s> method=<n> metric=<s> neighbors=<%.17g|null> min_dist=<%.17g|null>
//! ```
//!
//! Markdown nodes are indented by two spaces per depth, the document is at depth 1.

use crate::{dashql_oracle_free, take_result, OracleResult};
use std::os::raw::c_char;

extern "C" {
    fn dashql_oracle_visualize(
        catalog_text: *const c_char,
        catalog_length: usize,
        text: *const c_char,
        length: usize,
    ) -> OracleResult;
    fn dashql_oracle_parse_vegalite(text: *const c_char, length: usize) -> OracleResult;
    fn dashql_oracle_compile_markdown(text: *const c_char, length: usize) -> OracleResult;
}

/// Analyze a script (optionally against a catalog script) and dump all visualization specs
pub fn visualize(catalog: Option<&str>, text: &str) -> Result<String, String> {
    let (catalog_ptr, catalog_len) = match catalog {
        Some(c) => (c.as_ptr() as *const c_char, c.len()),
        None => (std::ptr::null(), 0),
    };
    // SAFETY: the oracle reads `length` bytes of the texts and returns an unreleased result.
    unsafe {
        take_result(dashql_oracle_visualize(catalog_ptr, catalog_len, text.as_ptr() as *const c_char, text.len()))
    }
}

/// `ParseVegaLiteToVisualize` of a JSON text, as raw bytes
pub fn parse_vegalite(json: &[u8]) -> Result<Vec<u8>, String> {
    // SAFETY: the oracle reads `length` bytes of the text and returns an unreleased result, which is released here.
    unsafe {
        let result = dashql_oracle_parse_vegalite(json.as_ptr() as *const c_char, json.len());
        let bytes = std::slice::from_raw_parts(result.data as *const u8, result.length).to_vec();
        let status = result.status;
        dashql_oracle_free(result);
        if status == 0 {
            Ok(bytes)
        } else {
            Err(String::from_utf8_lossy(&bytes).into_owned())
        }
    }
}

/// `CompileMarkdownSpec` of a row template, dumped
pub fn compile_markdown(template: &str) -> Result<String, String> {
    crate::call(dashql_oracle_compile_markdown, template)
}
