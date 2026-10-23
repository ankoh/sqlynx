import * as React from 'react';

import {
    ConnectionState,
    ConnectionAction,
    ConnectionStateWithoutId,
    CATALOG_UPDATE_PARTIALLY_SUCCEEDED,
    CATALOG_UPDATE_SUCCEEDED,
    DELETE_CONNECTION,
    SWITCH_CONNECTOR_TYPE,
    reduceConnectionState,
    SET_CONNECTION_DRAFT,
    DISCARD_CONNECTION_DRAFT,
    COMMIT_CONNECTION_PARAMS,
} from './connection_state.js';
import { QUERY_PROGRESS_UPDATED, QUERY_RECEIVED_BATCH } from '../../query/query_execution_state.js';
import { Dispatch } from '../../utils/variant.js';
import { UpdateQueue, useStore, useStoreState, useUpdateQueue } from '../../utils/store.js';
import { CONNECTOR_TYPES } from './connector_info.js';
import { useStorageWriter } from '../storage/storage_provider.js';
import { useLogger } from '../../platform/logger/logger_provider.js';
import type { Logger } from '../../platform/logger/logger.js';

const LOG_CTX = 'connection_registry';
import {
    DEBOUNCE_DURATION_SESSION_WRITE,
    groupSessionFunctionWrites,
    groupSessionSchemaWrites,
    WRITE_SESSION_CATALOG_SCRIPT,
    WRITE_SESSION_FUNCTION_SCRIPT,
    WRITE_SESSION_CATALOG_CHANGES,
    groupSessionCatalogChangesWrites,
    groupConnectionEntryWrites,
    groupConnectionFileWrites,
    groupSessionConnectionCopyWrites,
    WRITE_CONNECTION_ENTRY,
    WRITE_CONNECTION_FILE,
    PATCH_SESSION_CONNECTION,
    DELETE_CONNECTION_ENTRY,
    type StorageWriter,
} from '../storage/storage_writer.js';
import { STORAGE_CATALOG_CHANGES, STORAGE_CATALOG_FUNCTIONS, STORAGE_CATALOG_RELATIONS, type ConnectionEntry, type SessionConnection } from '../storage/storage_backend.js';
import { connectionCatalogIsDurable, connectionParamsEqual, type ConnectionParams } from './connection_params.js';

/// Drafts are written to the app manifest only, edits arrive with every keystroke
export const DEBOUNCE_DURATION_CONNECTION_DRAFT_WRITE = 250;

/// The connection registry
///
/// Connections are entities of their own, keyed by the global connection
/// id. The scripts of sessions run on them, several sessions
/// may reference the same connection and then share its channel, catalog and queries.
///
/// Note that we're deliberately not using immutable maps for the connections here.
/// Following the same reasoning as with the session registry, we don't have code that
/// explicitly observes modifications of the registry map.
/// Instead, shallow-compare the entire registry object again.
export interface ConnectionRegistry {
    connections: Map<string, ConnectionState>;  // connectionId -> ConnectionState
    connectionsByType: string[][];  // arrays of databaseIds by connector type
}

/// The sessions that use the connections.
///
/// The scripts of a session own the references to their connections, the session scripts registry
/// provides them to the connection layer. A host without sessions (e.g. the shell) has no references.
export interface ConnectionReferences {
    /// The sessions with scripts on a connection, in registration order
    sessionsOf(connectionId: string): readonly string[];
    /// The connections that the scripts of a session use, the default connection first
    connectionsOf(sessionId: string): readonly string[];
    /// Subscribe to changes of the references
    subscribe(listener: () => void): () => void;
}

/// The references of a host without sessions
export const NO_CONNECTION_REFERENCES: ConnectionReferences = {
    sessionsOf: () => [],
    connectionsOf: () => [],
    subscribe: () => () => { },
};

const CONNECTION_REFERENCES_CTX = React.createContext<ConnectionReferences>(NO_CONNECTION_REFERENCES);
/// Provide the sessions that use the connections
export const ConnectionReferencesProvider = CONNECTION_REFERENCES_CTX.Provider;

