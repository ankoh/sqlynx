import '@jest/globals';

import * as arrow from 'apache-arrow';
import * as compute from '@ankoh/dashql-compute';
import * as path from 'path';
import * as fs from 'fs';

import { fileURLToPath } from 'node:url';
import { ComputeWorkerBindings, WorkerEventChannel, WorkerLike } from './compute_worker_bindings.js';
import { ComputeWorker, MessageEventLike, WorkerGlobalsLike } from './compute_worker.js';
import { TestLogger } from '../platform/test_logger.js';

const distPath = path.resolve(fileURLToPath(new URL('../../../dashql-compute/dist/', import.meta.url)));
const wasmPath = path.resolve(distPath, './dashql_compute_bg.wasm');

beforeAll(async () => {
    expect(async () => await fs.promises.access(wasmPath)).resolves;
    const buf = await fs.promises.readFile(wasmPath);
    await compute.default({
        module_or_path: buf
    });
    const version = compute.getVersion();
    expect(version.text).toMatch(/^[0-9]+.[0-9]+.[0-9]+(\-dev\.[0-9]+)?$/);
});

class InlineWorkerBase {
    /// The event listeners
    eventListeners: Map<WorkerEventChannel, ((event: MessageEventLike) => void)[]> = new Map();

    /// Register an event listener for the worker
    addEventListener(channel: WorkerEventChannel, handler: (event: MessageEventLike) => void): void {
        const listeners = this.eventListeners.get(channel) ?? [];
        listeners.push(handler);
        this.eventListeners.set(channel, listeners);
    }
    /// Remove an event listener from the worker
    removeEventListener(channel: WorkerEventChannel, handler: (event: MessageEventLike) => void): void {
        const listeners = this.eventListeners.get(channel) ?? [];
        this.eventListeners.set(channel, listeners.filter(l => l != handler));
    }
}
class InlinedWorker extends InlineWorkerBase implements WorkerLike {
    /// The worker thread
    public workerThread: InlinedWorkerGlobals | null = null;

    /// Terminate a worker
    terminate(): void { }
    /// Post a message to the worker
    postMessage(message: any, _transfer: Transferable[]): void {
        for (const listener of this.workerThread!.eventListeners.get("message") ?? []) {
            listener({ data: message });
        }
    }
}
class InlinedWorkerGlobals extends InlineWorkerBase implements WorkerGlobalsLike {
    /// The main thread
    public mainThread: InlinedWorker | null = null;

    /// Post a message to the worker
    postMessage(message: any, _transfer: Transferable[]): void {
        console.assert(this.mainThread != null);
        for (const listener of this.mainThread!.eventListeners.get("message") ?? []) {
            listener({ data: message });
        }
    }
}

function createInlineWorker(): [InlinedWorker, InlinedWorkerGlobals] {
    const worker = new InlinedWorker();
    const workerGlobals = new InlinedWorkerGlobals();
    worker.workerThread = workerGlobals;
    workerGlobals.mainThread = worker;
    return [worker, workerGlobals];
}


describe('DashQLCompute Worker', () => {
    it('read simple', async () => {
        const [worker, workerGlobals] = createInlineWorker();
        const logger = new TestLogger();

        const computeWorkerBindings = new ComputeWorkerBindings(logger, worker);
        const computeWorker = new ComputeWorker(workerGlobals);
        computeWorker.attach();

        // Instantiate the worker
        await computeWorkerBindings.instantiate(wasmPath);

        const t = arrow.tableFromArrays({
            id: new Int32Array([
                1, 2, 3, 4,
            ]),
            score: new Float64Array([
                42, 10, 10, 30,
            ])
        });

        // Create the arrow ingest
        const arrowIngest = await computeWorkerBindings.createArrowIngest();
        await arrowIngest.writeTable(t);
        const dataFrame = await arrowIngest.finish();

        const tableScan = await dataFrame.readTable();
        const results = tableScan.toArray().map(o => ({ id: o.id, score: o.score }));
        expect(results).toEqual([
            { id: 1, score: 42 },
            { id: 2, score: 10 },
            { id: 3, score: 10 },
            { id: 4, score: 30 },
        ]);
    });
});
