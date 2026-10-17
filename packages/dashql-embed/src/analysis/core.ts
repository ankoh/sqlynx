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
    diagnostics: string[];
}

const BATCH_SIZE = 64;

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
                    diagnostics: collectDiagnostics(script),
                });
            }
        }
        return out;
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
