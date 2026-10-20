//! A port of `AnalyzerSnapshotTest::EncodeScript` (`src/testing/analyzer_snapshot_test.cc`).

use super::{encode_location_text, Map};
use crate::ryml::Node;
use dashql_buffers::algebra::LiteralType;
use dashql_buffers::parser::{Node as AstNode, SymbolSpan};
use dashql_core::analyzer::*;
use dashql_core::catalog::{QualifiedCatalogObjectId, TableDeclaration};
use dashql_grammar::parser::context::resolve_text_span;
use dashql_grammar::span::TextSpan;
use yaml_rust2::Yaml;

struct Encoder<'a> {
    script: &'a AnalyzedScript,
    text: &'a str,
}

impl Encoder<'_> {
    fn resolve(&self, span: SymbolSpan) -> TextSpan {
        let scanned = &self.script.parsed.scanned;
        resolve_text_span(&scanned.text, &scanned.symbols, span)
    }

    fn node(&self, node_id: u32) -> &AstNode {
        &self.script.parsed.nodes[node_id as usize]
    }

    fn location(&self, map: &mut Map, node_id: u32, key: &str) {
        let span = self.resolve(*self.node(node_id).symbol_span());
        encode_location_text(map, self.text, span.offset, span.length, key);
    }
}

/// `db.schema.packed_table_id`
fn table_catalog_id(schema: QualifiedCatalogObjectId, table: QualifiedCatalogObjectId) -> String {
    let (db, schema) = schema.unpack_schema_id();
    format!("{db}.{schema}.{}", table.unpack_table_id().pack())
}

fn encode_tables(e: &Encoder, tables: &[TableDeclaration]) -> Node {
    let items = tables
        .iter()
        .map(|table| {
            let id = table_catalog_id(table.catalog_schema_id, table.object_id);
            let mut m = Map::new();
            m.quoted("catalog-id", &id);
            m.plain("name", &table.table_name.table_name.text);
            e.location(&mut m, table.ast_node_id.unwrap_or(0), "text");
            let columns = table
                .table_columns
                .iter()
                .enumerate()
                .map(|(i, column)| {
                    let mut c = Map::new();
                    c.quoted("catalog-id", &format!("{id}.{i}"));
                    let name = &column.column_name.text;
                    c.plain("name", if name.is_empty() { "?" } else { name });
                    if let Some(node_id) = column.ast_node_id {
                        e.location(&mut c, node_id, "text");
                    }
                    c.into_node()
                })
                .collect();
            m.insert("columns", Node::seq(columns));
            m.into_node()
        })
        .collect();
    Node::seq(items)
}

fn boolean(value: bool) -> Node {
    Node::boolean(value)
}

/// A double as c4 writes it, read back through YAML inference
fn real(value: f64) -> Node {
    super::plain(&format_double(value))
}

/// Format a double as a YAML scalar
pub fn format_double(value: f64) -> String {
    if value.is_nan() {
        ".nan".into()
    } else if value.is_infinite() {
        if value > 0.0 { ".inf".into() } else { "-.inf".into() }
    } else {
        format!("{value:?}")
    }
}

