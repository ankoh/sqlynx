import * as flatbuffers from 'flatbuffers';
import { loadCoreWasm } from './test_fixture.js';
import { describe, expect, it, vi } from 'vitest';

import * as buffers from './buffers.js';
import { DashQL } from './api.js';
import { createBatchWorker, DashQLBatchWorker } from './batch_worker_client.js';
import type { BatchRequest } from './batch.js';
import type { BatchWorkerRequest, BatchWorkerResponse } from './batch_worker_protocol.js';

class TestWorker extends EventTarget {
    readonly requests: BatchWorkerRequest[] = [];
    readonly terminate = vi.fn();
    readonly postMessage = vi.fn((message: BatchWorkerRequest) => { this.requests.push(message); });

    respond(response: BatchWorkerResponse): void {
        this.dispatchEvent(new MessageEvent('message', { data: response }));
    }
}

const request: BatchRequest = { scripts: [{ id: 'query', text: 'select 1', outputs: ['parsed'] }] };

describe('Core batch worker transport', () => {
    it('initializes once and reuses the ready worker for subsequent batches', async () => {
        const worker = new TestWorker();
        const client = new DashQLBatchWorker(worker as unknown as Worker);
        const initialization = client.initialize();
        expect(client.initialize()).toBe(initialization);
        expect(worker.requests).toHaveLength(1);
        expect(worker.requests[0].request).toEqual({ scripts: [] });
        worker.respond({ requestId: worker.requests[0].requestId, result: { scripts: [] } });
        await initialization;
        await client.initialize();
        expect(worker.requests).toHaveLength(1);
        const batch = client.processBatch(request);
        worker.respond({ requestId: worker.requests[1].requestId, result: { scripts: [] } });
        await batch;
        client.dispose();
        await expect(client.initialize()).rejects.toThrow('disposed');
    });

    it('retries failed initialization without replacing a healthy transport', async () => {
        const worker = new TestWorker();
        const client = new DashQLBatchWorker(worker as unknown as Worker);
        const initialization = client.initialize();
        const failure = expect(initialization).rejects.toThrow('initialization failed');
        worker.respond({ requestId: worker.requests[0].requestId, error: 'initialization failed' });
        await failure;
        const retry = client.initialize();
        worker.respond({ requestId: worker.requests[1].requestId, result: { scripts: [] } });
        await retry;
        expect(client.isClosed).toBe(false);
        client.dispose();
    });

    it('rejects initialization when disposed before readiness', async () => {
        const worker = new TestWorker();
        const client = new DashQLBatchWorker(worker as unknown as Worker);
        const initialization = client.initialize();
        client.dispose();
        await expect(initialization).rejects.toThrow('disposed');
        expect(worker.terminate).toHaveBeenCalledTimes(1);
    });

    it('correlates out-of-order replies and retains caller context bytes', async () => {
        const worker = new TestWorker();
        const client = new DashQLBatchWorker(worker as unknown as Worker);
        const context = new Uint8Array([1, 2, 3]);
        const first = client.processBatch({ ...request, catalogDescriptors: [context] });
        const second = client.processBatch(request);
        expect(worker.postMessage.mock.calls[0].length).toBe(1);
        expect(context.byteLength).toBe(3);
        worker.respond({ requestId: worker.requests[1].requestId, result: { scripts: [] } });
        worker.respond({ requestId: worker.requests[0].requestId, result: { scripts: [{ id: 'first', diagnostics: [] }] } });
        expect((await first).scripts[0].id).toBe('first');
        expect((await second).scripts).toEqual([]);
        client.dispose();
    });

    it('rejects a failed job without closing the transport', async () => {
        const worker = new TestWorker();
        const client = new DashQLBatchWorker(worker as unknown as Worker);
        const first = client.processBatch(request);
        const rejected = expect(first).rejects.toThrow('invalid request');
        worker.respond({ requestId: worker.requests[0].requestId, error: 'invalid request' });
        await rejected;
        const second = client.processBatch(request);
        worker.respond({ requestId: worker.requests[1].requestId, result: { scripts: [] } });
        expect(await second).toEqual({ scripts: [] });
        client.dispose();
    });

    it.each(['error', 'messageerror', 'dispose'])('settles all outstanding requests on %s', async failure => {
        const worker = new TestWorker();
        const client = new DashQLBatchWorker(worker as unknown as Worker);
        const outcomes = [client.processBatch(request), client.processBatch(request)].map(promise =>
            promise.then(() => 'resolved', error => (error as Error).message)
        );
        if (failure === 'dispose') client.dispose();
        else worker.dispatchEvent(new Event(failure));
        const results = await Promise.all(outcomes);
        expect(results.every(result => result.includes('worker'))).toBe(true);
        await expect(client.processBatch(request)).rejects.toThrow('worker');
        client.dispose();
        expect(worker.terminate).toHaveBeenCalledTimes(1);
    });

    it('rejects an uncloneable request without stranding later requests', async () => {
        const worker = new TestWorker();
        const client = new DashQLBatchWorker(worker as unknown as Worker);
        worker.postMessage.mockImplementationOnce(() => { throw new DOMException('not cloneable', 'DataCloneError'); });
        await expect(client.processBatch(request)).rejects.toThrow('not cloneable');
        const next = client.processBatch(request);
        worker.respond({ requestId: worker.requests[0].requestId, result: { scripts: [] } });
        await next;
        client.dispose();
    });
});

describe('Core batch worker integration', () => {
    const browserIt = typeof Worker === 'undefined' ? it.skip : it;
    browserIt('matches synchronous outputs, imports descriptors, and has no cross-job catalog state', async () => {
        const core = await DashQL.create({ wasmBinary: await loadCoreWasm() });
        const worker = createBatchWorker();
        const batch: BatchRequest = { scripts: [{
            id: 'schema',
            text: 'create table db.sch.items(id int); create function db.sch.item_count() returns bigint;',
            outputs: ['scanned', 'parsed', 'analyzed', 'catalogDescriptor'],
        }] };
        const catalog = core.createCatalog();
        try {
            await worker.initialize();
            const expected = core.processBatch(batch);
            const result = await worker.processBatch(batch);
            // The test dashboard's local Core lives in the parent realm; compare
            // bytes rather than typed-array prototypes from different windows.
            expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
            const descriptor = result.scripts[0].catalogDescriptor!;
            const id = catalog.allocateEntryId();
            catalog.replaceDescriptor(id, 0, descriptor);
            expect(catalog.createSnapshot().read().catalogReader.tablesLength()).toBe(1);

            const query: BatchRequest = { scripts: [{ id: 'query', text: 'select id from db.sch.items', outputs: ['analyzed'] }] };
            const contextual = await worker.processBatch({ ...query, catalogDescriptors: [descriptor] });
            const independent = await worker.processBatch(query);
            const read = (bytes: Uint8Array) => buffers.analyzer.AnalyzedScript.getRootAsAnalyzedScript(new flatbuffers.ByteBuffer(bytes));
            expect(read(contextual.scripts[0].analyzed!).tableReferences(0)!.resolvedTable()).not.toBeNull();
            expect(read(independent.scripts[0].analyzed!).tableReferences(0)!.resolvedTable()).toBeNull();
            expect(descriptor.byteLength).toBeGreaterThan(0);
        } finally {
            worker.dispose();
            catalog.destroy();
        }
    });
});
