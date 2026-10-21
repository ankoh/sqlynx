//! Batch processing, a port of `src/batch.cc`: scan, parse and analyze many scripts against shared
//! descriptor context in one call.

use crate::catalog::Catalog;
use crate::error::{Error, Result};
use crate::pack::{pack_analyzed_script, pack_catalog_descriptor, pack_parsed_script, pack_scanned_script, pack_visualization};
use crate::script::Script;
use dashql_buffers::analyzer::AnalyzerErrorSeverity;
use dashql_buffers::batch::{BatchDiagnosticT, BatchRequest, BatchResultT, BatchScriptResultT};
pub use dashql_buffers::batch::{DiagnosticSeverity, ProcessingStage};
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

/// A diagnostic of a checked script
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    /// The processing stage that reported the diagnostic
    pub stage: ProcessingStage,
    /// Whether the diagnostic is an error or a warning
    pub severity: DiagnosticSeverity,
    /// The UTF-8 byte span in the script text
    pub span: TextSpan,
    /// The diagnostic message
    pub message: String,
}

/// A script processed by [`check_script`]
pub struct CheckedScript {
    /// The processed script, not published to the catalog
    pub script: Script,
    /// The diagnostics of all stages that ran, in stage order
    pub diagnostics: Vec<Diagnostic>,
    /// Why the analysis failed, the diagnostics of the earlier stages are kept
    pub failure: Option<String>,
}

impl CheckedScript {
    /// Whether processing failed or found an error
    pub fn has_errors(&self) -> bool {
        self.failure.is_some() || self.diagnostics.iter().any(|d| d.severity == DiagnosticSeverity::ERROR)
    }
}

/// Scan, parse and analyze a script against a catalog up to `until`, collecting the diagnostics of every
/// stage. The script is not published to the catalog.
pub fn check_script(catalog: &Catalog, text: &str, until: ProcessingStage) -> CheckedScript {
    let mut diagnostics = Vec::new();
    let mut diagnostic = |stage, severity, span, message: &str| {
        diagnostics.push(Diagnostic { stage, severity, span, message: message.to_string() });
    };
    let mut script = Script::new(catalog);
    script.replace_text(text);
    script.scan();
    for e in &script.scanned.as_ref().unwrap().errors {
        diagnostic(ProcessingStage::SCAN, DiagnosticSeverity::ERROR, e.location, &e.message);
    }
    if until >= ProcessingStage::PARSE {
        script.parse();
        let parsed = script.parsed.as_ref().unwrap();
        for e in &parsed.errors {
            let span = resolve_text_span(&parsed.scanned.text, &parsed.scanned.symbols, e.location);
            diagnostic(ProcessingStage::PARSE, DiagnosticSeverity::ERROR, span, &e.message);
        }
    }
    let mut failure = None;
    if until >= ProcessingStage::ANALYZE {
        match script.analyze(catalog, false) {
            Ok(()) => {
                let analyzed = script.analyzed.as_ref().unwrap();
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
                    diagnostic(ProcessingStage::ANALYZE, severity, span, &e.message);
                }
            }
            Err(e) => failure = Some(e.message),
        }
    }
    CheckedScript { script, diagnostics, failure }
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
        let outputs = input.outputs();
        if outputs & !15 != 0 {
            out.failure = Some("invalid batch output mask".into());
        } else if outputs != 0 {
            let until = if outputs & 12 != 0 {
                ProcessingStage::ANALYZE
            } else if outputs & 2 != 0 {
                ProcessingStage::PARSE
            } else {
                ProcessingStage::SCAN
            };
            // The FlatBuffers verifier already rejects requests with invalid UTF-8 texts, which the C++
            // core reports per script
            let checked = check_script(&catalog, input.text().unwrap_or(""), until);
            let script = &checked.script;
            if outputs & 1 != 0 {
                out.scanned = script.scanned.as_deref().map(|s| pack_bytes!(pack_scanned_script(s)));
            }
            if outputs & 2 != 0 {
                out.parsed = script.parsed.as_deref().map(|p| pack_bytes!(pack_parsed_script(p)));
            }
            out.failure = checked.failure.clone();
            if let (None, Some(analyzed)) = (&checked.failure, script.analyzed.as_deref()) {
                if outputs & 4 != 0 {
                    out.analyzed = Some(pack_bytes!(pack_analyzed_script(analyzed, &pack_visualization)));
                }
                if outputs & 8 != 0 && !checked.has_errors() {
                    match pack_catalog_descriptor(&analyzed.entry) {
                        Ok(descriptor) => out.catalog_descriptor = Some(descriptor),
                        Err(e) => out.failure = Some(e.message),
                    }
                }
            }
            let diagnostics = checked.diagnostics.into_iter().map(|d| {
                let mut out = BatchDiagnosticT::default();
                out.stage = d.stage;
                out.severity = d.severity;
                out.offset = d.span.offset;
                out.length = d.span.length;
                out.message = (!d.message.is_empty()).then_some(d.message);
                out
            });
            out.diagnostics = non_empty(diagnostics.collect());
        }
        // The object API leaves out empty vectors
        out.scanned = out.scanned.and_then(non_empty);
        out.parsed = out.parsed.and_then(non_empty);
        out.analyzed = out.analyzed.and_then(non_empty);
        out.catalog_descriptor = out.catalog_descriptor.and_then(non_empty);
        scripts.push(out);
    }
    result.scripts = non_empty(scripts);
    let mut builder = flatbuffers::FlatBufferBuilder::new();
    let packed = result.pack(&mut builder);
    builder.finish(packed, None);
    Ok(builder.finished_data().to_vec())
}