/// Encode an analyzed script (`AnalyzerSnapshotTest::EncodeScript`)
pub fn encode_script(script: &AnalyzedScript, is_main: bool) -> Node {
    let e = Encoder { script, text: &script.parsed.scanned.text };
    let entry_id = script.catalog_entry_id();
    let mut out = Map::new();
    out.int("catalog-id", entry_id as i64);

    // Local declarations
    if !script.entry.table_declarations.is_empty() {
        out.insert("tables", encode_tables(&e, &script.entry.table_declarations));
    }

    // Errors
    let errors = script
        .errors
        .iter()
        .map(|error| {
            let mut m = Map::new();
            m.plain("type", error.error_type.variant_name().unwrap_or(""));
            // Only non-default (WARNING) severities are dumped
            if error.severity != dashql_buffers::analyzer::AnalyzerErrorSeverity::ERROR {
                m.plain("severity", error.severity.variant_name().unwrap_or(""));
            }
            m.plain("message", &error.message);
            let span = match error.symbol_span {
                Some(span) => e.resolve(span),
                None => error.text_span.unwrap_or_default(),
            };
            encode_location_text(&mut m, e.text, span.offset, span.length, "text");
            m.into_node()
        })
        .collect();
    out.insert("errors", Node::seq(errors));

    // Table references
    if !script.table_references.is_empty() {
        let items = script
            .table_references
            .iter()
            .map(|table_ref| {
                let mut m = Map::new();
                if let Some(relation) = &table_ref.inner {
                    match &relation.resolved_table {
                        None => {
                            m.plain("type", "name/unresolved");
                        }
                        Some(resolved) => {
                            let table_id = resolved.catalog_table_id.unpack_table_id();
                            let internal = is_main && table_id.origin == entry_id;
                            m.plain("type", if internal { "name/internal" } else { "name/catalog" });
                            m.quoted(
                                "catalog-id",
                                &table_catalog_id(resolved.catalog_schema_id, resolved.catalog_table_id),
                            );
                        }
                    }
                }
                if let Some(statement) = table_ref.ast_statement_id {
                    m.int("statement-id", statement as i64);
                }
                if table_ref.role == TableRole::Write {
                    m.plain("role", "write");
                }
                e.location(&mut m, table_ref.ast_node_id, "text");
                m.into_node()
            })
            .collect();
        out.insert("table-refs", Node::seq(items));
    }

    // INSERT statements
    if !script.insert_statements.is_empty() {
        let items = script
            .insert_statements
            .iter()
            .map(|insert| {
                let mut m = Map::new();
                if let Some(statement) = insert.ast_statement_id {
                    m.int("statement-id", statement as i64);
                }
                let target = &script.table_references[insert.target as usize];
                m.int("target-ref", target.table_reference_id.object as i64);
                if let Some(source) = insert.source_ast_node_id {
                    e.location(&mut m, source, "source");
                }
                if insert.default_values {
                    m.insert("default-values", boolean(true));
                }
                if insert.returning {
                    m.insert("returning", boolean(true));
                }
                if !insert.target_columns.is_empty() {
                    let columns = insert
                        .target_columns
                        .iter()
                        .map(|column| {
                            let mut c = Map::new();
                            c.plain("name", &column.column_name.text);
                            c.insert("resolved", boolean(column.resolved.is_some()));
                            c.into_node()
                        })
                        .collect();
                    m.insert("columns", Node::seq(columns));
                }
                m.into_node()
            })
            .collect();
        out.insert("inserts", Node::seq(items));
    }

    // Expressions
    if !script.expressions.is_empty() {
        let items = script
            .expressions
            .iter()
            .enumerate()
            .map(|(i, expr)| {
                let mut m = Map::new();
                m.int("expression-idx", i as i64);
                match &expr.inner {
                    ExpressionInner::None => {}
                    ExpressionInner::ColumnRef(column_ref) => {
                        if !column_ref.resolved.is_resolved() {
                            m.plain("type", "colref/unresolved");
                        } else {
                            match &column_ref.resolved_ids {
                                None => {
                                    m.plain("type", "colref/local");
                                }
                                Some(ids) => {
                                    let (db, schema) = ids.catalog_schema_id.unpack_schema_id();
                                    let (table_id, column) = ids.catalog_table_column_id.unpack_table_column_id();
                                    let internal = is_main && table_id.origin == entry_id;
                                    m.plain("type", if internal { "colref/internal" } else { "colref/catalog" });
                                    m.quoted("catalog", &format!("{db}.{schema}.{}.{column}", table_id.pack()));
                                }
                            }
                        }
                    }
                    ExpressionInner::Literal(literal) => {
                        let name = match literal.literal_type {
                            LiteralType::NULL_ => "null",
                            LiteralType::INTERVAL => "interval",
                            LiteralType::INTEGER => "integer",
                            LiteralType::FLOAT => "float",
                            LiteralType::STRING => "string",
                            _ => "",
                        };
                        m.plain("type", &format!("literal/{name}"));
                    }
                    ExpressionInner::Comparison(cmp) => {
                        m.plain("type", "comparison");
                        m.plain("op", cmp.func.variant_name().unwrap_or(""));
                        m.int("arg-left", cmp.left_expression_id as i64);
                        m.int("arg-right", cmp.right_expression_id as i64);
                    }
                    ExpressionInner::BinaryExpression(binary) => {
                        m.plain("type", "binary");
                        m.plain("op", binary.func.variant_name().unwrap_or(""));
                        m.int("arg-left", binary.left_expression_id as i64);
                        m.int("arg-right", binary.right_expression_id as i64);
                    }
                    ExpressionInner::FunctionCall(call) => {
                        m.plain("type", "function");
                        match &call.function_name {
                            FunctionName::Known(known) => {
                                m.plain("known-function", known.variant_name().unwrap_or(""));
                            }
                            FunctionName::Qualified(name) => {
                                m.plain("name", &name.debug_string());
                            }
                        }
                    }
                    ExpressionInner::ConstIntervalCast(_) => {
                        m.plain("type", "constcast/interval");
                    }
                }
                if expr.is_constant_expression {
                    m.insert("is-const", boolean(true));
                }
                if let Some(statement) = expr.ast_statement_id {
                    m.int("statement-id", statement as i64);
                }
                e.location(&mut m, expr.ast_node_id, "text");
                m.into_node()
            })
            .collect();
        out.insert("expressions", Node::seq(items));
    }

    // Constant expressions
    if !script.constant_expressions.is_empty() {
        let items = script
            .constant_expressions
            .iter()
            .map(|constant| {
                let root = &script.expressions[constant.root as usize];
                let mut m = Map::new();
                m.int("expression", root.expression_id as i64);
                e.location(&mut m, root.ast_node_id, "text");
                m.into_node()
            })
            .collect();
        out.insert("constants", Node::seq(items));
    }

    // Visualization specs
    if !script.visualization_specs.is_empty() {
        let items = script.visualization_specs.iter().map(|spec| encode_visualization(&e, spec)).collect();
        out.insert("visualizations", Node::seq(items));
    }

    // Inferred table schemas
    if !script.inferred_table_schemas.is_empty() {
        let confidence = |c: InferenceConfidence| match c {
            InferenceConfidence::Confident => "confident",
            InferenceConfidence::Candidate => "candidate",
            InferenceConfidence::None => "none",
        };
        let items = script
            .inferred_table_schemas
            .iter()
            .map(|schema| {
                let mut m = Map::new();
                m.plain("name", &schema.table_name.debug_string());
                m.plain("confidence", confidence(schema.confidence));
                let columns = schema
                    .columns
                    .iter()
                    .map(|column| {
                        let mut c = Map::new();
                        c.plain("name", &column.column_name.text);
                        c.plain("confidence", confidence(column.confidence));
                        if !column.candidate_table_names.is_empty() {
                            let candidates =
                                column.candidate_table_names.iter().map(|n| super::plain(&n.debug_string())).collect();
                            c.insert("candidates", Node::seq(candidates));
                        }
                        c.into_node()
                    })
                    .collect();
                m.insert("columns", Node::seq(columns));
                m.into_node()
            })
            .collect();
        out.insert("inferred-tables", Node::seq(items));
    }
    out.into_node()
}

