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
use dashql_core::script_execution::ScriptExecution as CoreScriptExecution;
use dashql_core::script_session::ScriptSession as CoreScriptSession;
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
type SharedCatalog = dashql_core::script_session::CatalogHandle;

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

impl Script {
    fn format_with(&mut self, catalog: SharedCatalog, config: FormattingConfigT, parse_if_outdated: bool) -> Result<Script, JsError> {
        let text = self.inner.format(&config, parse_if_outdated).map_err(js_error)?;
        let mut inner = CoreScript::new(&catalog.borrow());
        inner.replace_text(&text);
        Ok(Script { catalog, inner })
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

    /// The first parsed statement without its separator or surrounding trivia
    #[wasm_bindgen(js_name = getStatementText)]
    pub fn get_statement_text(&mut self, parse_if_outdated: bool) -> Result<String, JsError> {
        self.inner.statement_text(parse_if_outdated).map_err(js_error)
    }

    /// The packed `ScriptStatistics`
    #[wasm_bindgen(js_name = getStatistics)]
    pub fn get_statistics(&self) -> Vec<u8> {
        finish!(self.inner.statistics())
    }

    /// Rewrite the dashboard clause of the terminal VISUALIZE statement, negative rows and columns
    /// are absent
    #[wasm_bindgen(js_name = rewriteDashboard)]
    pub fn rewrite_dashboard(&mut self, row: i32, column: i32, width: i32, height: i32, parse_if_outdated: bool) -> Result<String, JsError> {
        self.inner
            .rewrite_dashboard((row >= 0).then_some(row), (column >= 0).then_some(column), width, height, parse_if_outdated)
            .map_err(js_error)
    }

    /// Format the script into a new script of the catalog of this script
    #[allow(clippy::too_many_arguments)]
    pub fn format(
        &mut self,
        dialect: u8,
        mode: u8,
        max_width: u32,
        indentation_width: u32,
        debug_mode: bool,
        keyword_case: u8,
        parse_if_outdated: bool,
    ) -> Result<Script, JsError> {
        let catalog = self.catalog.clone();
        self.format_with(catalog, formatting_config(dialect, mode, max_width, indentation_width, debug_mode, keyword_case), parse_if_outdated)
    }

    /// Format the script into a new script of another catalog
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = formatInto)]
    pub fn format_into(
        &mut self,
        dialect: u8,
        mode: u8,
        max_width: u32,
        indentation_width: u32,
        debug_mode: bool,
        keyword_case: u8,
        parse_if_outdated: bool,
        catalog: &Catalog,
    ) -> Result<Script, JsError> {
        let config = formatting_config(dialect, mode, max_width, indentation_width, debug_mode, keyword_case);
        self.format_with(catalog.inner.clone(), config, parse_if_outdated)
    }

    /// The AST node ids that formatting cannot represent
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = getUnformattableNodes)]
    pub fn get_unformattable_nodes(
        &mut self,
        dialect: u8,
        mode: u8,
        max_width: u32,
        indentation_width: u32,
        debug_mode: bool,
        parse_if_outdated: bool,
    ) -> Result<Vec<u32>, JsError> {
        let config = formatting_config(dialect, mode, max_width, indentation_width, debug_mode, 0);
        self.inner.unformattable_nodes(&config, parse_if_outdated).map_err(js_error)
    }

    /// Can formatting represent every node?
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = isFullyFormattable)]
    pub fn is_fully_formattable(
        &mut self,
        dialect: u8,
        mode: u8,
        max_width: u32,
        indentation_width: u32,
        debug_mode: bool,
        parse_if_outdated: bool,
    ) -> Result<bool, JsError> {
        let config = formatting_config(dialect, mode, max_width, indentation_width, debug_mode, 0);
        self.inner.is_fully_formattable(&config, parse_if_outdated).map_err(js_error)
    }
}

/// An editor session (`dashql_script_session_*`). Shared, so that session lists can refer to it.
#[wasm_bindgen]
pub struct ScriptSession {
    inner: Rc<RefCell<CoreScriptSession>>,
}

impl ScriptSession {
    fn format_with(&self, catalog: SharedCatalog, config: FormattingConfigT, parse_if_outdated: bool) -> Result<Script, JsError> {
        let inner = self.inner.borrow_mut().format(&config, parse_if_outdated, Some(&catalog.borrow())).map_err(js_error)?;
        Ok(Script { catalog, inner })
    }
}

