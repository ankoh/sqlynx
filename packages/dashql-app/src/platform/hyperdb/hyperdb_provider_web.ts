import type { Logger } from '../logger/logger.js';
import { stringifyError } from '../logger/logger.js';
import type { OPFSFileImportOptions } from '../database/embedded_database.js';
import type { SetupProgress } from '../database/embedded_database_provider.js';

import { HyperDB, type HyperDBEngineClient } from './hyperdb_wasm.js';
import { HYPERDB_WASM_ENGINE_SETTINGS } from './hyperdb_settings.js';
import { getHyperDBWebSupportError } from './hyperdb_web_support.js';

declare global {
    var __DASHQL_TEST_HYPERDB_CLIENT__: ((
        onSetupProgress?: (progress: SetupProgress) => void,
    ) => Promise<HyperDBEngineClient>) | undefined;
    var __DASHQL_TEST_HYPERDB_CLIENT_PROMISE__: Promise<HyperDBEngineClient> | undefined;
    var __DASHQL_TEST_HYPERDB_CLIENT_CREATIONS__: number | undefined;
    var __DASHQL_TEST_HYPERDB_UNLOAD_INSTALLED__: boolean | undefined;
    var __DASHQL_TEST_HYPERDB_FACTORY__: ((
        context: string,
        logger: Logger,
        onSetupProgress?: (progress: SetupProgress) => void,
    ) => Promise<HyperDB>) | undefined;
}

// eslint-disable-next-line import/no-unresolved -- package asset resolved by Vite
import engineUrl from '@dashql/hyperdb-wasm-js?url';
// eslint-disable-next-line import/no-unresolved -- package asset resolved by Vite
import workerUrl from '@dashql/hyperdb-wasm-worker?url';
// eslint-disable-next-line import/no-unresolved -- package asset resolved by Vite
import workerBridgeUrl from './hyperdb_worker_bridge.js?url&no-inline';
// eslint-disable-next-line import/no-unresolved -- package asset resolved by Bazel/Vite alias
import wasmUrl from '@dashql/hyperdb-wasm?url';

const HYPERDB_ENGINE_URL = new URL(engineUrl as string, import.meta.url);
const HYPERDB_WORKER_URL = new URL(workerUrl as string, import.meta.url);
const HYPERDB_WASM_URL = new URL(wasmUrl as string, import.meta.url);

function createEngineScript(): { url: string; revoke: () => void } {
    const source = `self.HYPERDB_WASM_MODULE=self.Module??{};self.HYPERDB_WASM_MODULE.locateFile=(path,prefix)=>path==='hyperdb-wasm.wasm'?${JSON.stringify(HYPERDB_WASM_URL.href)}:prefix+path;importScripts(${JSON.stringify(HYPERDB_ENGINE_URL.href)});`;
    const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
    return { url, revoke: () => URL.revokeObjectURL(url) };
}

export async function createWebHyperDBClient(
    onSetupProgress?: (progress: SetupProgress) => void,
): Promise<HyperDBEngineClient> {
    const supportError = getHyperDBWebSupportError();
    if (supportError != null) throw new Error(supportError);

    const { BrowserWorker, HyperDBEngineClient: BrowserEngineClient } = await import('hyperdb-wasm/raw');
    const engineScript = createEngineScript();
    let client: HyperDBEngineClient;
    try {
        const bridgeUrl = new URL(workerBridgeUrl as string, import.meta.url);
        bridgeUrl.searchParams.set('workerUrl', HYPERDB_WORKER_URL.href);
        bridgeUrl.searchParams.set('engineUrl', engineScript.url);
        bridgeUrl.searchParams.set('wasmUrl', HYPERDB_WASM_URL.href);
        const worker = new Worker(bridgeUrl, { type: 'classic' });
        client = new BrowserEngineClient(new BrowserWorker(worker), onSetupProgress);
        client.importOPFSFile = (path, blob, options) => importWorkerOPFSFile(worker, path, blob, options);
        client.prepareOPFSFile = path => prepareWorkerOPFSFile(worker, path);
        client.writeOPFSFile = (path, chunk, offset) => writeWorkerOPFSFile(worker, path, chunk, offset);
        client.finishOPFSFile = path => requestWorkerFileOperation(worker, { type: 'dashql:finish-opfs-file', path });
        client.abortOPFSFile = path => requestWorkerFileOperation(worker, { type: 'dashql:abort-opfs-file', path });
        client.removeOPFSFile = path => requestWorkerFileOperation(worker, { type: 'dashql:remove-opfs-file', path });
    } catch (error) {
        engineScript.revoke();
        throw error;
    }
    const terminate = client.terminate.bind(client);
    client.terminate = async () => {
        try {
            await terminate();
        } finally {
            engineScript.revoke();
        }
    };
    return client;
}

