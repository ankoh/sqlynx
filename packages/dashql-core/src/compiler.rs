//! The script compiler, a port of `src/script_compiler.cc`: turns a script into the SQL statements
//! to execute and the compiled visualization of a terminal VISUALIZE statement.

use crate::analyzer::{AnalyzedScript, VisualizationSpec};
use crate::catalog::{Catalog, PROTO_NULL_U32};
use crate::formatter::Formatter;
use crate::script::Script;
use crate::visualize;
use dashql_buffers::execution::{
    CompiledScriptStatementKind as CompiledKind, CompiledScriptStatementT, CompiledVisualizationT, ScriptCompilationErrorCode as ErrorCode,
    ScriptCompilationErrorT, ScriptCompilationResultT, ScriptCompilationStatementKind as StatementKind,
};
use dashql_buffers::formatting::FormattingConfigT;
use dashql_buffers::parser::{AttributeKey, NodeType, ParsedScriptFeature, StatementType, TextSpanT};
use dashql_buffers::visualization::{DashboardSpecT, MarkdownSpec, TableSpecT, UmapSpec};
use dashql_grammar::attrs;
use dashql_grammar::parser::context::resolve_text_span;
use dashql_grammar::parser::{ParsedScript, Statement};
use dashql_grammar::scanner::ScannedScript;
use dashql_grammar::span::TextSpan;

/// Options of the compilation (`ScriptCompilationOptions`)
#[derive(Clone, Copy, Debug)]
pub struct CompilationOptions {
    /// Allow the DashQL extensions (VISUALIZE)
    pub allow_extensions: bool,
    /// Parse the script if the text changed
    pub parse_if_outdated: bool,
}

impl Default for CompilationOptions {
    fn default() -> Self {
        Self {
            allow_extensions: true,
            parse_if_outdated: true,
        }
    }
}

fn error(code: ErrorCode, message: &str, statement_id: u32, ast_node_id: u32, text_span: Option<TextSpan>) -> ScriptCompilationErrorT {
    let mut e = ScriptCompilationErrorT::default();
    e.code = code;
    e.statement_id = statement_id;
    e.ast_node_id = ast_node_id;
    e.text_span = text_span.map(|s| {
        let mut t = TextSpanT::default();
        t.offset = s.offset;
        t.length = s.length;
        t
    });
    e.message = Some(message.to_string());
    e
}

/// The text of a span with the obfuscated literals replaced, so that it can be executed
/// (`ScannedScript::ReadExecutableText`)
pub fn read_executable_text(scanned: &ScannedScript, span: TextSpan) -> String {
    let text = scanned.text.as_bytes();
    let mut begin = span.offset as usize;
    let end = (span.offset + span.length) as usize;
    let mut out = Vec::with_capacity(span.length as usize);
    let first = scanned.obfuscated_literals.partition_point(|l| (l.location.offset as usize) < begin);
    for literal in &scanned.obfuscated_literals[first..] {
        let literal_end = (literal.location.offset + literal.location.length) as usize;
        if literal_end > end {
            break;
        }
        out.extend_from_slice(&text[begin.min(text.len())..(literal.location.offset as usize).min(text.len())]);
        out.extend_from_slice(literal.replacement.as_bytes());
        begin = literal_end;
    }
    out.extend_from_slice(&text[begin.min(text.len())..end.min(text.len()).max(begin.min(text.len()))]);
    String::from_utf8_lossy(&out).into_owned()
}

