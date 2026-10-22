import * as React from 'react';

import type { Logger } from '../../platform/logger/logger.js';
import { stringifyError } from '../../platform/logger/logger.js';
import type { DynamicAttachedDatabaseDispatch } from '../connections/attached_database_registry.js';
import { ConnectionHealth, type AttachedDatabaseState } from '../connections/attached_database_state.js';
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
    database: AttachedDatabaseState | null,
    setup: HyperSetupApi | null,
    dispatch: DynamicAttachedDatabaseDispatch,
    logger: Logger,
): void {
    const considered = React.useRef(new Set<string>());
    const attempts = React.useRef(new Map<string, AbortController>());
    React.useEffect(() => {
        if (sessionId == null || database == null || setup == null) return;
        if (considered.current.has(database.databaseId)) return;
        // Consume the initial selection even when online, cancelled, or carrying a draft.
        // Later resets, draft discards, and session switches must not opt back into setup.
        considered.current.add(database.databaseId);
        const params = database.params;
        if (database.connectionHealth !== ConnectionHealth.NOT_STARTED
            || database.paramsDraft != null
            || !('hyper' in params)
            || params.hyper.protocol !== 'WASM') return;
        const abort = new AbortController();
        attempts.current.set(database.databaseId, abort);
        startupAttempts.set(database.databaseId, abort);
        const unregister = registerConnectionSetup(database.databaseId, abort);
        void setup.setup(
            action => dispatch(database.databaseId, action),
            structuredClone(params.hyper) as Parameters<HyperSetupApi['setup']>[1],
            abort.signal,
        ).catch(error => {
            if (!abort.signal.aborted) logger.warn('Memory database setup failed', {
                sessionId, error: stringifyError(error),
            }, 'app_loader');
        }).finally(() => {
            unregister();
            attempts.current.delete(database.databaseId);
            if (startupAttempts.get(database.databaseId) === abort) startupAttempts.delete(database.databaseId);
        });
    }, [database, dispatch, logger, sessionId, setup]);
    React.useEffect(() => () => {
        for (const [databaseId, abort] of attempts.current) {
            abort.abort(new DOMException('App loader unmounted', 'AbortError'));
            if (startupAttempts.get(databaseId) === abort) startupAttempts.delete(databaseId);
        }
    }, []);
}
