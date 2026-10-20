//! The wasm-bindgen API of the Rust core, the replacement of the C ABI in
//! `packages/dashql-core/src/api.cc` (see docs/rust-port/README.md, phase 8).
//!
//! Objects own their state; results are FlatBuffers returned as byte arrays, which the TypeScript
//! wrappers in `packages/dashql-core-js/src/api.ts` read with the generated FlatBuffers classes.
//! Errors become exceptions with the status code name or the error message.
//!
//! Scripts share their catalog through a reference-counted handle, so a script can outlive the JS
//! catalog object. Freeing a script removes it from its catalog, like the destructor of the C++
//! `Script`.

use dashql_buffers::formatting::{FormattingConfigT, FormattingDialect, FormattingMode, KeywordCase};
use dashql_core::catalog::Catalog as CoreCatalog;
use dashql_core::completion::Completion;
use dashql_core::error::Error;
use dashql_core::script::Script as CoreScript;
use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::prelude::*;

/// Convert a core error into a JS exception
fn js_error(error: Error) -> JsError {
    JsError::new(&error.message)
}

/// Finish a FlatBuffers object API value into bytes
macro_rules! finish {
    ($value:expr) => {{
        let mut builder = flatbuffers::FlatBufferBuilder::new();
        let packed = $value.pack(&mut builder);
        builder.finish(packed, None);
        builder.finished_data().to_vec()
    }};
}

/// A formatting config from the arguments of the C ABI
fn formatting_config(dialect: u8, mode: u8, max_width: u32, indentation_width: u32, debug_mode: bool, keyword_case: u8) -> FormattingConfigT {
    let mut config = FormattingConfigT::default();
    config.dialect = FormattingDialect(dialect);
    config.mode = FormattingMode(mode);
    config.max_width = max_width;
    config.indentation_width = indentation_width;
    config.debug_mode = debug_mode;
    config.keyword_case = KeywordCase(keyword_case);
    config
}

/// The shared handle of a catalog
type SharedCatalog = Rc<RefCell<CoreCatalog>>;

/// A catalog (`dashql_catalog_*`)
#[wasm_bindgen]
pub struct Catalog {
    inner: SharedCatalog,
}

#[wasm_bindgen]
impl Catalog {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Catalog {
        Catalog {
            inner: Rc::new(RefCell::new(CoreCatalog::new())),
        }
    }

    pub fn clear(&self) {
        self.inner.borrow_mut().clear();
    }

    #[wasm_bindgen(js_name = allocateEntryId)]
    pub fn allocate_entry_id(&self) -> u32 {
        self.inner.borrow().allocate_entry_id()
    }

    #[wasm_bindgen(js_name = replaceDescriptor)]
    pub fn replace_descriptor(&self, id: u32, rank: u32, descriptor: &[u8]) -> Result<(), JsError> {
        self.inner.borrow_mut().replace_descriptor(id, rank, descriptor).map_err(js_error)
    }

    #[wasm_bindgen(js_name = dropDescriptor)]
    pub fn drop_descriptor(&self, id: u32) -> Result<(), JsError> {
        self.inner.borrow_mut().drop_descriptor(id).map_err(js_error)
    }

    #[wasm_bindgen(js_name = containsEntryId)]
    pub fn contains_entry_id(&self, id: u32) -> bool {
        self.inner.borrow().contains(id)
    }

    /// The `CatalogEntries` of all entries in rank order
    #[wasm_bindgen(js_name = describeEntries)]
    pub fn describe_entries(&self) -> Vec<u8> {
        finish!(self.inner.borrow().describe_entries())
    }

    /// The `CatalogEntries` of one entry, empty if the entry is unknown
    #[wasm_bindgen(js_name = describeEntriesOf)]
    pub fn describe_entries_of(&self, id: u32) -> Option<Vec<u8>> {
        self.inner.borrow().describe_entries_of(id).map(|e| finish!(e))
    }