/// Get the references without subscribing to their changes
export function useConnectionReferences(): ConnectionReferences {
    return React.useContext(CONNECTION_REFERENCES_CTX);
}

/// Subscribe to a slice of the references.
/// The selector must return values that keep their identity while unchanged.
export function useConnectionReferencesSelector<T>(select: (references: ConnectionReferences) => T): T {
    const references = useConnectionReferences();
    return React.useSyncExternalStore(references.subscribe, () => select(references));
}

/// The default connection and the other connections of a session
export interface ResolvedSessionConnections {
    /// The default connection
    main: ConnectionState;
    /// The other connections that scripts of the session use
    attached: ConnectionState[];
}

export function resolveSessionConnections(
    registry: Pick<ConnectionRegistry, 'connections'>,
    references: ConnectionReferences,
    sessionId: string | null,
): ResolvedSessionConnections | null {
    if (sessionId == null) return null;
    const connections = references.connectionsOf(sessionId)
        .map(connectionId => registry.connections.get(connectionId));
    if (connections.length === 0 || connections.some(database => database == null)) return null;
    const [main, ...attached] = connections as ConnectionState[];
    return { main, attached };
}

/// The default connection of a session
export function resolveDefaultConnection(
    registry: Pick<ConnectionRegistry, 'connections'>,
    references: ConnectionReferences,
    sessionId: string | null,
): ConnectionState | null {
    const connectionId = sessionId == null ? undefined : references.connectionsOf(sessionId)[0];
    return connectionId == null ? null : registry.connections.get(connectionId) ?? null;
}

/// Find the sessions that use a connection as their default connection
export function findSessionsWithDefaultConnection(references: ConnectionReferences, connectionId: string): string[] {
    return references.sessionsOf(connectionId).filter(sessionId => references.connectionsOf(sessionId)[0] === connectionId);
}

/// Is a connection listed next to the sessions?
/// Connections that sessions reference are listed, as are active connections that no session references.
export function isListedConnection(
    registry: Pick<ConnectionRegistry, 'connections'>,
    references: ConnectionReferences,
    connectionId: string,
): boolean {
    const database = registry.connections.get(connectionId);
    if (database == null) return false;
    return references.sessionsOf(connectionId).length > 0 || database.active;
}

/// Register a connection in the registry indices (mutates the registry)
export function registerConnection(registry: ConnectionRegistry, database: ConnectionState): void {
    registry.connections.set(database.connectionId, database);
    const byType = registry.connectionsByType[database.connectorInfo.connectorType];
    if (!byType.includes(database.connectionId)) byType.push(database.connectionId);
}

/// The queries a session issued on a connection, active ones first
export function findSessionQueries(database: ConnectionState, sessionId: string, includeFinished: boolean = true): number[] {
    const active = database.queriesActiveOrdered.filter(queryId => database.queriesActive.get(queryId)?.queryMetadata.sessionId === sessionId);
    if (!includeFinished) return active;
    const finished = database.queriesFinishedOrdered.filter(queryId => database.queriesFinished.get(queryId)?.queryMetadata.sessionId === sessionId);
    return [...active, ...finished];
}

/// Build the manifest entry of a connection
export function connectionEntryFromState(database: ConnectionState): ConnectionEntry {
    return {
        id: database.connectionId,
        ...(database.name == null ? {} : { name: database.name }),
        params: database.params,
        ...(database.paramsDraft == null ? {} : { paramsDraft: database.paramsDraft }),
    };
}

/// Build the copy of a connection that a session file stores
export function sessionConnectionFromState(database: ConnectionState): SessionConnection {
    return {
        connectionId: database.connectionId,
        ...(database.name == null ? {} : { name: database.name }),
        params: database.params,
    };
}

/// Did the saved params change?
export function didConnectionParamsChange(prev: ConnectionState, next: ConnectionState): boolean {
    return !connectionParamsEqual(prev.params, next.params);
}

/// Did the copy of the connection that sessions store change?
export function didSessionConnectionCopyChange(prev: ConnectionState, next: ConnectionState): boolean {
    return didConnectionParamsChange(prev, next) || prev.name !== next.name;
}

