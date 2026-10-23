import type { Logger } from '../logger/logger.js';
import { stringifyError } from '../logger/logger.js';
import type { SetupProgress } from '../database/embedded_database_provider.js';

import { HyperDB, HyperDBEngine, type HyperDBClient, type HyperDBSettings } from './hyperdb_wasm.js';
import { HYPERDB_WASM_ENGINE_SETTINGS } from './hyperdb_settings.js';
import { cleanupStaleHyperDBOPFSInstances, createHyperDBOPFSInstance } from './hyperdb_opfs_instance.js';
import { getHyperDBWebSupportError } from './hyperdb_web_support.js';

declare global {
    var __DASHQL_TEST_HYPERDB_CLIENT__: ((
        onSetupProgress?: (progress: SetupProgress) => void,
    ) => Promise<HyperDBClient>) | undefined;
    var __DASHQL_TEST_HYPERDB_CLIENT_PROMISE__: Promise<HyperDBClient> | undefined;
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

/// The worker options of a browser engine client.
/// The engine script is an object URL that must be revoked once the engine terminated.
export function createWebHyperDBClientOptions(): { workerUrl: URL; engineUrl: string; wasmUrl: URL; revoke: () => void } {
    const supportError = getHyperDBWebSupportError();
    if (supportError != null) throw new Error(supportError);
    const engineScript = createEngineScript();
    const workerUrl = new URL(workerBridgeUrl as string, import.meta.url);
    workerUrl.searchParams.set('workerUrl', HYPERDB_WORKER_URL.href);
    return { workerUrl, engineUrl: engineScript.url, wasmUrl: HYPERDB_WASM_URL, revoke: engineScript.revoke };
}

/// Start a HyperDB engine in a browser worker.
async function createWebHyperDBEngine(
    settings: HyperDBSettings,
    onSetupProgress?: (progress: SetupProgress) => void,
): Promise<HyperDBEngine> {
    const { revoke, ...options } = createWebHyperDBClientOptions();
    let engine: HyperDBEngine;
    try {
        engine = await HyperDBEngine.create({ ...options, onSetupProgress, settings });
    } catch (error) {
        revoke();
        throw error;
    }
    const terminate = engine.terminate.bind(engine);
    engine.terminate = async () => {
        try {
            await terminate();
        } finally {
            revoke();
        }
    };
    return engine;
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
        logger.info('Creating HyperDB WASM engine', { context }, 'hyperdb');
        await cleanupStaleHyperDBOPFSInstances();
        const instance = await createHyperDBOPFSInstance();
        let engine: HyperDBEngine | null = null;
        try {
            engine = await createWebHyperDBEngine(
                { ...HYPERDB_WASM_ENGINE_SETTINGS, log_file_path: instance.logDirectoryPath },
                onSetupProgress,
            );
            const database = await HyperDB.create(engine, {
                computeDatabasePath: instance.computeDatabasePath,
                defaultDatabasePath: instance.userDatabasePath,
            });
            const terminate = database.terminate.bind(database);
            database.terminate = async () => {
                await terminate();
                await instance.dispose();
            };

            logger.info('Instantiated HyperDB WASM', {
                context,
                duration: Math.floor(performance.now() - initStart).toString(),
            }, 'hyperdb');
            return database;
        } catch (error) {
            try {
                await engine?.terminate();
                await instance.dispose();
            } catch (cleanupError) {
                logger.warn('Cleaning up failed HyperDB setup failed', {
                    context,
                    error: stringifyError(cleanupError),
                }, 'hyperdb');
            }
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
