//! The DashQL core, the Rust rewrite of `packages/dashql-core` (see docs/rust-port/README.md).
//!
//! Builds on `dashql_grammar` (scanner and parser) and the FlatBuffers bindings `dashql_buffers`.

pub mod analyzer;
pub mod catalog;
pub mod error;
pub mod formatter;
pub mod script_diff;
pub mod view;