/// Did the persisted connection entry change?
export function didPersistedConnectionChange(prev: ConnectionState, next: ConnectionState): boolean {
    if (!prev.active && next.active) return true;
    return didSessionConnectionCopyChange(prev, next) || !connectionParamsEqual(prev.paramsDraft, next.paramsDraft);
}

/// Write the saved params and the name of a connection into the app manifest and into every session
/// that references it. The writes are debounced and not awaited, Save awaits them explicitly.
export function scheduleConnectionParamsWrites(references: ConnectionReferences, database: ConnectionState, storageWriter: StorageWriter): void {
    void storageWriter.write(
        groupConnectionEntryWrites(database.connectionId),
        { type: WRITE_CONNECTION_ENTRY, value: connectionEntryFromState(database) },
        DEBOUNCE_DURATION_SESSION_WRITE,
    );
    for (const sessionId of references.sessionsOf(database.connectionId)) {
        void storageWriter.write(
            groupSessionConnectionCopyWrites(sessionId, database.connectionId),
            { type: PATCH_SESSION_CONNECTION, value: [sessionId, sessionConnectionFromState(database)] },
            DEBOUNCE_DURATION_SESSION_WRITE,
        );
    }
}

export type SetConnectionRegistryAction = React.SetStateAction<ConnectionRegistry>;
export type ConnectionDispatch = (action: ConnectionAction) => void;
export type DynamicConnectionDispatch = (connectionId: string | null, action: ConnectionAction) => void;

/// A stable handle to the latest registry.
///
/// The registry changes with every query lifecycle event (including the internal SQLFrame queries of
/// computations), which re-renders every context consumer.
/// Components that only care about a small slice of the registry subscribe to the store instead.
export interface ConnectionRegistryStore {
    /// The latest registry
    current: ConnectionRegistry;
    /// Subscribe to registry changes
    subscribe: (listener: () => void) => () => void;
}

const CONNECTION_REGISTRY_CTX = React.createContext<ConnectionRegistry | null>(null);
const CONNECTION_REGISTRY_SETTER_CTX = React.createContext<Dispatch<SetConnectionRegistryAction> | null>(null);
const CONNECTION_REGISTRY_STORE_CTX = React.createContext<ConnectionRegistryStore | null>(null);
const CONNECTION_REGISTRY_QUEUE_CTX = React.createContext<UpdateQueue<ConnectionRegistry> | null>(null);

type Props = {
    children: React.ReactElement | React.ReactElement[];
};

export const ConnectionRegistry: React.FC<Props> = (props: Props) => {
    // Registry updates free Wasm objects and schedule storage writes, the store runs every update once
    const store = useStore<ConnectionRegistry>(() => ({
        connections: new Map(),
        connectionsByType: CONNECTOR_TYPES.map(() => ([])),
    }));
    const queue = useUpdateQueue(store);
    const reg = useStoreState(store);
    return (
        <CONNECTION_REGISTRY_STORE_CTX.Provider value={store}>
            <CONNECTION_REGISTRY_QUEUE_CTX.Provider value={queue}>
                <CONNECTION_REGISTRY_SETTER_CTX.Provider value={store.update}>
                    <CONNECTION_REGISTRY_CTX.Provider value={reg}>
                        {props.children}
                    </CONNECTION_REGISTRY_CTX.Provider>
                </CONNECTION_REGISTRY_SETTER_CTX.Provider>
            </CONNECTION_REGISTRY_QUEUE_CTX.Provider>
        </CONNECTION_REGISTRY_STORE_CTX.Provider>
    );
};

/// Get the registry store without subscribing to registry changes
export function useConnectionRegistryStore(): ConnectionRegistryStore {
    return React.useContext(CONNECTION_REGISTRY_STORE_CTX)!;
}

/// Subscribe to a slice of the registry.
/// The component only re-renders when the selected value changes.
/// The selector must return values that keep their identity while unchanged.
export function useConnectionRegistrySelector<T>(select: (registry: ConnectionRegistry) => T): T {
    const store = useConnectionRegistryStore();
    return React.useSyncExternalStore(store.subscribe, () => select(store.current));
}

