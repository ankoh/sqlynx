import * as React from 'react';

import type { Logger } from '../../platform/logger/logger.js';
import { stringifyError } from '../../platform/logger/logger.js';
import type { DynamicConnectionDispatch } from '../connections/connection_registry.js';
import { ConnectionHealth, type ConnectionState } from '../connections/connection_state.js';
import type { HyperSetupApi } from '../connections/hyper/hyper_connection_setup.js';
import { cancelConnectionSetup, registerConnectionSetup } from '../connections/connection_setup_cancellation.js';

const startupAttempts = new Map<string, AbortController>();

// Settings can cancel the loader-owned attempt without creating a second setup controller.
export function cancelInitialMemorySetup(databaseId: string): boolean {
    const abort = startupAttempts.get(databaseId);
    if (abort == null) return false;
    cancelConnectionSetup(databaseId);
    return true;
}

export function useInitialMemorySetup(
    sessionId: string | null,
    database: ConnectionState | null,
    setup: HyperSetupApi | null,
    dispatch: DynamicConnectionDispatch,
    logger: Logger,
): void {
    const considered = React.useRef(new Set<string>());
    const attempts = React.useRef(new Map<string, AbortController>());
    React.useEffect(() => {
        if (sessionId == null || database == null || setup == null) return;
        if (considered.current.has(database.connectionId)) return;
        // Consume the initial selection even when online, cancelled, or carrying a draft.
        // Later resets, draft discards, and session switches must not opt back into setup.
        considered.current.add(database.connectionId);
        const params = database.params;
        if (database.connectionHealth !== ConnectionHealth.NOT_STARTED
            || database.paramsDraft != null
            || !('hyper' in params)
            || params.hyper.protocol !== 'WASM') return;
        const abort = new AbortController();
        attempts.current.set(database.connectionId, abort);
        startupAttempts.set(database.connectionId, abort);
        const unregister = registerConnectionSetup(database.connectionId, abort);
        void setup.setup(
            action => dispatch(database.connectionId, action),
            structuredClone(params.hyper) as Parameters<HyperSetupApi['setup']>[1],
            abort.signal,
        ).catch(error => {
            if (!abort.signal.aborted) logger.warn('Memory database setup failed', {
                sessionId, error: stringifyError(error),
            }, 'app_loader');
        }).finally(() => {
            unregister();
            attempts.current.delete(database.connectionId);
            if (startupAttempts.get(database.connectionId) === abort) startupAttempts.delete(database.connectionId);
        });
    }, [database, dispatch, logger, sessionId, setup]);
    React.useEffect(() => () => {
        for (const [databaseId, abort] of attempts.current) {
            abort.abort(new DOMException('App loader unmounted', 'AbortError'));
            if (startupAttempts.get(databaseId) === abort) startupAttempts.delete(databaseId);
        }
    }, []);
}
