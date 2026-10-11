import { DashQL, buffers, type DashQLModuleOptions, type EmscriptenModule, type VariantKind } from '@ankoh/dashql-core';
import * as publicBuffers from '@ankoh/dashql-core/buffers';
import createModule from '@ankoh/dashql-core/wasm/glue';
import {
    createBatchWorker,
    DashQLBatchWorker,
    type BatchWorkerRequest,
    type BatchWorkerResponse,
    type BatchRequest,
    type BatchResult,
    type BatchScriptInput,
    type BatchScriptResult,
    type BatchDiagnostic,
    type BatchOutput,
} from '@ankoh/dashql-core/browser-worker';

const output: BatchOutput = 'analyzed';
const script: BatchScriptInput = { id: 'query', text: 'select 1', outputs: [output] };
const request: BatchRequest = { scripts: [script] };
const message: BatchWorkerRequest = { requestId: 1, request };
const diagnostic: BatchDiagnostic = { stage: 'analyze', severity: 'warning', offset: 0, length: 1, message: 'test' };
const scriptResult: BatchScriptResult = { id: script.id, diagnostics: [diagnostic] };
const result: BatchResult = { scripts: [scriptResult] };
const response: BatchWorkerResponse = { requestId: message.requestId, result };
const variant: VariantKind<'result', BatchResult> = { type: 'result', value: result };
const options: DashQLModuleOptions = {
    wasmBinary: new Uint8Array(),
    instantiateWasm: (imports, ready) => {
        const module = new WebAssembly.Module(new Uint8Array());
        const instance = new WebAssembly.Instance(module, imports);
        ready(instance, module);
        return instance.exports;
    },
};
const module: EmscriptenModule = await createModule(options);
const core: DashQL = new DashQL(module);
const parsed: publicBuffers.parser.ParsedScript = new buffers.parser.ParsedScript();
const worker: DashQLBatchWorker = createBatchWorker();
const pending: Promise<BatchResult> = worker.processBatch(request);
void [response, variant, core, parsed, pending];

// The fixture must not accidentally acquire lib.dom through declarations.
// @ts-expect-error Document is a DOM-only type, unavailable in this consumer.
type NoDOM = Document;