fn encode_visualization(e: &Encoder, spec: &VisualizationSpec) -> Node {
    let mut m = Map::new();
    if let Some(statement) = spec.ast_statement_id {
        m.int("statement-id", statement as i64);
    }
    if let Some(source) = spec.source_node_id {
        e.location(&mut m, source, "source");
    }
    if let Some(renderer) = &spec.renderer {
        m.plain("renderer", renderer);
    }
    let mut dashboard = Map::new();
    if let Some(row) = spec.dashboard.row {
        dashboard.int("row", row as i64);
    }
    if let Some(column) = spec.dashboard.column {
        dashboard.int("column", column as i64);
    }
    dashboard.int("width", spec.dashboard.width as i64);
    dashboard.int("height", spec.dashboard.height as i64);
    m.insert("dashboard", dashboard.into_node());
    // The structured spec is renderer-specific, only vegalite is understood today
    if spec.renderer.as_deref() != Some("vegalite") {
        return m.into_node();
    }
    let mut vl = Map::new();
    if let Some(mark) = spec.mark_type {
        vl.plain("mark", mark.variant_name().unwrap_or(""));
    }
    if let Some(title) = &spec.title {
        vl.plain("title", title);
    }
    if !spec.layers.is_empty() {
        vl.int("layer-count", spec.layers.len() as i64);
    }
    if let Some(resolve) = &spec.resolve {
        let mut r = Map::new();
        let mut opt = |key: &str, v: Option<u32>| {
            if let Some(v) = v {
                r.int(key, v as i64);
            }
        };
        opt("scale-node-id", resolve.scale_node_id);
        opt("axis-node-id", resolve.axis_node_id);
        opt("legend-node-id", resolve.legend_node_id);
        vl.insert("resolve", r.into_node());
    }
    if !spec.encoding_channels.is_empty() {
        let channels = spec.encoding_channels.iter().map(encode_channel).collect();
        vl.insert("encodings", Node::seq(channels));
    }
    m.insert("vegalite", vl.into_node());
    m.into_node()
}

