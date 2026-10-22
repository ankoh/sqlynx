import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DashQLCoreProvider, useDashQLCoreSetup, type DashQLCoreSetupOptions, type DashQLSetupFn } from './core_provider.js';
import { DashQL } from '@ankoh/dashql-core';
import type { BatchWorkerRequest, BatchWorkerResponse } from '@ankoh/dashql-core/browser-worker';
import { TracedLogger } from '../../platform/logger/logger.js';
import { LoggerProvider } from '../../platform/logger/logger_provider.js';
import { initializeCatalogBatchWorker } from '../connections/catalog_batch.js';

class TestWorker extends EventTarget {
    readonly requests: BatchWorkerRequest[] = [];
    readonly terminate = vi.fn();
    readonly postMessage = vi.fn((message: BatchWorkerRequest) => { this.requests.push(message); });

    respond(response: BatchWorkerResponse): void {
        this.dispatchEvent(new MessageEvent('message', { data: response }));
    }
}

describe('DashQLCoreProvider initial setup', () => {
    let container: HTMLDivElement;
    let root: Root | null;
    let core: DashQL;
    let setup: DashQLSetupFn;
    const workers: TestWorker[] = [];
    const createWorker = vi.fn(function () {
        const worker = new TestWorker();
        workers.push(worker);
        return worker;
    });

    function CaptureSetup() {
        setup = useDashQLCoreSetup();
        return null;
    }

    async function render(initialSetup?: DashQLCoreSetupOptions) {
        await act(async () => root!.render(React.createElement(LoggerProvider, null,
            React.createElement(DashQLCoreProvider, {
                initialSetup,
                children: React.createElement(CaptureSetup),
            }),
        )));
    }

    function startSetup(context = 'test'): Promise<DashQL> {
        const pending = setup(context);
        // Keep cleanup rejections handled even if an assertion fails before awaiting setup.
        void pending.catch(() => {});
        return pending;
    }

    async function unmount() {
        await act(async () => {
            root?.unmount();
            root = null;
        });
    }

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        // Only object identity is needed by the real batch-worker lifecycle. Never retire
        // the browser dashboard's shared Core instance during provider cleanup.
        core = Object.create(DashQL.prototype) as DashQL;
        workers.length = 0;
        createWorker.mockClear();
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('Worker', createWorker);
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new Uint8Array([0])));
        vi.spyOn(DashQL, 'create').mockResolvedValue(core);
    });

    afterEach(async () => {
        try {
            await unmount();
        } finally {
            container.remove();
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
        }
    });

    it('does not set up a batch worker when disabled', async () => {
        await render({ setupBatchWorker: false });
        expect(DashQL.create).not.toHaveBeenCalled();
        expect(createWorker).not.toHaveBeenCalled();

        await act(async () => {
            expect(await startSetup()).toBe(core);
            expect(await startSetup('second caller')).toBe(core);
        });

        expect(DashQL.create).toHaveBeenCalledTimes(1);
        expect(createWorker).not.toHaveBeenCalled();
    });

    it('awaits eager warmup and reuses the core and initialized worker', async () => {
        await render({ setupBatchWorker: true });
        expect(DashQL.create).not.toHaveBeenCalled();
        expect(createWorker).not.toHaveBeenCalled();
        const settled = vi.fn();
        const first = startSetup();
        void first.then(() => settled(), () => {});
        const second = startSetup('concurrent caller');
        await act(async () => {
            await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1));
        });
        expect(DashQL.create).toHaveBeenCalledTimes(1);
        expect(workers[0].requests[0].request).toEqual({ scripts: [] });
        expect(settled).not.toHaveBeenCalled();

        await act(async () => {
            workers[0].respond({ requestId: workers[0].requests[0].requestId, result: { scripts: [] } });
            expect(await first).toBe(core);
            expect(await second).toBe(core);
            expect(await startSetup('later caller')).toBe(core);
            await initializeCatalogBatchWorker(core);
        });
        expect(settled).toHaveBeenCalledTimes(1);
        expect(DashQL.create).toHaveBeenCalledTimes(1);
        expect(createWorker).toHaveBeenCalledTimes(1);
        expect(workers[0].requests).toHaveLength(1);
        expect(workers[0].terminate).not.toHaveBeenCalled();
        await unmount();
        expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    });

    it('rejects and terminates pending eager warmup on unmount', async () => {
        const warn = vi.spyOn(TracedLogger.prototype, 'warn');
        await render({ setupBatchWorker: true });
        const pending = startSetup();
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await act(async () => {
            await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1));
        });

        await unmount();
        await rejected;
        expect(workers[0].terminate).toHaveBeenCalledTimes(1);
        expect(warn).not.toHaveBeenCalled();
        await expect(setup('after unmount')).rejects.toMatchObject({ name: 'AbortError' });
        await expect(initializeCatalogBatchWorker(core)).rejects.toMatchObject({ name: 'AbortError' });
        expect(createWorker).toHaveBeenCalledTimes(1);
    });

    it('rejects a main core instantiation completed after unmount without starting warmup', async () => {
        let resolveCore!: (instance: DashQL) => void;
        vi.mocked(DashQL.create).mockImplementationOnce(() => new Promise(resolve => { resolveCore = resolve; }));
        await render({ setupBatchWorker: true });
        const pending = startSetup();
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await act(async () => {
            await vi.waitFor(() => expect(DashQL.create).toHaveBeenCalledTimes(1));
        });

        await unmount();
        resolveCore(core);
        await rejected;
        expect(createWorker).not.toHaveBeenCalled();
    });

    it('fails setup and terminates the worker when initialization fails', async () => {
        const error = vi.spyOn(TracedLogger.prototype, 'error');
        await render({ setupBatchWorker: true });
        const pending = startSetup();
        const rejected = expect(pending).rejects.toThrow('warmup failed');
        await act(async () => {
            await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1));
            workers[0].respond({ requestId: workers[0].requests[0].requestId, error: 'warmup failed' });
            await rejected;
        });
        expect(error).toHaveBeenCalled();
        expect(workers[0].terminate).toHaveBeenCalledTimes(1);
        await expect(initializeCatalogBatchWorker(core)).rejects.toMatchObject({ name: 'AbortError' });
        expect(DashQL.create).toHaveBeenCalledTimes(1);
        expect(createWorker).toHaveBeenCalledTimes(1);
        expect(workers[0].requests).toHaveLength(1);
    });
});
