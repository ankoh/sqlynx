import { DashQL } from '@ankoh/dashql-core';
import { createBatchWorker } from '@ankoh/dashql-core/browser-worker';
import wasmUrl from '@ankoh/dashql-core/wasm?url';
import { describe, expect, it } from 'vitest';

const request: Parameters<DashQL['processBatch']>[0] = {
    scripts: [{ id: 'consumer', text: 'select 42;', outputs: ['scanned', 'parsed', 'analyzed'] }],
};

function checkResult(result: ReturnType<DashQL['processBatch']>): void {
    expect(result.scripts).toHaveLength(1);
    expect(result.scripts[0].id).toBe('consumer');
    expect(result.scripts[0].failure).toBeUndefined();
    for (const output of ['scanned', 'parsed', 'analyzed'] as const) {
        expect(result.scripts[0][output]).toBeInstanceOf(Uint8Array);
        expect(result.scripts[0][output]!.byteLength).toBeGreaterThan(0);
    }
}

async function loadWasm(): Promise<Uint8Array> {
    const response = await fetch(wasmUrl);
    expect(response.ok).toBe(true);
    return new Uint8Array(await response.arrayBuffer());
}

describe('Published browser consumer', () => {
    it('initializes the unmodified factory with wasmBinary', async () => {
        const core = await DashQL.create({ wasmBinary: await loadWasm() });
        try {
            checkResult(core.processBatch(request));
        } finally {
            core.resetUnsafe();
        }
    });

    it('loads the default emitted Wasm URL and processes batches through the compiled browser-worker entry', async () => {
        const worker = createBatchWorker();
        const core = await DashQL.create();
        try {
            await worker.initialize();
            expect(worker.isInitialized).toBe(true);
            const result = await worker.processBatch(request);
            checkResult(result);
            expect(result).toEqual(core.processBatch(request));
        } finally {
            worker.dispose();
            core.resetUnsafe();
        }
        expect(worker.isClosed).toBe(true);
    });
});