/// A map builder with helpers for optional values
struct Opt(Map);

impl Opt {
    fn int(&mut self, key: &str, v: Option<impl Into<i64>>) {
        if let Some(v) = v {
            self.0.int(key, v.into());
        }
    }
    fn bool(&mut self, key: &str, v: Option<bool>) {
        if let Some(v) = v {
            self.0.insert(key, boolean(v));
        }
    }
    fn real(&mut self, key: &str, v: Option<f64>) {
        if let Some(v) = v {
            self.0.insert(key, real(v));
        }
    }
    fn text(&mut self, key: &str, v: &Option<String>) {
        if let Some(v) = v {
            self.0.plain(key, v);
        }
    }
}

fn encode_channel(channel: &VisEncodingChannel) -> Node {
    let mut m = Opt(Map::new());
    m.0.plain("channel", channel.channel_key.variant_name().unwrap_or(""));
    m.int("field-expr", channel.field_expression_id);
    m.int("field-node-id", channel.field_node_id);
    if let Some(t) = channel.field_type {
        m.0.plain("field-type", t.variant_name().unwrap_or(""));
    }
    if let Some(b) = &channel.bin {
        let mut bin = Opt(Map::new());
        bin.bool("binned", b.binned);
        bin.real("step", b.step);
        bin.real("maxbins", b.maxbins);
        bin.real("minstep", b.minstep);
        bin.real("anchor", b.anchor);
        bin.real("base", b.base);
        bin.bool("nice", b.nice);
        bin.int("extent-node-id", b.extent_node_id);
        bin.int("divide-node-id", b.divide_node_id);
        bin.int("steps-node-id", b.steps_node_id);
        m.0.insert("bin", bin.0.into_node());
    }
    m.text("aggregate", &channel.aggregate);
    m.text("time-unit", &channel.time_unit);
    m.int("stack-node-id", channel.stack_node_id);
    if let Some(s) = &channel.scale {
        let mut scale = Opt(Map::new());
        if let Some(t) = s.scale_type {
            scale.0.plain("type", t.variant_name().unwrap_or(""));
        }
        scale.bool("zero", s.zero);
        scale.bool("nice", s.nice);
        scale.bool("clamp", s.clamp);
        scale.bool("reverse", s.reverse);
        scale.bool("round", s.round);
        scale.text("scheme", &s.scheme);
        scale.text("interpolate", &s.interpolate);
        scale.real("exponent", s.exponent);
        scale.real("base", s.base);
        scale.real("constant", s.constant);
        scale.real("align", s.align);
        scale.real("padding", s.padding);
        scale.real("padding-inner", s.padding_inner);
        scale.real("padding-outer", s.padding_outer);
        scale.int("domain-node-id", s.domain_node_id);
        scale.int("domain-min-node-id", s.domain_min_node_id);
        scale.int("domain-max-node-id", s.domain_max_node_id);
        scale.int("domain-mid-node-id", s.domain_mid_node_id);
        scale.int("range-node-id", s.range_node_id);
        scale.int("range-min-node-id", s.range_min_node_id);
        scale.int("range-max-node-id", s.range_max_node_id);
        scale.int("bins-node-id", s.bins_node_id);
        scale.text("name", &s.name);
        m.0.insert("scale", scale.0.into_node());
    }
    if let Some(a) = &channel.axis {
        let mut axis = Opt(Map::new());
        axis.text("orient", &a.orient);
        axis.text("title", &a.title);
        axis.bool("grid", a.grid);
        axis.bool("ticks", a.ticks);
        axis.bool("domain", a.domain);
        axis.real("label-angle", a.label_angle);
        axis.real("label-font-size", a.label_font_size);
        axis.real("tick-count", a.tick_count);
        axis.real("tick-size", a.tick_size);
        axis.real("offset", a.offset);
        axis.text("format", &a.format);
        axis.text("format-type", &a.format_type);
        axis.text("direction", &a.direction);
        axis.text("label-overlap", &a.label_overlap);
        axis.int("zindex", a.zindex);
        axis.int("values-node-id", a.values_node_id);
        axis.text("name", &a.name);
        m.0.insert("axis", axis.0.into_node());
    }
    if let Some(l) = &channel.legend {
        let mut legend = Opt(Map::new());
        legend.text("type", &l.legend_type);
        legend.text("orient", &l.orient);
        legend.text("title", &l.title);
        legend.text("direction", &l.direction);
        legend.text("format", &l.format);
        legend.text("format-type", &l.format_type);
        legend.real("padding", l.padding);
        legend.real("offset", l.offset);
        legend.int("zindex", l.zindex);
        legend.int("values-node-id", l.values_node_id);
        legend.text("name", &l.name);
        m.0.insert("legend", legend.0.into_node());
    }
    m.0.into_node()
}

