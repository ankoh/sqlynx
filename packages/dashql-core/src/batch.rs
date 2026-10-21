//! Batch processing, a port of `src/batch.cc`: scan, parse and analyze many scripts against shared
//! descriptor context in one call.

use crate::catalog::Catalog;
use crate::error::{Error, Result};
use crate::pack::{pack_analyzed_script, pack_catalog_descriptor, pack_parsed_script, pack_scanned_script, pack_visualization};
use crate::script::Script;
use dashql_buffers::analyzer::AnalyzerErrorSeverity;
use dashql_buffers::batch::{
    BatchDiagnosticT, BatchRequest, BatchResultT, BatchScriptResultT, DiagnosticSeverity, ProcessingStage,
};
use dashql_parser::parser::context::resolve_text_span;
use dashql_parser::span::TextSpan;

/// Pack an object API value into FlatBuffer bytes
macro_rules! pack_bytes {
    ($value:expr) => {{
        let mut builder = flatbuffers::FlatBufferBuilder::new();
        let packed = $value.pack(&mut builder);
        builder.finish(packed, None);
        builder.finished_data().to_vec()
    }};
}

/// A vector the C++ object API leaves out when empty
fn non_empty<T>(v: Vec<T>) -> Option<Vec<T>> {
    (!v.is_empty()).then_some(v)
}

/// Process a batch request (`ProcessBatch`). Inputs share only the descriptor context, they never
/// publish declarations to each other.
pub fn process_batch(request: &[u8]) -> Result<Vec<u8>> {
    let request = if request.is_empty() { None } else { flatbuffers::root::<BatchRequest>(request).ok() };
    let request = request.ok_or_else(|| Error::invalid_argument("invalid BatchRequest FlatBuffer"))?;
    let mut catalog = Catalog::new();
    if let Some(descriptors) = request.catalog_descriptors() {
        for (rank, descriptor) in descriptors.iter().enumerate() {
            let data = descriptor.data().ok_or_else(|| Error::invalid_argument("missing batch catalog descriptor bytes"))?;
            let id = catalog.allocate_entry_id();
            catalog.replace_descriptor(id, rank as u32, data.bytes())?;
        }
    }

    let mut result = BatchResultT::default();
    let mut scripts = Vec::new();
    for input in request.scripts().into_iter().flatten() {
        let mut out = BatchScriptResultT::default();
        out.id = input.id().filter(|id| !id.is_empty()).map(str::to_string);
        let mut diagnostics: Vec<BatchDiagnosticT> = Vec::new();
        let diagnostic = |diagnostics: &mut Vec<BatchDiagnosticT>, stage, severity, span: TextSpan, message: &str| {
            let mut d = BatchDiagnosticT::default();
            d.stage = stage;
            d.severity = severity;
            d.offset = span.offset;
            d.length = span.length;
            d.message = (!message.is_empty()).then(|| message.to_string());
            diagnostics.push(d);
        };
        let process = |out: &mut BatchScriptResultT, diagnostics: &mut Vec<BatchDiagnosticT>| -> std::result::Result<(), String> {
            let outputs = input.outputs();
            if outputs & !15 != 0 {
                return Err("invalid batch output mask".into());
            }
            // The FlatBuffers verifier already rejects requests with invalid UTF-8 texts, which the C++
            // core reports per script
            let text = input.text().unwrap_or("");
            if outputs == 0 {
                return Ok(());
            }
            let mut script = Script::new(&catalog);
            script.replace_text(text);
            script.scan();
            let scanned = script.scanned.clone().unwrap();
            for e in &scanned.errors {
                diagnostic(diagnostics, ProcessingStage::SCAN, DiagnosticSeverity::ERROR, e.location, &e.message);
            }
            if outputs & 1 != 0 {
                out.scanned = Some(pack_bytes!(pack_scanned_script(&scanned)));
            }
            if outputs & 14 != 0 {
                script.parse();
                let parsed = script.parsed.clone().unwrap();
                for e in &parsed.errors {
                    let span = resolve_text_span(&parsed.scanned.text, &parsed.scanned.symbols, e.location);
                    diagnostic(diagnostics, ProcessingStage::PARSE, DiagnosticSeverity::ERROR, span, &e.message);
                }
                if outputs & 2 != 0 {
                    out.parsed = Some(pack_bytes!(pack_parsed_script(&parsed)));
                }
            }
            if outputs & 12 != 0 {
                script.analyze(&catalog, false).map_err(|e| e.message)?;
                let analyzed = script.analyzed.clone().unwrap();
                let scanned = &analyzed.parsed.scanned;
                for e in &analyzed.errors {
                    let severity = if e.severity == AnalyzerErrorSeverity::WARNING {
                        DiagnosticSeverity::WARNING
                    } else {
                        DiagnosticSeverity::ERROR
                    };
                    let span = match (e.text_span, e.symbol_span) {
                        (Some(t), _) => t,
                        (None, Some(s)) => resolve_text_span(&scanned.text, &scanned.symbols, s),
                        (None, None) => TextSpan::default(),
                    };
                    diagnostic(diagnostics, ProcessingStage::ANALYZE, severity, span, &e.message);
                }
                if outputs & 4 != 0 {
                    out.analyzed = Some(pack_bytes!(pack_analyzed_script(&analyzed, &pack_visualization)));
                }
                let erroneous = diagnostics.iter().any(|d| d.severity == DiagnosticSeverity::ERROR);
                if outputs & 8 != 0 && !erroneous {
                    out.catalog_descriptor = Some(pack_catalog_descriptor(&analyzed.entry).map_err(|e| e.message)?);
                }
            }
            Ok(())
        };
        if let Err(failure) = process(&mut out, &mut diagnostics) {
            out.failure = Some(failure);
        }
        // The object API leaves out empty vectors
        out.scanned = out.scanned.and_then(non_empty);
        out.parsed = out.parsed.and_then(non_empty);
        out.analyzed = out.analyzed.and_then(non_empty);
        out.catalog_descriptor = out.catalog_descriptor.and_then(non_empty);
        out.diagnostics = non_empty(diagnostics);
        scripts.push(out);
    }
    result.scripts = non_empty(scripts);
    let mut builder = flatbuffers::FlatBufferBuilder::new();
    let packed = result.pack(&mut builder);
    builder.finish(packed, None);
    Ok(builder.finished_data().to_vec())
}