/// The SQL node of the terminal statement (`ReadTerminalSqlNode`)
fn read_terminal_sql_node(parsed: &ParsedScript, statement_id: usize, kind: &mut StatementKind) -> Option<u32> {
    let statement = &parsed.statements[statement_id];
    match statement.statement_type {
        StatementType::NONE => None,
        StatementType::VIS_VISUALISE => {
            *kind = StatementKind::VISUALIZE;
            let root = &parsed.nodes[statement.root as usize];
            let begin = root.children_begin_or_value() as usize;
            let children = &parsed.nodes[begin..begin + root.children_count() as usize];
            let [source] = attrs!(children, [AttributeKey::VIS_VISUALISE_SELECT]);
            let source = source?;
            Some(((source as *const _ as usize - parsed.nodes.as_ptr() as usize) / std::mem::size_of::<dashql_buffers::parser::Node>()) as u32)
        }
        _ => {
            *kind = StatementKind::QUERY;
            Some(statement.root)
        }
    }
}

fn has_returning(parsed: &ParsedScript, statement: &Statement) -> bool {
    let root = &parsed.nodes[statement.root as usize];
    let begin = root.children_begin_or_value() as usize;
    let children = &parsed.nodes[begin..begin + root.children_count() as usize];
    let [insert_returning, delete_returning] = attrs!(children, [AttributeKey::SQL_INSERT_RETURNING, AttributeKey::SQL_DELETE_RETURNING]);
    let returning = if statement.statement_type == StatementType::DELETE { delete_returning } else { insert_returning };
    returning.is_some_and(|r| r.node_type() != NodeType::NONE)
}

/// Does a statement produce output? (`ProducesOutput`)
fn produces_output(parsed: &ParsedScript, statement: &Statement) -> bool {
    match statement.statement_type {
        StatementType::SELECT | StatementType::EXPLAIN | StatementType::SELECT_INTO | StatementType::VIS_VISUALISE => true,
        StatementType::INSERT | StatementType::DELETE => has_returning(parsed, statement),
        _ => false,
    }
}

/// Compile the visualization metadata (`ScriptCompiler::CompileVisualization`)
pub fn compile_visualization(spec: &VisualizationSpec, script: &AnalyzedScript) -> Result<CompiledVisualizationT, String> {
    let renderer = spec.renderer.as_ref().ok_or("could not resolve visualization renderer")?.to_ascii_lowercase();
    let mut out = CompiledVisualizationT::default();
    // The C++ visualization always writes its strings
    out.vegalite_spec = Some(String::new());
    let mut dashboard = DashboardSpecT::default();
    dashboard.row = spec.dashboard.row;
    dashboard.column = spec.dashboard.column;
    dashboard.width = spec.dashboard.width;
    dashboard.height = spec.dashboard.height;
    out.dashboard = Some(Box::new(dashboard));
    match renderer.as_str() {
        "vegalite" => out.vegalite_spec = Some(visualize::generate_vegalite_spec(spec, script)),
        "umap" => {
            let doc = visualize::compile_umap_spec(spec, script).filter(|d| !d.vector_column.is_empty());
            let doc = doc.ok_or("UMAP visualization requires a vector field")?;
            let mut builder = flatbuffers::FlatBufferBuilder::new();
            let packed = visualize::pack_umap_spec(&mut builder, &doc);
            builder.finish(packed, None);
            out.umap_spec = Some(Box::new(flatbuffers::root::<UmapSpec>(builder.finished_data()).unwrap().unpack()));
        }
        "markdown" => {
            let doc = visualize::compile_markdown_spec(spec).ok_or("could not compile Markdown visualization spec")?;
            let mut builder = flatbuffers::FlatBufferBuilder::new();
            let packed = visualize::pack_markdown_spec(&mut builder, &doc);
            builder.finish(packed, None);
            out.markdown_spec = Some(Box::new(flatbuffers::root::<MarkdownSpec>(builder.finished_data()).unwrap().unpack()));
        }
        "table" => out.table_spec = Some(Box::new(TableSpecT::default())),
        _ => return Err(format!("unsupported visualization renderer: {renderer}")),
    }
    out.renderer = Some(renderer);
    Ok(out)
}

/// Is a byte C `isspace`?
fn is_c_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\x0b' | b'\x0c' | b'\r')
}

