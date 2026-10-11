import * as flatbuffers from 'flatbuffers';
import * as buffers from './buffers.js';

export type BatchOutput = 'scanned' | 'parsed' | 'analyzed' | 'catalogDescriptor';

export interface BatchScriptInput {
    id: string;
    text: string;
    outputs: BatchOutput[];
}

export interface BatchRequest {
    scripts: BatchScriptInput[];
    /// Borrowed context bytes; processing never detaches or modifies them.
    catalogDescriptors?: Uint8Array[];
}

export interface BatchDiagnostic {
    stage: 'scan' | 'parse' | 'analyze';
    severity: 'error' | 'warning';
    offset: number;
    length: number;
    message: string;
}

export interface BatchScriptResult {
    id: string;
    diagnostics: BatchDiagnostic[];
    /// Selected outputs own their bytes and remain valid independently of Wasm memory.
    scanned?: Uint8Array;
    parsed?: Uint8Array;
    analyzed?: Uint8Array;
    catalogDescriptor?: Uint8Array;
    failure?: string;
}

export interface BatchResult {
    scripts: BatchScriptResult[];
}

export function encodeBatchRequest(request: BatchRequest): Uint8Array {
    const scripts = request.scripts.map(script => {
        if (typeof script.id !== 'string' || typeof script.text !== 'string') {
            throw new TypeError('batch script id and text must be strings');
        }
        let mask = 0;
        for (const output of script.outputs) {
            switch (output) {
                case 'scanned': mask |= 1; break;
                case 'parsed': mask |= 2; break;
                case 'analyzed': mask |= 4; break;
                case 'catalogDescriptor': mask |= 8; break;
                default: throw new TypeError(`unknown batch output: ${output}`);
            }
        }
        return new buffers.batch.BatchScriptInputT(script.id, script.text, mask);
    });
    const descriptors = (request.catalogDescriptors ?? []).map(descriptor =>
        new buffers.batch.DescriptorBufferT(Array.from(descriptor))
    );
    const builder = new flatbuffers.Builder();
    builder.finish(new buffers.batch.BatchRequestT(scripts, descriptors).pack(builder));
    return builder.asUint8Array();
}

/// Only nested output bytes escape the reader; the outer buffer may be freed immediately.
export function decodeBatchResult(bytes: Uint8Array): BatchResult {
    const reader = buffers.batch.BatchResult.getRootAsBatchResult(new flatbuffers.ByteBuffer(bytes));
    const scripts: BatchScriptResult[] = [];
    for (let i = 0; i < reader.scriptsLength(); ++i) {
        const script = reader.scripts(i)!;
        const result: BatchScriptResult = { id: script.id() ?? '', diagnostics: [] };
        for (let j = 0; j < script.diagnosticsLength(); ++j) {
            const diagnostic = script.diagnostics(j)!;
            let stage: BatchDiagnostic['stage'];
            switch (diagnostic.stage()) {
                case buffers.batch.ProcessingStage.SCAN: stage = 'scan'; break;
                case buffers.batch.ProcessingStage.PARSE: stage = 'parse'; break;
                case buffers.batch.ProcessingStage.ANALYZE: stage = 'analyze'; break;
                default: throw new Error('unknown batch diagnostic stage');
            }
            let severity: BatchDiagnostic['severity'];
            switch (diagnostic.severity()) {
                case buffers.batch.DiagnosticSeverity.ERROR: severity = 'error'; break;
                case buffers.batch.DiagnosticSeverity.WARNING: severity = 'warning'; break;
                default: throw new Error('unknown batch diagnostic severity');
            }
            result.diagnostics.push({
                stage,
                severity,
                offset: diagnostic.offset(),
                length: diagnostic.length(),
                message: diagnostic.message() ?? '',
            });
        }
        const scanned = script.scannedArray();
        const parsed = script.parsedArray();
        const analyzed = script.analyzedArray();
        const descriptor = script.catalogDescriptorArray();
        if (scanned?.length) result.scanned = new Uint8Array(scanned);
        if (parsed?.length) result.parsed = new Uint8Array(parsed);
        if (analyzed?.length) result.analyzed = new Uint8Array(analyzed);
        if (descriptor?.length) result.catalogDescriptor = new Uint8Array(descriptor);
        const failure = script.failure();
        if (failure != null) result.failure = failure;
        scripts.push(result);
    }
    return { scripts };
}
