//! The analyzer, a port of `packages/dashql-core/src/analyzer/`.
//!
//! The analysis runs four left-to-right passes over the post-order AST, interleaved per morsel of
//! 1024 nodes like the C++ `PassManager`, so expressions get the same ids:
//! name resolution, function calls, constant propagation and visualizations.
//!
//! Unlike the C++ analyzer, the scanned script is not modified. The analyzed script owns a copy of
//! the names with the analyzer tags and the objects they resolve to.

mod constants;
mod function_calls;
mod name_resolution;
mod state;
pub mod types;
mod visualization;

pub use types::*;
pub(crate) use visualization::strtod_full;

use crate::catalog::*;
use crate::error::Result;
use dashql_buffers::analyzer::{AnalyzerErrorSeverity, AnalyzerErrorType, NameTag, SemanticNodeMarkerType};
use dashql_grammar::names::{NameId, NameRegistry};
use dashql_grammar::parser::ParsedScript;
use crate::hash::HashMap;
use std::fmt;
use std::sync::Arc;

/// An analyzed script
pub struct AnalyzedScript {
    /// The parsed script
    pub parsed: Arc<ParsedScript>,
    /// The catalog declarations of the script
    pub entry: CatalogEntryData,
    /// The names of the scanned script, plus the empty name registered by the analyzer
    pub names: NameRegistry,
    /// The analyzer tags of the names
    pub name_tags: Vec<NameTag>,
    /// The objects of this script that names of this or other entries resolve to, in registration order
    /// (`RegisteredName::resolved_objects`)
    pub name_objects: Vec<(CatalogEntryId, NameId, CatalogObjectRef)>,
    /// The empty name
    pub empty_name: NameId,
    /// The analyzer errors
    pub errors: Vec<AnalyzerError>,
    /// The semantic node markers
    pub node_markers: Vec<SemanticNodeMarkerType>,
    /// The table references
    pub table_references: Vec<TableReference>,
    /// The INSERT statements
    pub insert_statements: Vec<InsertStatement>,
    /// The expressions
    pub expressions: Vec<Expression>,
    /// The function arguments, referenced by function calls
    pub function_arguments: Vec<FunctionArgument>,
    /// The name scopes
    pub name_scopes: Vec<NameScope>,
    /// The name scopes by scope root
    pub name_scopes_by_root_node: HashMap<u32, ScopeId>,
    /// The constant expression roots
    pub constant_expressions: Vec<ConstantExpression>,
    /// The visualization specs
    pub visualization_specs: Vec<VisualizationSpec>,
    /// The schema-inference constraints
    pub inference_constraints: Vec<InferenceConstraint>,
    /// The inferred schemas of tables that are not in the catalog
    pub inferred_table_schemas: Vec<InferredTableSchema>,
    /// The inferred schemas by (database, schema, table)
    pub inferred_table_schemas_by_name: HashMap<QualifiedKey, usize>,
    /// The catalog entries the script was analyzed against
    pub dependencies: Vec<CatalogEntryRef>,
    /// The name search index, built on first use
    pub(crate) name_search_index: std::sync::OnceLock<NameSearchIndex>,
}

impl fmt::Debug for AnalyzedScript {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AnalyzedScript")
            .field("catalog_entry_id", &self.entry.catalog_entry_id)
            .field("errors", &self.errors.len())
            .field("expressions", &self.expressions.len())
            .finish_non_exhaustive()
    }
}

impl AnalyzedScript {
    pub fn catalog_entry_id(&self) -> CatalogEntryId {
        self.entry.catalog_entry_id
    }

    /// The text of a name of this script
    pub fn name_text(&self, id: NameId) -> &str {
        &self.names.get(id).text
    }

    /// The name search index (`AnalyzedScript::GetNameSearchIndex`)
    pub fn name_search_index(&self) -> &NameSearchIndex {
        self.name_search_index.get_or_init(|| {
            let entry_id = self.entry.catalog_entry_id;
            let mut names: Vec<IndexedName> = self
                .names
                .iter()
                .map(|n| IndexedName {
                    text: Arc::from(n.text.as_str()),
                    occurrences: n.occurrences,
                    location: n.location,
                    tags: self.name_tags[n.name_id as usize],
                    objects: Vec::new(),
                })
                .collect();
            for &(entry, name, object) in &self.name_objects {
                if entry == entry_id {
                    names[name as usize].objects.push(object);
                }
            }
            NameSearchIndex::new(names, crate::catalog::names::SuffixOrder::ShortestFirst)
        })
    }

    /// A table declared by this script or by a dependency
    pub fn table(&self, loc: TableLoc) -> Option<&TableDeclaration> {
        if loc.entry == self.entry.catalog_entry_id {
            return self.entry.table_declarations.get(loc.index as usize);
        }
        self.dependencies
            .iter()
            .find(|d| d.data().catalog_entry_id == loc.entry)
            .and_then(|d| d.data().table_declarations.get(loc.index as usize))
    }
}

/// Analyze a parsed script against a catalog (`Analyzer::Analyze`)
pub fn analyze(parsed: Arc<ParsedScript>, catalog: &Catalog) -> Result<AnalyzedScript> {
    let mut state = state::AnalysisState::new(&parsed, catalog);
    let mut name_resolution = name_resolution::NameResolutionPass::new(&state);
    let mut constants = constants::ConstantPropagationPass::default();
    let mut visualization = visualization::AnalyzeVisualizationPass::new(&state);

    // Scan all nodes in morsels, interleaving the passes
    const MORSEL_SIZE: usize = 1024;
    let node_count = state.ast.len();
    let mut begin = 0;
    while begin != node_count {
        let end = (begin + MORSEL_SIZE).min(node_count);
        name_resolution.visit(&mut state, begin..end);
        function_calls::visit(&mut state, begin..end)?;
        constants.visit(&mut state, begin..end);
        visualization.visit(&mut state, begin..end);
        begin = end;
    }
    name_resolution.finish(&mut state);
    constants.finish(&mut state);
    visualization.finish(&mut state);

    let mut out = state.into_script();
    // Malformed comment tags fall back to ordinary comments, warn so that they don't go unnoticed
    for (span, message) in &parsed.comment_blocks.warnings {
        out.errors.push(AnalyzerError {
            error_type: AnalyzerErrorType::MALFORMED_COMMENT_TAG,
            severity: AnalyzerErrorSeverity::WARNING,
            ast_node_id: PROTO_NULL_U32,
            symbol_span: None,
            text_span: Some(*span),
            message: message.clone(),
        });
    }
    Ok(out)
}