#[wasm_bindgen]
impl ScriptSession {
    #[wasm_bindgen(constructor)]
    pub fn new(catalog: &Catalog, offset_unit: u8) -> Result<ScriptSession, JsError> {
        let session = CoreScriptSession::new(catalog.inner.clone(), dashql_buffers::editor::EditorOffsetUnit(offset_unit)).map_err(js_error)?;
        Ok(ScriptSession {
            inner: Rc::new(RefCell::new(session)),
        })
    }

    #[wasm_bindgen(js_name = catalogEntryId)]
    pub fn catalog_entry_id(&self) -> u32 {
        self.inner.borrow().catalog_entry_id()
    }

    pub fn text(&self) -> String {
        self.inner.borrow().text()
    }

    #[wasm_bindgen(js_name = textVersion)]
    pub fn text_version(&self) -> u64 {
        self.inner.borrow().text_version()
    }

    #[wasm_bindgen(js_name = stateRevision)]
    pub fn state_revision(&self) -> u64 {
        self.inner.borrow().state_revision()
    }

    #[wasm_bindgen(js_name = catalogRevision)]
    pub fn catalog_revision(&self) -> u64 {
        self.inner.borrow().catalog_revision()
    }

    /// Replace the text, returns the packed `EditorUpdate`
    #[wasm_bindgen(js_name = replaceText)]
    pub fn replace_text(&self, expected_text_version: u64, text: &str) -> Vec<u8> {
        finish!(self.inner.borrow_mut().replace_text(expected_text_version, text))
    }

    /// Apply a packed `EditorEvent`, returns the packed `EditorUpdate`
    pub fn apply(&self, event: &[u8]) -> Vec<u8> {
        finish!(self.inner.borrow_mut().apply_buffer(event))
    }

    /// Move the primary cursor, returns the packed `EditorUpdate`
    #[wasm_bindgen(js_name = setPrimaryCursor)]
    pub fn set_primary_cursor(&self, expected_text_version: u64, offset: u64) -> Vec<u8> {
        finish!(self.inner.borrow_mut().set_primary_cursor(expected_text_version, offset))
    }

    /// Analyze, returns the packed `EditorUpdate`
    pub fn analyze(&self) -> Vec<u8> {
        finish!(self.inner.borrow_mut().analyze())
    }

    /// Complete at the primary cursor, returns the packed `Completion`
    #[wasm_bindgen(js_name = completeAtCursor)]
    pub fn complete_at_cursor(&self, limit: usize, keyword_case: u8) -> Result<Vec<u8>, JsError> {
        let completion = self.inner.borrow().complete(limit, KeywordCase(keyword_case)).map_err(js_error)?;
        Ok(finish!(completion))
    }

    /// Compile the script, returns the packed `ScriptCompilationResult`
    #[wasm_bindgen(js_name = compileQuery)]
    pub fn compile_query(
        &self,
        dialect: u8,
        mode: u8,
        max_width: u32,
        indentation_width: u32,
        allow_extensions: bool,
        parse_if_outdated: bool,
    ) -> Vec<u8> {
        let config = formatting_config(dialect, mode, max_width, indentation_width, false, 0);
        finish!(self.inner.borrow_mut().compile_query(&config, allow_extensions, parse_if_outdated))
    }

    /// Format the script into a new script of the session catalog
    #[allow(clippy::too_many_arguments)]
    pub fn format(
        &self,
        dialect: u8,
        mode: u8,
        max_width: u32,
        indentation_width: u32,
        debug_mode: bool,
        keyword_case: u8,
        parse_if_outdated: bool,
    ) -> Result<Script, JsError> {
        let catalog = self.inner.borrow().catalog().clone();
        self.format_with(catalog, formatting_config(dialect, mode, max_width, indentation_width, debug_mode, keyword_case), parse_if_outdated)
    }