/// Modify the registry without subscribing to registry changes
export function useConnectionRegistrySetter(): Dispatch<SetConnectionRegistryAction> {
    return React.useContext(CONNECTION_REGISTRY_SETTER_CTX)!;
}

export type ConnectionAllocator = (state: ConnectionStateWithoutId, connectionId?: string) => ConnectionState;

/// Allocate a new connection that no session references yet.
/// A session references the connection once its scripts use it.
/// Active connections are written into the app manifest right away.
export function useConnectionAllocator(): ConnectionAllocator {
    const setReg = React.useContext(CONNECTION_REGISTRY_SETTER_CTX)!;
    const storageWriter = useStorageWriter();
    return React.useCallback((state: ConnectionStateWithoutId, fixedId?: string) => {
        const connectionId = fixedId ?? crypto.randomUUID();
        const database: ConnectionState = { ...state, connectionId };
        setReg((reg) => {
            registerConnection(reg, database);
            return { ...reg };
        });
        if (database.active) {
            void storageWriter.write(
                groupConnectionEntryWrites(connectionId),
                { type: WRITE_CONNECTION_ENTRY, value: { ...connectionEntryFromState(database), createdAt: new Date().toISOString() } },
            );
        }
        return database;
    }, [setReg, storageWriter]);
}

export function useConnectionRegistry(): [ConnectionRegistry, Dispatch<SetConnectionRegistryAction>] {
    return [React.useContext(CONNECTION_REGISTRY_CTX)!, React.useContext(CONNECTION_REGISTRY_SETTER_CTX)!];
}

export function useDynamicConnectionDispatch(): [ConnectionRegistry, DynamicConnectionDispatch] {
    const registry = React.useContext(CONNECTION_REGISTRY_CTX)!;
    const dispatch = useConnectionDispatch();
    return [registry, dispatch];
}

