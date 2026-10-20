//! Script signatures (`Script::ComputeSignature` in `src/script.cc`), the persisted cache keys of
//! compiled queries.
//!
//! The signature hashes the statement types and, per statement, the node types, attribute keys,
//! names and literal texts in node order. It must stay identical to the C++ value, bump
//! `SCRIPT_SIGNATURE_VERSION` on both sides when the encoding changes.

use crate::error::{Error, Result};
use dashql_buffers::parser::{AttributeKey, Node, NodeType, StatementType};
use dashql_buffers::status::StatusCode;
use dashql_grammar::attrs;
use dashql_grammar::parser::context::resolve_text_span;
use dashql_grammar::parser::ParsedScript;

/// The version of the signature encoding
const SCRIPT_SIGNATURE_VERSION: u8 = 1;

fn is_enum_node(node_type: NodeType) -> bool {
    let id = node_type.0;
    (id > NodeType::ENUM_KEYS_.0 && id < NodeType::OBJECT_KEYS_.0)
        || (id >= NodeType::ENUM_VIS_ENCODING_CHANNEL.0 && id <= NodeType::ENUM_VIS_SCALE_TYPE.0)
}

fn append_text(out: &mut Vec<u8>, text: &[u8]) {
    out.extend_from_slice(&(text.len() as u64).to_le_bytes());
    out.extend_from_slice(text);
}

fn append_node(parsed: &ParsedScript, node: &Node, out: &mut Vec<u8>, normalize_attribute: bool) {
    let node_type = node.node_type();
    out.extend_from_slice(&node_type.0.to_le_bytes());
    let key = if normalize_attribute { 0 } else { node.attribute_key().0 };
    out.extend_from_slice(&key.to_le_bytes());
    match node_type {
        NodeType::NONE | NodeType::LITERAL_NULL => {}
        NodeType::BOOL => out.push((node.children_begin_or_value() != 0) as u8),
        NodeType::NAME => append_text(out, parsed.scanned.names.get(node.children_begin_or_value()).text.as_bytes()),
        NodeType::OPERATOR
        | NodeType::LITERAL_INTEGER
        | NodeType::LITERAL_FLOAT
        | NodeType::LITERAL_STRING
        | NodeType::LITERAL_INTERVAL => {
            let scanned = &parsed.scanned;
            let span = resolve_text_span(&scanned.text, &scanned.symbols, *node.symbol_span());
            let bytes = scanned.text.as_bytes();
            let begin = (span.offset as usize).min(bytes.len());
            let end = (begin + span.length as usize).min(bytes.len());
            append_text(out, &bytes[begin..end]);
        }
        NodeType::ARRAY => out.extend_from_slice(&(node.children_count()).to_le_bytes()),
        _ if is_enum_node(node_type) => out.extend_from_slice(&node.children_begin_or_value().to_le_bytes()),
        _ => out.extend_from_slice(&(node.children_count()).to_le_bytes()),
    }
}

/// Two FNV-1a style 64 bit hashes over the bytes
fn hash(bytes: &[u8]) -> [u64; 2] {
    let mut digest = [14695981039346656037u64, 7809847782465536322u64];
    for &b in bytes {
        digest[0] = (digest[0] ^ b as u64).wrapping_mul(1099511628211);
        digest[1] = (digest[1] ^ b.wrapping_add(0x9d) as u64).wrapping_mul(1099511628211);
    }
    digest
}

/// Compute the signature of a parsed script. Fails for scripts with scanner or parser errors.
pub fn compute_signature(parsed: &ParsedScript) -> Result<String> {
    if !parsed.scanned.errors.is_empty() || !parsed.errors.is_empty() {
        return Err(Error::status(StatusCode::SCRIPT_NOT_PARSED));
    }
    let mut script_bytes = Vec::new();
    script_bytes.extend_from_slice(b"DQLSIG");
    script_bytes.push(SCRIPT_SIGNATURE_VERSION);
    script_bytes.extend_from_slice(&(parsed.statements.len() as u32).to_le_bytes());
    let mut statement_bytes = Vec::new();
    for (i, statement) in parsed.statements.iter().enumerate() {
        let mut statement_type = statement.statement_type;
        // A trailing VISUALIZE statement is signed like its SELECT
        let mut included = None;
        if i + 1 == parsed.statements.len() && statement_type == StatementType::VIS_VISUALISE {
            let wrapper = &parsed.nodes[statement.root as usize];
            let begin = wrapper.children_begin_or_value() as usize;
            let children = &parsed.nodes[begin..begin + wrapper.children_count() as usize];
            let [source] = attrs!(children, [AttributeKey::VIS_VISUALISE_SELECT]);
            let Some(source) = source else {
                return Err(Error::status(StatusCode::SCRIPT_NOT_PARSED));
            };
            let source_id = (source as *const Node as usize - parsed.nodes.as_ptr() as usize) / std::mem::size_of::<Node>();
            included = Some((*source.symbol_span(), source_id));
            statement_type = StatementType::SELECT;
        }
        statement_bytes.clear();
        let begin = statement.nodes_begin as usize;
        for node_id in begin..begin + statement.node_count as usize {
            let node = &parsed.nodes[node_id];
            if let Some((span, _)) = included {
                let s = node.symbol_span();
                let included_end = span.offset().wrapping_add(span.length());
                let node_end = s.offset().wrapping_add(s.length());
                if s.offset() < span.offset() || node_end > included_end {
                    continue;
                }
            }
            let normalize = included.is_some_and(|(_, root)| root == node_id);
            append_node(parsed, node, &mut statement_bytes, normalize);
        }
        let digest = hash(&statement_bytes);
        script_bytes.push(statement_type.0);
        script_bytes.extend_from_slice(&digest[0].to_le_bytes());
        script_bytes.extend_from_slice(&digest[1].to_le_bytes());
    }
    let digest = hash(&script_bytes);
    Ok(format!("{:016x}{:016x}", digest[0], digest[1]))
}