    /// Format the script into a new script of another catalog
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = formatInto)]
    pub fn format_into(
        &self,
        dialect: u8,
        mode: u8,
        max_width: u32,
        indentation_width: u32,
        debug_mode: bool,
        keyword_case: u8,
        parse_if_outdated: bool,
        catalog: &Catalog,
    ) -> Result<Script, JsError> {
        let config = formatting_config(dialect, mode, max_width, indentation_width, debug_mode, keyword_case);
        self.format_with(catalog.inner.clone(), config, parse_if_outdated)
    }

    /// Rewrite the dashboard clause of the terminal VISUALIZE statement, negative rows and columns
    /// are absent
    #[wasm_bindgen(js_name = rewriteDashboard)]
    pub fn rewrite_dashboard(&self, row: i32, column: i32, width: i32, height: i32, parse_if_outdated: bool) -> Result<String, JsError> {
        self.inner
            .borrow_mut()
            .rewrite_dashboard((row >= 0).then_some(row), (column >= 0).then_some(column), width, height, parse_if_outdated)
            .map_err(js_error)
    }

    /// Can formatting represent every node?
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = isFullyFormattable)]
    pub fn is_fully_formattable(
        &self,
        dialect: u8,
        mode: u8,
        max_width: u32,
        indentation_width: u32,
        debug_mode: bool,
        parse_if_outdated: bool,
    ) -> Result<bool, JsError> {
        let config = formatting_config(dialect, mode, max_width, indentation_width, debug_mode, 0);
        self.inner.borrow_mut().is_fully_formattable(&config, parse_if_outdated).map_err(js_error)
    }

    /// The packed `ScriptDiff` from the session script to a target script
    #[wasm_bindgen(js_name = computeDiff)]
    pub fn compute_diff(&self, target: &Script) -> Result<Vec<u8>, JsError> {
        let diff = self.inner.borrow().diff(&target.inner).map_err(js_error)?;
        Ok(finish!(diff))
    }

    #[wasm_bindgen(js_name = loadIntoCatalog)]
    pub fn load_into_catalog(&self, rank: u32) -> Result<(), JsError> {
        self.inner.borrow_mut().load_into_catalog(rank).map_err(js_error)
    }

    #[wasm_bindgen(js_name = dropFromCatalog)]
    pub fn drop_from_catalog(&self) {
        self.inner.borrow_mut().drop_from_catalog();
    }

    /// Compile the session text into an execution
    #[wasm_bindgen(js_name = startExecution)]
    pub fn start_execution(&self, dialect: u8, mode: u8, max_width: u32, indentation_width: u32, debug_mode: bool) -> ScriptExecution {
        let config = formatting_config(dialect, mode, max_width, indentation_width, debug_mode, 0);
        ScriptExecution {
            inner: CoreScriptExecution::new(&mut self.inner.borrow_mut(), config),
        }
    }
}

/// The execution of a session script (`dashql_script_execution_*`). Updates are packed
/// `ScriptExecutionUpdate`s.
#[wasm_bindgen]
pub struct ScriptExecution {
    inner: CoreScriptExecution,
}

#[wasm_bindgen]
impl ScriptExecution {
    pub fn start(&mut self) -> Vec<u8> {
        finish!(self.inner.start())
    }

    /// Resume with a packed `StatementResult`
    pub fn resume(&mut self, statement_result: &[u8]) -> Result<Vec<u8>, JsError> {
        let result = flatbuffers::root::<dashql_buffers::execution::StatementResult>(statement_result)
            .map_err(|e| JsError::new(&format!("invalid statement result: {e}")))?
            .unpack();
        Ok(finish!(self.inner.resume(&result)))
    }

    pub fn cancel(&mut self) -> Vec<u8> {
        finish!(self.inner.cancel())
    }
}

/// The sessions to plan, in notebook order
#[wasm_bindgen]
pub struct SessionList {
    sessions: Vec<Rc<RefCell<CoreScriptSession>>>,
}

#[wasm_bindgen]
impl SessionList {
    #[wasm_bindgen(constructor)]
    pub fn new() -> SessionList {
        SessionList { sessions: Vec::new() }
    }

    pub fn add(&mut self, session: &ScriptSession) {
        self.sessions.push(session.inner.clone());
    }
}

impl Default for SessionList {
    fn default() -> Self {
        Self::new()
    }
}

/// Plan the current analysis of sessions, returns the packed `ExecutionGraph`
#[wasm_bindgen]
pub fn plan(sessions: &SessionList) -> Vec<u8> {
    let sessions: Vec<_> = sessions.sessions.iter().map(|s| s.borrow()).collect();
    let catalogs: Vec<_> = sessions.iter().map(|s| s.catalog().borrow()).collect();
    let inputs: Vec<_> = sessions
        .iter()
        .zip(&catalogs)
        .map(|(session, catalog)| dashql_core::planner::PlannerInput {
            script: session.script(),
            catalog,
        })
        .collect();
    finish!(dashql_core::planner::plan(&inputs))
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

    /// Load a Hyper plan and compute the layout, throws if the plan cannot be parsed
    #[wasm_bindgen(js_name = loadHyperPlan)]
    pub fn load_hyper_plan(&mut self, plan: &[u8]) -> Result<(), JsError> {
        self.inner.parse_hyper_plan(plan).map_err(|status| js_error(Error::status(status)))?;
        self.inner.compute_layout();
        Ok(())
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
