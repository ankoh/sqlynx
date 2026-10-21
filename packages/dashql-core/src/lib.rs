//! The DashQL core, the Rust rewrite of `packages/dashql-core` (see docs/rust-port/README.md).
//!
//! Builds on `dashql_grammar` (scanner and parser) and the FlatBuffers bindings `dashql_buffers`.

pub mod analyzer;
pub mod batch;
pub mod catalog;
pub mod compiler;
pub mod completion;
pub mod cursor;
pub mod error;
pub mod formatter;
pub mod hash;
pub mod pack;
pub mod planner;
pub mod script;
pub mod script_diff;
pub mod script_execution;
pub mod script_session;
pub mod shell;
pub mod signature;
pub mod utils;
pub mod view;
pub mod visualize;