function importWorkerOPFSFile(
    worker: Worker,
    path: string,
    blob: Blob,
    options: OPFSFileImportOptions = {},
): Promise<void> {
    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
            reject(options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
            return;
        }
        const channel = new MessageChannel();
        const finish = (error?: unknown) => {
            options.signal?.removeEventListener('abort', onAbort);
            channel.port1.close();
            if (error == null) resolve();
            else reject(error);
        };
        const onAbort = () => channel.port1.postMessage({ type: 'cancel' });
        channel.port1.addEventListener('message', event => {
            const result = event.data as { type: string; bytesWritten?: number; name?: string; error?: string };
            if (result.type === 'progress') {
                options.onProgress?.(result.bytesWritten ?? 0);
            } else if (result.type === 'done') {
                finish();
            } else if (result.type === 'error') {
                const error = result.name === 'AbortError'
                    ? new DOMException(result.error ?? 'The operation was aborted', 'AbortError')
                    : new Error(result.error ?? 'OPFS import failed');
                finish(error);
            }
        });
        channel.port1.start();
        options.signal?.addEventListener('abort', onAbort, { once: true });
        worker.postMessage({ type: 'dashql:import-opfs-file', path, blob }, [channel.port2]);
    });
}

function prepareWorkerOPFSFile(worker: Worker, path: string): Promise<void> {
    return requestWorkerFileOperation(worker, { type: 'dashql:prepare-opfs-file', path });
}

function writeWorkerOPFSFile(worker: Worker, path: string, chunk: Uint8Array, offset: number): Promise<void> {
    const bytes = chunk.slice();
    return requestWorkerFileOperation(worker, { type: 'dashql:write-opfs-file', path, bytes, offset }, [bytes.buffer]);
}

function requestWorkerFileOperation(worker: Worker, request: object, transfer: Transferable[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        channel.port1.addEventListener('message', event => {
            channel.port1.close();
            const result = event.data as { error?: unknown };
            if (result.error == null) resolve();
            else reject(new Error(String(result.error)));
        }, { once: true });
        channel.port1.start();
        worker.postMessage(request, [channel.port2, ...transfer]);
    });
}

export async function setupWebHyperDB(
    context: string,
    logger: Logger,
    onSetupProgress?: (progress: SetupProgress) => void,
): Promise<HyperDB> {
    if (globalThis.__DASHQL_TEST_HYPERDB_FACTORY__) {
        return await globalThis.__DASHQL_TEST_HYPERDB_FACTORY__(context, logger, onSetupProgress);
    }
    const initStart = performance.now();
    try {
        logger.info('Creating HyperDB WASM client', { context }, 'hyperdb');
        const client = await createWebHyperDBClient(onSetupProgress);
        try {
            const database = await HyperDB.create(
                client,
                HYPERDB_WASM_ENGINE_SETTINGS,
            );

            logger.info('Instantiated HyperDB WASM', {
                context,
                duration: Math.floor(performance.now() - initStart).toString(),
            }, 'hyperdb');
            return database;
        } catch (error) {
            await client.terminate();
            throw error;
        }
    } catch (error) {
        logger.error('Instantiating HyperDB WASM failed', {
            context,
            error: stringifyError(error),
            duration: Math.floor(performance.now() - initStart).toString(),
        }, 'hyperdb');
        throw error;
    }
}