/// The keys the analyzer snapshot test compares
pub const COMPARED_KEYS: [&str; 7] =
    ["errors", "tables", "table-refs", "inserts", "expressions", "constants", "inferred-tables"];

/// Analyze the scripts of an analyzer snapshot case like `AnalyzerSnapshotTest` does: the catalog
/// script is analyzed and loaded with its entry id as rank, then the main script is analyzed.
/// Returns the encoded catalog script (if any) and the encoded main script.
pub fn analyze_case(catalog_input: Option<&str>, main_input: &str) -> Result<(Option<Yaml>, Yaml), String> {
    use dashql_core::catalog::Catalog;
    use dashql_grammar::parser::parse;
    use dashql_grammar::scanner::scan;
    use std::sync::Arc;

    let mut catalog = Catalog::new();
    let analyze_text = |catalog: &Catalog, text: &str| -> Result<AnalyzedScript, String> {
        let entry_id = catalog.allocate_entry_id();
        let parsed = Arc::new(parse(Arc::new(scan(text, 0, entry_id))));
        dashql_core::analyzer::analyze(parsed, catalog).map_err(|e| e.message)
    };
    let mut catalog_yaml = None;
    if let Some(input) = catalog_input {
        let analyzed = analyze_text(&catalog, input)?;
        catalog_yaml = Some(encode_script(&analyzed, false).to_yaml());
        let rank = analyzed.catalog_entry_id();
        catalog.load_script(Arc::new(analyzed), rank).map_err(|e| e.message)?;
    }
    let analyzed = analyze_text(&catalog, main_input)?;
    Ok((catalog_yaml, encode_script(&analyzed, true).to_yaml()))
}

/// Compare the keys that the analyzer snapshot test compares
pub fn compare_script(expected: &Yaml, actual: &Yaml) -> Result<(), String> {
    for key in COMPARED_KEYS {
        let want = &expected[key];
        if matches!(want, Yaml::BadValue) {
            continue;
        }
        crate::compare(want, &actual[key]).map_err(|e| format!("{key}: {e}"))?;
    }
    Ok(())
}