/// Apply an action to a connection of the registry (mutates the registry)
function applyConnectionAction(reg: ConnectionRegistry, references: ConnectionReferences, connectionId: string, action: ConnectionAction, storageWriter: StorageWriter, logger: Logger): ConnectionRegistry {
    const prev = reg.connections.get(connectionId);
    if (!prev) {
        console.warn(`no connection registered with id ${connectionId}`);
        return reg;
    }
    const connectorType = prev.connectorInfo.connectorType;
    const sessionIds = references.sessionsOf(connectionId);

    // Connections outlive the sessions that reference them, but a referenced connection
    // must neither be deleted nor change its type underneath other sessions.
    if (action.type == DELETE_CONNECTION && sessionIds.length > 0) {
        logger.warn('refusing to delete a connection that sessions reference', {
            connectionId,
            sessions: sessionIds.join(','),
        }, LOG_CTX);
        return reg;
    }
    if (action.type == SWITCH_CONNECTOR_TYPE && sessionIds.length > 1) {
        logger.warn('refusing to switch the type of a shared connection', { connectionId }, LOG_CTX);
        return reg;
    }
    const next = reduceConnectionState(prev, action, logger);

    if (action.type == DELETE_CONNECTION) {
        reg.connectionsByType[connectorType] = reg.connectionsByType[connectorType].filter(id => id != connectionId);
        reg.connections.delete(connectionId);
        if (prev.active) {
            void storageWriter.write(groupConnectionEntryWrites(connectionId), { type: DELETE_CONNECTION_ENTRY, value: connectionId });
        }
        return { ...reg };
    }
    reg.connections.set(connectionId, next);
    // Update type index when connector type changes
    if (action.type == SWITCH_CONNECTOR_TYPE && next.connectorInfo.connectorType !== connectorType) {
        reg.connectionsByType[connectorType] = reg.connectionsByType[connectorType].filter(id => id != connectionId);
        reg.connectionsByType[next.connectorInfo.connectorType].push(connectionId);
    }
    // Only connections that sessions reference or that were activated are persisted.
    // Saving writes the committed params by itself and awaits the writes.
    if (sessionIds.length === 0 && !next.active) {
        return { ...reg };
    }
    if (action.type !== COMMIT_CONNECTION_PARAMS) {
        if (didSessionConnectionCopyChange(prev, next) || (!prev.active && next.active)) {
            // Saved params and the name are replicated into every session that references the connection
            scheduleConnectionParamsWrites(references, next, storageWriter);
        } else if (didPersistedConnectionChange(prev, next)) {
            // Drafts only live in the app manifest
            void storageWriter.write(
                groupConnectionEntryWrites(connectionId),
                { type: WRITE_CONNECTION_ENTRY, value: connectionEntryFromState(next) },
                DEBOUNCE_DURATION_CONNECTION_DRAFT_WRITE,
            );
        }
    }
    if (!next.active) {
        return { ...reg };
    }
    // The catalog of the connection is written into the app storage, sessions that use the
    // connection as main database keep a copy to stay self-contained.
    // The relations of a connection whose database doesn't outlive the app are never written.
    const mainOf = findSessionsWithDefaultConnection(references, connectionId);
    const durable = connectionCatalogIsDurable(next.params);
    if (action.type === CATALOG_UPDATE_SUCCEEDED || action.type === CATALOG_UPDATE_PARTIALLY_SUCCEEDED) {
        const relationsSql = next.catalogRelationScript.toString();
        const functionsSql = next.catalogFunctionScript.toString();
        if (durable) {
            void storageWriter.write(
                groupConnectionFileWrites(connectionId, STORAGE_CATALOG_RELATIONS),
                { type: WRITE_CONNECTION_FILE, value: [connectionId, STORAGE_CATALOG_RELATIONS, relationsSql] },
                DEBOUNCE_DURATION_SESSION_WRITE,
            );
        }
        void storageWriter.write(
            groupConnectionFileWrites(connectionId, STORAGE_CATALOG_FUNCTIONS),
            { type: WRITE_CONNECTION_FILE, value: [connectionId, STORAGE_CATALOG_FUNCTIONS, functionsSql] },
            DEBOUNCE_DURATION_SESSION_WRITE,
        );
        for (const sessionId of mainOf) {
            if (durable) {
                void storageWriter.write(
                    groupSessionSchemaWrites(sessionId),
                    { type: WRITE_SESSION_CATALOG_SCRIPT, value: [sessionId, next.catalogRelationScript] },
                    DEBOUNCE_DURATION_SESSION_WRITE,
                );
            }
            void storageWriter.write(
                groupSessionFunctionWrites(sessionId),
                { type: WRITE_SESSION_FUNCTION_SCRIPT, value: [sessionId, next.catalogFunctionScript] },
                DEBOUNCE_DURATION_SESSION_WRITE,
            );
        }
    }
    // Executed statements record catalog changes, a refresh clears them
    if (durable && next.catalogChangesSql !== prev.catalogChangesSql) {
        void storageWriter.write(
            groupConnectionFileWrites(connectionId, STORAGE_CATALOG_CHANGES),
            { type: WRITE_CONNECTION_FILE, value: [connectionId, STORAGE_CATALOG_CHANGES, next.catalogChangesSql] },
            DEBOUNCE_DURATION_SESSION_WRITE,
        );
        for (const sessionId of mainOf) {
            void storageWriter.write(
                groupSessionCatalogChangesWrites(sessionId),
                { type: WRITE_SESSION_CATALOG_CHANGES, value: [sessionId, next.catalogChangesSql] },
                DEBOUNCE_DURATION_SESSION_WRITE,
            );
        }
    }
    return { ...reg };
}

/// Dispatch actions to connections without subscribing to registry changes.
/// The dispatches of all components are applied in order through the queue of the registry.
export function useConnectionDispatch(): DynamicConnectionDispatch {
    const queue = React.useContext(CONNECTION_REGISTRY_QUEUE_CTX)!;
    const references = useConnectionReferences();
    const storageWriter = useStorageWriter();
    const logger = useLogger();
    return React.useCallback((connectionId: string | null, action: ConnectionAction) => {
        // No id provided? Then do nothing.
        if (connectionId == null) {
            return;
        }
        // Query execution may happen in a worker or remotely, but Arrow batch decoding and these
        // state updates happen on the renderer thread. A fast result stream can therefore enqueue
        // a microtask cascade that repeatedly rerenders the session before the browser gets a
        // frame to paint. Publish only the latest streamed progress once per frame; lifecycle
        // actions stay immediate and flush queued stream updates first to preserve action order.
        const waitForFrame = action.type === QUERY_PROGRESS_UPDATED || action.type === QUERY_RECEIVED_BATCH;
        queue.push(reg => applyConnectionAction(reg, references, connectionId, action, storageWriter, logger), waitForFrame);
    }, [queue, references, storageWriter, logger]);
}