    /// The `FlatCatalog`
    pub fn flatten(&self) -> Vec<u8> {
        finish!(self.inner.borrow().flatten())
    }

    /// The `CatalogStatistics`
    pub fn statistics(&self) -> Vec<u8> {
        finish!(self.inner.borrow().statistics())
    }

    /// Load the analysis of a script
    #[wasm_bindgen(js_name = loadScript)]
    pub fn load_script(&self, script: &Script, rank: u32) -> Result<(), JsError> {
        let analyzed = script.inner.analyzed.clone().ok_or_else(|| js_error(Error::status(dashql_buffers::status::StatusCode::CATALOG_SCRIPT_NOT_ANALYZED)))?;
        self.inner.borrow_mut().load_script(analyzed, rank).map_err(js_error)
    }

    /// Load the analyses of several scripts atomically
    #[wasm_bindgen(js_name = loadScripts)]
    pub fn load_scripts(&self, batch: &ScriptBatch) -> Result<(), JsError> {
        self.inner.borrow_mut().load_scripts(&batch.scripts).map_err(js_error)
    }

    /// Drop a script from the catalog
    #[wasm_bindgen(js_name = dropScript)]
    pub fn drop_script(&self, script: &Script) {
        self.inner.borrow_mut().drop_script(script.inner.catalog_entry_id());
    }
}

impl Default for Catalog {
    fn default() -> Self {
        Self::new()
    }
}

/// A batch of analyzed scripts for `Catalog::loadScripts`
#[wasm_bindgen]
pub struct ScriptBatch {
    scripts: Vec<(std::sync::Arc<dashql_core::analyzer::AnalyzedScript>, u32)>,
}

#[wasm_bindgen]
impl ScriptBatch {
    #[wasm_bindgen(constructor)]
    pub fn new() -> ScriptBatch {
        ScriptBatch { scripts: Vec::new() }
    }

    /// Add the analysis of a script
    pub fn add(&mut self, script: &Script, rank: u32) -> Result<(), JsError> {
        let analyzed = script
            .inner
            .analyzed
            .clone()
            .ok_or_else(|| js_error(Error::status(dashql_buffers::status::StatusCode::CATALOG_SCRIPT_NOT_ANALYZED)))?;
        self.scripts.push((analyzed, rank));
        Ok(())
    }
}

impl Default for ScriptBatch {
    fn default() -> Self {
        Self::new()
    }
}

/// A script (`dashql_script_*`)
#[wasm_bindgen]
pub struct Script {
    catalog: SharedCatalog,
    inner: CoreScript,
}

impl Drop for Script {
    fn drop(&mut self) {
        // Like the C++ destructor, a freed script leaves the catalog
        if let Ok(mut catalog) = self.catalog.try_borrow_mut() {
            catalog.drop_script(self.inner.catalog_entry_id());
        }
    }
}

#[wasm_bindgen]
impl Script {
    #[wasm_bindgen(constructor)]
    pub fn new(catalog: &Catalog) -> Script {
        let inner = CoreScript::new(&catalog.inner.borrow());
        Script {
            catalog: catalog.inner.clone(),
            inner,
        }
    }

    #[wasm_bindgen(js_name = catalogEntryId)]
    pub fn catalog_entry_id(&self) -> u32 {
        self.inner.catalog_entry_id()
    }

    /// Insert text at a code point offset
    #[wasm_bindgen(js_name = insertTextAt)]
    pub fn insert_text_at(&mut self, offset: usize, text: &str) {
        self.inner.insert_text_at(offset, text);
    }

    /// Insert a code point at a code point offset
    #[wasm_bindgen(js_name = insertCharAt)]
    pub fn insert_char_at(&mut self, offset: usize, unicode: u32) {
        self.inner.insert_char_at(offset, unicode);
    }

    /// Erase a code point range
    #[wasm_bindgen(js_name = eraseTextRange)]
    pub fn erase_text_range(&mut self, offset: usize, count: usize) {
        self.inner.erase_text_range(offset, count);
    }

