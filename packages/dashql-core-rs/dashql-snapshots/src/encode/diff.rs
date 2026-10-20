//! A port of `DiffSnapshotTest::EncodeDiff` (`src/testing/diff_snapshot_test.cc`).

use super::{encode_location_text, Map};
use crate::ryml::Node;
use dashql_buffers::diff::ScriptDiffOpCode;
use dashql_core::script_diff::DiffOp;

/// Encode the operations of a script diff
pub fn encode_diff(ops: &[DiffOp], source_text: &str, target_text: &str) -> Node {
    let items = ops
        .iter()
        .map(|op| {
            let mut m = Map::new();
            m.plain("code", op.code.variant_name().unwrap_or(""));
            if let Some(s) = op.source_statement {
                m.int("source-statement", s as i64);
            }
            if let Some(t) = op.target_statement {
                m.int("target-statement", t as i64);
            }
            match op.code {
                ScriptDiffOpCode::UPDATE => {
                    let changes = op
                        .target_changes
                        .iter()
                        .map(|c| {
                            let mut cm = Map::new();
                            encode_location_text(&mut cm, target_text, c.offset, c.length, "text");
                            cm.into_node()
                        })
                        .collect();
                    m.insert("target-changes", Node::seq(changes));
                }
                ScriptDiffOpCode::DELETE => encode_location_text(
                    &mut m,
                    source_text,
                    op.source_span.offset,
                    op.source_span.length,
                    "source-span",
                ),
                _ => encode_location_text(
                    &mut m,
                    target_text,
                    op.target_span.offset,
                    op.target_span.length,
                    "target-span",
                ),
            }
            m.into_node()
        })
        .collect();
    let mut root = Map::new();
    root.insert("ops", Node::seq(items));
    root.into_node()
}