/// Compile a script (`ScriptCompiler::Compile`)
pub fn compile(script: &mut Script, catalog: &Catalog, config: &FormattingConfigT, options: CompilationOptions) -> ScriptCompilationResultT {
    let mut result = ScriptCompilationResultT::default();
    result.kind = StatementKind::QUERY;
    result.terminal_statement_id = PROTO_NULL_U32;
    // The C++ result always writes its strings
    result.sql = Some(String::new());
    result.cache_signature = Some(String::new());
    let mut errors = Vec::new();
    let mut statements: Vec<CompiledScriptStatementT> = Vec::new();
    let finish = |mut result: ScriptCompilationResultT, errors, statements| {
        result.errors = Some(errors);
        result.statements = Some(statements);
        result
    };
    if options.parse_if_outdated && script.parsed.as_ref().is_none_or(|p| p.scanned.text_version != script.text_version()) {
        script.parse();
    }
    let Some(parsed) = script.parsed.clone() else {
        errors.push(error(ErrorCode::EMPTY_SCRIPT, "script is not parsed", PROTO_NULL_U32, PROTO_NULL_U32, None));
        return finish(result, errors, statements);
    };
    let scanned = &parsed.scanned;
    for e in &scanned.errors {
        errors.push(error(ErrorCode::SCANNER_ERROR, &e.message, PROTO_NULL_U32, PROTO_NULL_U32, Some(e.location)));
    }
    for e in &parsed.errors {
        let span = resolve_text_span(&scanned.text, &scanned.symbols, e.location);
        errors.push(error(ErrorCode::PARSER_ERROR, &e.message, PROTO_NULL_U32, PROTO_NULL_U32, Some(span)));
    }
    if !errors.is_empty() {
        // Without a reliable AST, send the original text once and do not cache or split it
        let sql = read_executable_text(scanned, TextSpan::new(0, scanned.text.len() as u32));
        if sql.bytes().any(|c| !is_c_space(c)) {
            result.sql = Some(sql.clone());
            result.terminal_statement_id = 0;
            let mut statement = CompiledScriptStatementT::default();
            statement.statement_id = 0;
            statement.kind = CompiledKind::OUTPUT;
            statement.sql = Some(sql);
            statements.push(statement);
        }
        return finish(result, errors, statements);
    }
    if parsed.statements.is_empty() {
        errors.push(error(ErrorCode::EMPTY_SCRIPT, "script has no executable statement", PROTO_NULL_U32, PROTO_NULL_U32, None));
        return finish(result, errors, statements);
    }
    let execution_features = ParsedScriptFeature::VISUALIZE.0 as u32;
    if !options.allow_extensions && parsed.feature_flags & execution_features != 0 {
        errors.push(error(
            ErrorCode::EXTENSIONS_DISABLED,
            "DashQL VISUALIZE syntax is not executable in the shell",
            PROTO_NULL_U32,
            PROTO_NULL_U32,
            None,
        ));
        return finish(result, errors, statements);
    }
    let terminal_statement_id = parsed.statements.len() - 1;
    result.terminal_statement_id = terminal_statement_id as u32;
    let terminal_type = parsed.statements[terminal_statement_id].statement_type;
    result.cacheable = matches!(terminal_type, StatementType::SELECT | StatementType::EXPLAIN | StatementType::VIS_VISUALISE);

    let descriptions = parsed.associate_descriptions();
    for (statement_id, statement) in parsed.statements.iter().enumerate() {
        let output = produces_output(&parsed, statement);
        let span = descriptions[statement_id].statement_span;
        if output && statement_id != terminal_statement_id {
            errors.push(error(
                ErrorCode::OUTPUT_STATEMENT_NOT_LAST,
                "SELECT, EXPLAIN, SELECT INTO, INSERT RETURNING, DELETE RETURNING, or VISUALIZE must be the final statement",
                statement_id as u32,
                statement.root,
                Some(span),
            ));
            continue;
        }
        let mut compiled = CompiledScriptStatementT::default();
        compiled.statement_id = statement_id as u32;
        compiled.statement_type = statement.statement_type;
        compiled.kind = if output { CompiledKind::OUTPUT } else { CompiledKind::COMMAND };
        compiled.sql = Some(read_executable_text(scanned, span));
        statements.push(compiled);
    }
    if !errors.is_empty() {
        return finish(result, errors, statements);
    }
    result.cache_signature = Some(crate::signature::compute_signature(&parsed).unwrap_or_default());

    if parsed.feature_flags & execution_features == 0 {
        result.kind = StatementKind::QUERY;
        result.sql = statements.last().and_then(|s| s.sql.clone()).or(Some(String::new()));
        return finish(result, errors, statements);
    }

    let mut kind = result.kind;
    let terminal_node = read_terminal_sql_node(&parsed, terminal_statement_id, &mut kind);
    result.kind = kind;
    let terminal_root = parsed.statements[terminal_statement_id].root;
    let Some(terminal_node) = terminal_node else {
        let span = resolve_text_span(&scanned.text, &scanned.symbols, *parsed.nodes[terminal_root as usize].symbol_span());
        errors.push(error(
            ErrorCode::LAST_STATEMENT_NOT_EXECUTABLE,
            "the final statement must be a query or VISUALIZE statement",
            terminal_statement_id as u32,
            terminal_root,
            Some(span),
        ));
        return finish(result, errors, statements);
    };

    if result.kind == StatementKind::VISUALIZE {
        let current = script.analyzed.as_ref().is_some_and(|a| std::sync::Arc::ptr_eq(&a.parsed, &parsed));
        if !current {
            // The C++ compiler lets the exception of the analysis escape
            if let Err(e) = script.analyze(catalog, false) {
                errors.push(error(ErrorCode::VISUALIZATION_METADATA_UNAVAILABLE, &e.message, terminal_statement_id as u32, terminal_root, None));
                return finish(result, errors, statements);
            }
        }
    }

    let mut formatter = Formatter::new(&parsed);
    formatter.replace_obfuscated_literals();
    let sql = formatter.format_node_at(terminal_node as usize, config);
    if sql.is_empty() {
        result.sql = Some(String::new());
        errors.push(error(
            ErrorCode::FORMAT_ERROR,
            "could not format the executable query",
            terminal_statement_id as u32,
            terminal_node,
            None,
        ));
        return finish(result, errors, statements);
    }
    result.sql = Some(sql.clone());

    if result.kind == StatementKind::VISUALIZE {
        let analyzed = script.analyzed.clone().unwrap();
        let visualization = analyzed
            .visualization_specs
            .iter()
            .find(|s| s.ast_statement_id == Some(terminal_statement_id as u32))
            .filter(|s| s.renderer.is_some());
        let Some(visualization) = visualization else {
            result.sql = Some(String::new());
            errors.push(error(
                ErrorCode::VISUALIZATION_METADATA_UNAVAILABLE,
                "could not resolve visualization metadata",
                terminal_statement_id as u32,
                terminal_root,
                None,
            ));
            return finish(result, errors, statements);
        };
        match compile_visualization(visualization, &analyzed) {
            Ok(compiled) => {
                let terminal = statements.last_mut().unwrap();
                terminal.kind = CompiledKind::VISUALIZE;
                terminal.sql = Some(sql);
                terminal.visualization = Some(Box::new(compiled.clone()));
                result.visualization = Some(Box::new(compiled));
            }
            Err(message) => {
                result.sql = Some(String::new());
                errors.push(error(
                    ErrorCode::VISUALIZATION_METADATA_UNAVAILABLE,
                    &message,
                    terminal_statement_id as u32,
                    terminal_root,
                    None,
                ));
                return finish(result, errors, statements);
            }
        }
    }
    finish(result, errors, statements)
}