    #[wasm_bindgen(js_name = replaceText)]
    pub fn replace_text(&mut self, text: &str) {
        self.inner.replace_text(text);
    }

    /// The text, or a byte range of it
    #[wasm_bindgen(js_name = toString)]
    pub fn to_text(&self, offset: Option<u32>, length: Option<u32>) -> String {
        match (offset, length) {
            (Some(offset), Some(length)) => self.inner.to_text_span(dashql_grammar::span::TextSpan::new(offset, length)),
            _ => self.inner.to_text(),
        }
    }

    pub fn scan(&mut self) {
        self.inner.scan();
    }

    pub fn parse(&mut self) {
        self.inner.parse();
    }

    pub fn analyze(&mut self, parse_if_outdated: bool) -> Result<(), JsError> {
        let catalog = self.catalog.borrow();
        self.inner.analyze(&catalog, parse_if_outdated).map_err(js_error)
    }

    /// The packed `ScannedScript`
    #[wasm_bindgen(js_name = getScanned)]
    pub fn get_scanned(&self) -> Result<Vec<u8>, JsError> {
        let scanned = self.inner.scanned.as_ref().ok_or_else(|| js_error(Error::status(dashql_buffers::status::StatusCode::SCRIPT_NOT_ANALYZED)))?;
        Ok(finish!(dashql_core::pack::pack_scanned_script(scanned)))
    }

    /// The packed `ParsedScript`
    #[wasm_bindgen(js_name = getParsed)]
    pub fn get_parsed(&self) -> Result<Vec<u8>, JsError> {
        let parsed = self.inner.parsed.as_ref().ok_or_else(|| js_error(Error::status(dashql_buffers::status::StatusCode::SCRIPT_NOT_ANALYZED)))?;
        Ok(finish!(dashql_core::pack::pack_parsed_script(parsed)))
    }

    /// The packed `AnalyzedScript`
    #[wasm_bindgen(js_name = getAnalyzed)]
    pub fn get_analyzed(&self) -> Result<Vec<u8>, JsError> {
        let analyzed = self.inner.analyzed.as_ref().ok_or_else(|| js_error(Error::status(dashql_buffers::status::StatusCode::SCRIPT_NOT_ANALYZED)))?;
        Ok(finish!(dashql_core::pack::pack_analyzed_script(analyzed, &dashql_core::pack::pack_visualization)))
    }

    /// The packed `ScriptDiff` from this script to a target script
    #[wasm_bindgen(js_name = computeDiff)]
    pub fn compute_diff(&self, target: &Script) -> Result<Vec<u8>, JsError> {
        let (Some(source), Some(target)) = (&self.inner.parsed, &target.inner.parsed) else {
            return Err(js_error(Error::status(dashql_buffers::status::StatusCode::SCRIPT_NOT_PARSED)));
        };
        let mut diff = dashql_core::script_diff::ScriptDiff::new(source, target);
        Ok(finish!(diff.pack()))
    }

    /// Move the cursor, returns the packed `ScriptCursor`
    #[wasm_bindgen(js_name = moveCursor)]
    pub fn move_cursor(&mut self, offset: usize) -> Vec<u8> {
        let catalog = self.catalog.borrow();
        let cursor = self.inner.move_cursor(&catalog, offset);
        finish!(dashql_core::pack::pack_cursor(&cursor))
    }

    /// Complete at the cursor, returns the packed `Completion`
    #[wasm_bindgen(js_name = completeAtCursor)]
    pub fn complete_at_cursor(&self, limit: usize, keyword_case: u8) -> Result<Vec<u8>, JsError> {
        let catalog = self.catalog.borrow();
        let cursor = self
            .inner
            .cursor(&catalog)
            .ok_or_else(|| js_error(Error::status(dashql_buffers::status::StatusCode::COMPLETION_MISSES_CURSOR)))?;
        if cursor.scanner_location.is_none() {
            return Err(js_error(Error::status(dashql_buffers::status::StatusCode::COMPLETION_MISSES_SCANNER_TOKEN)));
        }
        let completion = Completion::compute(&cursor, limit);
        Ok(finish!(dashql_core::pack::pack_completion(&completion, KeywordCase(keyword_case) == KeywordCase::UPPER)))
    }