/// The default connection of a session, new scripts of the session use it
export function useDefaultConnection(sessionId: string | null): [ConnectionState | null, ConnectionDispatch] {
    const [registry, dispatch] = useDynamicConnectionDispatch();
    const connectionId = useConnectionReferencesSelector(references => sessionId == null ? null : references.connectionsOf(sessionId)[0] ?? null);
    const capturingDispatch = React.useCallback((action: ConnectionAction) => dispatch(connectionId, action), [connectionId, dispatch]);
    return [connectionId == null ? null : (registry.connections.get(connectionId) ?? null), capturingDispatch]
}

/// The connections that the scripts of a session use
export function useSessionConnections(sessionId: string | null): ResolvedSessionConnections | null {
    const [registry] = useConnectionRegistry();
    const references = useConnectionReferences();
    // Re-render when the session uses other connections
    useConnectionReferencesSelector(references => sessionId == null ? '' : references.connectionsOf(sessionId).join('\n'));
    return resolveSessionConnections(registry, references, sessionId);
}

export function useConnectionById(connectionId: string | null): [ConnectionState | null, ConnectionDispatch] {
    const [registry, dispatch] = useDynamicConnectionDispatch();
    const capturingDispatch = React.useCallback((action: ConnectionAction) => dispatch(connectionId, action), [connectionId, dispatch]);
    return [connectionId == null ? null : registry.connections.get(connectionId) ?? null, capturingDispatch];
}

/// Editing dispatches immediately; the registry debounces only the durable manifest write.
export function useConnectionDraft(connectionId: string | null) {
    const [database, dispatch] = useConnectionById(connectionId);
    const setDraft = React.useCallback((params: ConnectionParams) => {
        dispatch({ type: SET_CONNECTION_DRAFT, value: params });
    }, [dispatch]);
    const discard = React.useCallback(() => {
        dispatch({ type: DISCARD_CONNECTION_DRAFT, value: null });
    }, [dispatch]);
    return { params: database?.params ?? null, paramsDraft: database?.paramsDraft, setDraft, discard };
}

/// Forms write from user actions, never from hydration effects (which could resurrect a draft).
export function useConnectionDraftForm<T>(
    connectionId: string | null,
    decode: (params: ConnectionParams | null) => T,
    encode: (form: T) => ConnectionParams,
): [T, React.Dispatch<React.SetStateAction<T>>] {
    const { params, paramsDraft, setDraft } = useConnectionDraft(connectionId);
    const source = paramsDraft ?? params;
    const [form, setForm] = React.useState(() => decode(source));
    const sourceRef = React.useRef(source);
    const formRef = React.useRef(form);
    const databaseIdRef = React.useRef(connectionId);
    const editedParamsRef = React.useRef<ConnectionParams | undefined>(undefined);
    if (databaseIdRef.current !== connectionId || sourceRef.current !== source) {
        const ownEdit = databaseIdRef.current === connectionId && paramsDraft != null
            && connectionParamsEqual(editedParamsRef.current, paramsDraft);
        databaseIdRef.current = connectionId;
        sourceRef.current = source;
        if (!ownEdit) {
            editedParamsRef.current = undefined;
            formRef.current = decode(source);
            setForm(formRef.current);
        }
    }
    const update = (value: React.SetStateAction<T>) => {
        const next = typeof value === 'function' ? (value as (prev: T) => T)(formRef.current) : value;
        formRef.current = next;
        setForm(next);
        const encoded = encode(next);
        editedParamsRef.current = encoded;
        setDraft(encoded);
    };
    return [formRef.current, update];
}
