import * as React from 'react';

import { useStorageWriter } from '../storage/storage_provider.js';
import {
    groupConnectionEntryWrites,
    groupSessionConnectionCopyWrites,
    PATCH_SESSION_CONNECTION,
    WRITE_CONNECTION_ENTRY,
    type StorageWriteResult,
} from '../storage/storage_writer.js';
import { COMMIT_CONNECTION_PARAMS } from './attached_database_state.js';
import {
    findSessionsForAttachedDatabase,
    useAttachedDatabaseDispatch,
    useAttachedDatabaseRegistryStore,
} from './attached_database_registry.js';
import { connectionParamsWithoutDraftRows, type ConnectionParams } from './connection_params.js';

/// The outcome of writing a session's copy of the connection params
export interface SessionCopySaveResult {
    /// The session
    sessionId: string;
    /// The outcome of the write
    result: StorageWriteResult;
}

/// The outcome of saving a connection
export interface ConnectionSaveResult {
    /// The saved params
    params: ConnectionParams;
    /// The outcome of writing the app manifest, the connection is saved if it was written
    manifest: StorageWriteResult;
    /// The outcomes of writing the copies in the sessions that reference the connection
    sessions: SessionCopySaveResult[];
}

/// Did saving persist the connection everywhere?
export function connectionSaveSucceeded(result: ConnectionSaveResult): boolean {
    return result.manifest.status === 'written' && result.sessions.every(n => n.result.status === 'written');
}

/// The sessions whose copies were not written
export function failedSessionCopies(result: ConnectionSaveResult): SessionCopySaveResult[] {
    return result.sessions.filter(n => n.result.status !== 'written');
}

/// The state of saving a connection
export interface ConnectionSaveState {
    /// Is the connection being saved?
    saving: boolean;
    /// The outcome of the last save, if any
    result: ConnectionSaveResult | null;
}

/// The API to save connections
interface ConnectionPersistence {
    /// The save states of connections (connectionId -> state)
    states: Map<string, ConnectionSaveState>;
    /// Save the draft of a connection
    save: (connectionId: string) => Promise<ConnectionSaveResult>;
    /// Write the copies of sessions again
    retry: (connectionId: string, sessionIds: string[]) => Promise<ConnectionSaveResult | null>;
}

const CONNECTION_PERSISTENCE_CTX = React.createContext<ConnectionPersistence | null>(null);

const IDLE_SAVE_STATE: ConnectionSaveState = { saving: false, result: null };

/// Saves connections.
///
/// The app manifest is the source of truth for connections, every session that references a
/// connection keeps a copy of its params. Saving writes the manifest first and the copies after, so a
/// partial failure heals forward: the next load rewrites stale copies from the manifest.
export const ConnectionPersistenceProvider: React.FC<{ children: React.ReactElement }> = (props) => {
    const storageWriter = useStorageWriter();
    const registryStore = useAttachedDatabaseRegistryStore();
    const dispatch = useAttachedDatabaseDispatch();
    const [states, setStates] = React.useState(() => new Map<string, ConnectionSaveState>());

    const setState = React.useCallback((connectionId: string, state: ConnectionSaveState) => {
        setStates(prev => new Map(prev).set(connectionId, state));
    }, []);

    const writeSessionCopies = React.useCallback(async (connectionId: string, sessionIds: string[], params: ConnectionParams) => {
        return await Promise.all(sessionIds.map(async sessionId => ({
            sessionId,
            result: await storageWriter.writeDurable(
                groupSessionConnectionCopyWrites(sessionId, connectionId),
                { type: PATCH_SESSION_CONNECTION, value: [sessionId, connectionId, params] },
            ),
        })));
    }, [storageWriter]);

    const save = React.useCallback(async (connectionId: string): Promise<ConnectionSaveResult> => {
        const connection = registryStore.current.attachedDatabases.get(connectionId);
        if (connection == null) {
            throw new Error(`no connection registered with id ${connectionId}`);
        }
        const params = connectionParamsWithoutDraftRows(connection.paramsDraft ?? connection.params);
        setState(connectionId, { saving: true, result: null });
        try {
            // Write the source of truth first, the same key replaces pending draft writes
            const manifest = await storageWriter.writeDurable(
                groupConnectionEntryWrites(connectionId),
                { type: WRITE_CONNECTION_ENTRY, value: { id: connectionId, params } },
            );
            if (manifest.status !== 'written') {
                const result: ConnectionSaveResult = { params, manifest, sessions: [] };
                setState(connectionId, { saving: false, result });
                return result;
            }
            dispatch(connectionId, { type: COMMIT_CONNECTION_PARAMS, value: params });
            const sessionIds = findSessionsForAttachedDatabase(registryStore.current, connectionId);
            const result: ConnectionSaveResult = { params, manifest, sessions: await writeSessionCopies(connectionId, sessionIds, params) };
            setState(connectionId, { saving: false, result });
            return result;
        } catch (error) {
            const result: ConnectionSaveResult = { params, manifest: { status: 'failed', error }, sessions: [] };
            setState(connectionId, { saving: false, result });
            return result;
        }
    }, [dispatch, registryStore, setState, storageWriter, writeSessionCopies]);

    const retry = React.useCallback(async (connectionId: string, sessionIds: string[]): Promise<ConnectionSaveResult | null> => {
        const last = states.get(connectionId)?.result;
        if (last == null || last.manifest.status !== 'written') return null;
        setState(connectionId, { saving: true, result: last });
        const retried = await writeSessionCopies(connectionId, sessionIds, last.params);
        const bySession = new Map(retried.map(r => [r.sessionId, r]));
        const result: ConnectionSaveResult = {
            ...last,
            sessions: last.sessions.map(n => bySession.get(n.sessionId) ?? n),
        };
        setState(connectionId, { saving: false, result });
        return result;
    }, [setState, states, writeSessionCopies]);

    const value = React.useMemo(() => ({ states, save, retry }), [states, save, retry]);
    return (
        <CONNECTION_PERSISTENCE_CTX.Provider value={value}>
            {props.children}
        </CONNECTION_PERSISTENCE_CTX.Provider>
    );
};

/// Save a connection and observe the save state
export function useConnectionSave(connectionId: string | null) {
    const persistence = React.useContext(CONNECTION_PERSISTENCE_CTX);
    const state = (connectionId == null ? null : persistence?.states.get(connectionId)) ?? IDLE_SAVE_STATE;
    const save = React.useCallback(async (): Promise<ConnectionSaveResult | null> => {
        if (connectionId == null || persistence == null) return null;
        return await persistence.save(connectionId);
    }, [connectionId, persistence]);
    const retry = React.useCallback(async (sessionIds: string[]): Promise<ConnectionSaveResult | null> => {
        if (connectionId == null || persistence == null) return null;
        return await persistence.retry(connectionId, sessionIds);
    }, [connectionId, persistence]);
    return { ...state, save, retry };
}

/// Save the draft of a connection before connecting with it.
/// Resolves false if the connection must not be set up because the draft could not be saved.
export function useSaveBeforeConnect(connectionId: string | null): () => Promise<boolean> {
    const persistence = React.useContext(CONNECTION_PERSISTENCE_CTX);
    const registryStore = useAttachedDatabaseRegistryStore();
    return React.useCallback(async () => {
        if (connectionId == null || persistence == null) return true;
        const connection = registryStore.current.attachedDatabases.get(connectionId);
        if (connection?.paramsDraft == null) return true;
        const result = await persistence.save(connectionId);
        return result.manifest.status === 'written';
    }, [connectionId, persistence, registryStore]);
}