    /// Compile the script into the packed `ScriptCompilationResult`
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = compileQuery)]
    pub fn compile_query(
        &mut self,
        dialect: u8,
        mode: u8,
        max_width: u32,
        indentation_width: u32,
        allow_extensions: bool,
        parse_if_outdated: bool,
    ) -> Vec<u8> {
        let config = formatting_config(dialect, mode, max_width, indentation_width, false, 0);
        let options = dashql_core::compiler::CompilationOptions {
            allow_extensions,
            parse_if_outdated,
        };
        let catalog = self.catalog.borrow();
        finish!(dashql_core::compiler::compile(&mut self.inner, &catalog, &config, options))
    }

    /// The signature of the parsed script
    #[wasm_bindgen(js_name = computeSignature)]
    pub fn compute_signature(&mut self, parse_if_outdated: bool) -> Result<String, JsError> {
        self.inner.compute_signature(parse_if_outdated).map_err(js_error)
    }
}

/// Process a batch request into a `BatchResult`
#[wasm_bindgen(js_name = processBatch)]
pub fn process_batch(request: &[u8]) -> Result<Vec<u8>, JsError> {
    dashql_core::batch::process_batch(request).map_err(js_error)
}

/// Parse a Vega-Lite spec into a DashQL VISUALIZE spec
#[wasm_bindgen(js_name = parseVegaLiteToVisualize)]
pub fn parse_vegalite_to_visualize(json: &[u8]) -> Vec<u8> {
    dashql_core::visualize::parse_vegalite_to_visualize_bytes(json)
}

/// A plan view model (`dashql_plan_view_model_*`)
#[wasm_bindgen]
pub struct PlanViewModel {
    inner: dashql_core::view::PlanViewModel,
}

#[wasm_bindgen]
impl PlanViewModel {
    #[wasm_bindgen(constructor)]
    pub fn new() -> PlanViewModel {
        PlanViewModel {
            inner: dashql_core::view::PlanViewModel::new(),
        }
    }

    /// Configure the layout with a packed `PlanLayoutConfig`
    #[allow(clippy::too_many_arguments)]
    pub fn configure(
        &mut self,
        level_height: f64,
        node_height: f64,
        node_margin_horizontal: f64,
        node_padding_left: f64,
        node_padding_right: f64,
        icon_width: f64,
        icon_margin_right: f64,
        max_label_chars: u32,
        width_per_label_char: f64,
        node_min_width: f64,
    ) {
        let config = dashql_buffers::view::PlanLayoutConfig::new(
            level_height,
            node_height,
            node_margin_horizontal,
            node_padding_left,
            node_padding_right,
            icon_width,
            icon_margin_right,
            max_label_chars,
            width_per_label_char,
            node_min_width,
        );
        self.inner.configure(&config);
    }

    /// Load a Hyper plan and compute the layout. Like the C ABI, a plan that fails to parse leaves
    /// the view model in its partially parsed state without an error.
    #[wasm_bindgen(js_name = loadHyperPlan)]
    pub fn load_hyper_plan(&mut self, plan: &[u8]) {
        let _ = self.inner.parse_hyper_plan(plan);
        self.inner.compute_layout();
    }

    pub fn reset(&mut self) {
        self.inner.reset();
    }

    #[wasm_bindgen(js_name = resetExecution)]
    pub fn reset_execution(&mut self) {
        self.inner.reset_execution();
    }

    /// The packed `PlanViewModel`
    pub fn pack(&self) -> Vec<u8> {
        self.inner.pack_buffer()
    }
}

impl Default for PlanViewModel {
    fn default() -> Self {
        Self::new()
    }
}
