import { createBrowserClient } from 'hyperdb-wasm/raw';

import { createWebHyperDBClientOptions } from '../platform/hyperdb/hyperdb_provider_web.js';
import { HYPERDB_WASM_ENGINE_SETTINGS } from '../platform/hyperdb/hyperdb_settings.js';
import type { HyperDBClient } from '../platform/hyperdb/hyperdb_wasm.js';
import type { SetupProgress } from '../platform/database/embedded_database_provider.js';

/// Start an engine worker with the settings of the app, overridden by the given startup settings.
/// Tests share the client between the frames of the test files, every frame wraps it in its own HyperDBEngine.
/// A HyperDBEngine would hand out Arrow objects of the frame that created it.
export async function createTestHyperDBClient(
    onSetupProgress?: (progress: SetupProgress) => void,
    settings: Record<string, unknown> = {},
): Promise<HyperDBClient> {
    const { revoke, ...options } = createWebHyperDBClientOptions();
    let client: ReturnType<typeof createBrowserClient>;
    try {
        client = createBrowserClient({ ...options, onSetupProgress });
    } catch (error) {
        revoke();
        throw error;
    }
    const terminate = client.terminate.bind(client);
    client.terminate = async () => {
        try {
            await terminate();
        } finally {
            revoke();
        }
    };
    try {
        await client.ready();
        const result = await client.initialize(JSON.stringify({ ...HYPERDB_WASM_ENGINE_SETTINGS, ...settings }));
        if (result.state !== 'ok') {
            const detail = result.state === 'error' || result.state === 'busy' ? `: ${JSON.stringify(result.error)}` : '';
            throw new Error(`initialize HyperDB returned ${result.state}${detail}`);
        }
    } catch (error) {
        await client.terminate();
        throw error;
    }
    return client;
}

/// The engine client shared by the test dashboard, or a new one when the test file runs on its own.
export async function getTestHyperDBClient(): Promise<{ client: HyperDBClient; shared: boolean }> {
    const shared = globalThis.__DASHQL_TEST_HYPERDB_CLIENT__;
    return shared
        ? { client: await shared(), shared: true }
        : { client: await createTestHyperDBClient(), shared: false };
}
