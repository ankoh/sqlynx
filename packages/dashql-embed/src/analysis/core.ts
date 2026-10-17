import { DashQL, buffers, type BatchDiagnostic, type BatchScriptResult } from '@ankoh/dashql-core';
import * as flatbuffers from 'flatbuffers';

/// A script that should be analyzed.
export interface SqlInput {
    id: string;
    text: string;
}

/// The analysis results of a single script.
/// The flatbuffer readers borrow detached byte arrays and remain valid independently of the Wasm memory.
export interface AnalyzedSql {
    id: string;
    text: string;
    /// The UTF-8 encoded script text, all DashQL offsets are byte offsets into this array
    bytes: Uint8Array;
    parsed: buffers.parser.ParsedScript | null;
    analyzed: buffers.analyzer.AnalyzedScript | null;
    /// The compiled trailing VISUALIZE statement, null for scripts without or with an uncompilable one
    visualization: CompiledVisualization | null;
    diagnostics: string[];
}

/// The compiled VISUALIZE statement of a script, as the app would render it
export interface CompiledVisualization {
    renderer: string;
    /// The effective Vega-Lite spec (JSON text), only for the `vegalite` renderer
    vegaliteSpec: string | null;
    /// The template and the fields it references, only for the `markdown` renderer
    markdown: { template: string; fields: string[] } | null;
    /// The columns of the `umap` renderer
    umap: { vectorColumn: string; categoryColumn: string; labelColumn: string } | null;
}

const BATCH_SIZE = 64;

/// The formatting only affects the `$sql` of the spec, which is not used. Any valid config works.
const COMPILE_CONFIG = new buffers.formatting.FormattingConfigT(
    buffers.formatting.FormattingDialect.HYPER,
    buffers.formatting.FormattingMode.INLINE,
    120,
    2,
    false,
);

function hasVisualize(parsed: buffers.parser.ParsedScript): boolean {
    for (let i = 0; i < parsed.statementsLength(); ++i) {
        if (parsed.statements(i)!.statementType() === buffers.parser.StatementType.VIS_VISUALISE) return true;
    }
    return false;
}

function formatDiagnostic(diagnostic: BatchDiagnostic): string {
    return `${diagnostic.stage} ${diagnostic.severity} at ${diagnostic.offset}: ${diagnostic.message}`;
}

function collectDiagnostics(result: BatchScriptResult): string[] {
    const out = result.diagnostics.map(formatDiagnostic);
    if (result.failure) {
        out.push(`failure: ${result.failure}`);
    }
    return out;
}

/// Wraps the DashQL batch API with a fixed set of catalog descriptors
export class SqlAnalyzer {
    readonly core: DashQL;
    readonly catalogDescriptors: Uint8Array[] = [];
    readonly encoder = new TextEncoder();

    private constructor(core: DashQL) {
        this.core = core;
    }

    static async create(): Promise<SqlAnalyzer> {
        return new SqlAnalyzer(await DashQL.create());
    }

    /// Add a schema script (e.g. CREATE TABLE statements) to the catalog used for name resolution.
    /// The CLI analyzes self-contained scripts and does not use it, tests do.
    addSchema(id: string, text: string): string[] {
        const result = this.core.processBatch({ scripts: [{ id, text, outputs: ['catalogDescriptor'] }] }).scripts[0];
        if (!result.catalogDescriptor) {
            throw new Error(`failed to derive a catalog from ${id}: ${collectDiagnostics(result).join('; ')}`);
        }
        this.catalogDescriptors.push(result.catalogDescriptor);
        return collectDiagnostics(result);
    }

    /// Parse and analyze scripts against the loaded catalog
    analyze(inputs: SqlInput[]): AnalyzedSql[] {
        const out: AnalyzedSql[] = [];
        for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
            const chunk = inputs.slice(i, i + BATCH_SIZE);
            const result = this.core.processBatch({
                scripts: chunk.map(input => ({ id: input.id, text: input.text, outputs: ['parsed', 'analyzed'] })),
                catalogDescriptors: this.catalogDescriptors,
            });
            for (let j = 0; j < chunk.length; ++j) {
                const script = result.scripts[j];
                out.push({
                    id: chunk[j].id,
                    text: chunk[j].text,
                    bytes: this.encoder.encode(chunk[j].text),
                    parsed: script.parsed
                        ? buffers.parser.ParsedScript.getRootAsParsedScript(new flatbuffers.ByteBuffer(script.parsed))
                        : null,
                    analyzed: script.analyzed
                        ? buffers.analyzer.AnalyzedScript.getRootAsAnalyzedScript(new flatbuffers.ByteBuffer(script.analyzed))
                        : null,
                    visualization: null,
                    diagnostics: collectDiagnostics(script),
                });
                // Only scripts with a VISUALIZE statement are compiled, creating a script is far more expensive than
                // the batch analysis that every script already went through
                const last = out[out.length - 1];
                if (last.parsed && hasVisualize(last.parsed)) {
                    last.visualization = this.compileVisualization(last.text);
                }
            }
        }
        return out;
    }

    /// Compile the trailing VISUALIZE statement of a script into the spec that the app renders.
    /// Needs the script API, the batch API does not compile. Names resolve against an empty catalog: the spec only
    /// refers to result columns and the query text, neither depends on the catalog, and the CLI analyzes scripts on
    /// their own anyway. Scripts that do not compile (e.g. VISUALIZE is not the final statement) have no visualization,
    /// their other features are still extracted.
    private compileVisualization(text: string): CompiledVisualization | null {
        const catalog = this.core.createCatalog();
        const script = this.core.createScript(catalog);
        try {
            script.replaceText(text);
            script.analyze();
            const compiled = script.compileQuery(COMPILE_CONFIG);
            try {
                const reader = compiled.read();
                const visualization = reader.errorsLength() === 0 ? reader.visualization() : null;
                if (!visualization) return null;
                const markdown = visualization.markdownSpec();
                const umap = visualization.umapSpec();
                return {
                    renderer: visualization.renderer() ?? '',
                    vegaliteSpec: visualization.vegaliteSpec() || null,
                    markdown: markdown
                        ? {
                              template: markdown.template() ?? '',
                              fields: Array.from({ length: markdown.fieldsLength() }, (_, i) => markdown.fields(i) as string),
                          }
                        : null,
                    umap: umap
                        ? {
                              vectorColumn: umap.vectorColumn() ?? '',
                              categoryColumn: umap.categoryColumn() ?? '',
                              labelColumn: umap.labelColumn() ?? '',
                          }
                        : null,
                };
            } finally {
                compiled.destroy();
            }
        } finally {
            script.destroy();
            catalog.destroy();
        }
    }

    /// Check which texts parse as SQL without errors and contain at least one statement.
    /// Used to tell commented-out code apart from prose.
    parsesAsSql(texts: string[]): boolean[] {
        const out: boolean[] = [];
        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
            const chunk = texts.slice(i, i + BATCH_SIZE);
            const result = this.core.processBatch({
                scripts: chunk.map((text, j) => ({ id: `probe_${i + j}`, text, outputs: ['parsed'] })),
            });
            for (const script of result.scripts) {
                if (!script.parsed || script.failure || script.diagnostics.some(d => d.severity === 'error')) {
                    out.push(false);
                    continue;
                }
                const parsed = buffers.parser.ParsedScript.getRootAsParsedScript(new flatbuffers.ByteBuffer(script.parsed));
                out.push(parsed.statementsLength() > 0);
            }
        }
        return out;
    }
}
