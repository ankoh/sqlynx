import { DashQL, type BatchScriptResult } from '@ankoh/dashql-core';

/// A script that should be linted
export interface LintInput {
    id: string;
    text: string;
}

/// A diagnostic with its position resolved to a line and column
export interface Diagnostic {
    file: string;
    /// 1-based line and column (in code points), absent for failures
    line?: number;
    column?: number;
    stage: 'scan' | 'parse' | 'analyze' | 'failure';
    severity: 'error' | 'warning';
    message: string;
    /// UTF-8 byte offset and length in the script, absent for failures
    offset?: number;
    length?: number;
}

const BATCH_SIZE = 64;

/// Resolve a UTF-8 byte offset to a 1-based line and column, the column counts code points
export function lineColumn(bytes: Uint8Array, offset: number): { line: number; column: number } {
    const end = Math.min(offset, bytes.length);
    let line = 1;
    let column = 1;
    for (let i = 0; i < end; ++i) {
        const byte = bytes[i];
        if (byte === 0x0a) {
            line += 1;
            column = 1;
        } else if ((byte & 0xc0) !== 0x80) {
            // Continuation bytes belong to the code point that was already counted
            column += 1;
        }
    }
    return { line, column };
}

function toDiagnostics(file: string, bytes: Uint8Array, result: BatchScriptResult): Diagnostic[] {
    const out: Diagnostic[] = result.diagnostics.map(d => ({
        file,
        ...lineColumn(bytes, d.offset),
        stage: d.stage,
        severity: d.severity,
        message: d.message,
        offset: d.offset,
        length: d.length,
    }));
    if (result.failure) {
        out.push({ file, stage: 'failure', severity: 'error', message: result.failure });
    }
    return out;
}

/// Runs scripts through the DashQL scanner, parser and analyzer and collects their diagnostics
export class Linter {
    readonly core: DashQL;
    readonly catalogDescriptors: Uint8Array[] = [];
    readonly encoder = new TextEncoder();

    private constructor(core: DashQL) {
        this.core = core;
    }

    static async create(): Promise<Linter> {
        return new Linter(await DashQL.create());
    }

    /// Add a schema script (e.g. CREATE TABLE statements) to the catalog that later scripts resolve names against.
    /// Returns the diagnostics of the schema script itself.
    addSchema(input: LintInput): Diagnostic[] {
        const result = this.core.processBatch({
            scripts: [{ id: input.id, text: input.text, outputs: ['catalogDescriptor'] }],
            catalogDescriptors: this.catalogDescriptors,
        }).scripts[0];
        if (result.catalogDescriptor) {
            this.catalogDescriptors.push(result.catalogDescriptor);
        }
        return toDiagnostics(input.id, this.encoder.encode(input.text), result);
    }

    /// Lint scripts against the loaded schemas
    lint(inputs: LintInput[]): Diagnostic[] {
        const out: Diagnostic[] = [];
        for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
            const chunk = inputs.slice(i, i + BATCH_SIZE);
            const result = this.core.processBatch({
                scripts: chunk.map(input => ({ id: input.id, text: input.text, outputs: ['analyzed'] })),
                catalogDescriptors: this.catalogDescriptors,
            });
            for (let j = 0; j < chunk.length; ++j) {
                out.push(...toDiagnostics(chunk[j].id, this.encoder.encode(chunk[j].text), result.scripts[j]));
            }
        }
        return out;
    }
}

/// A JSON array with one diagnostic per line, readable by people and by JSON.parse
export function formatDiagnostics(diagnostics: Diagnostic[]): string {
    if (diagnostics.length === 0) return '[\n]\n';
    return `[\n${diagnostics.map(d => JSON.stringify(d)).join(',\n')}\n]\n`;
}
