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
import { CONNECTOR_TYPES } from './connector_info.js';
import { ConnectionSignatureMap } from './connection_signature.js';
import { useStorageWriter } from '../storage/storage_provider.js';
import { useLogger } from '../../platform/logger/logger_provider.js';

const LOG_CTX = 'attached_database_registry';
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
import { STORAGE_CATALOG_CHANGES, STORAGE_CATALOG_FUNCTIONS, STORAGE_CATALOG_RELATIONS, type AttachedDatabase, type ConnectionEntry } from '../storage/storage_backend.js';
import { connectionParamsEqual, type ConnectionParams } from './connection_params.js';

/// Drafts are written to the app manifest only, edits arrive with every keystroke
export const DEBOUNCE_DURATION_CONNECTION_DRAFT_WRITE = 250;

/// The connection registry
///
/// Connections (attached database states) are entities of their own, keyed by the global connection
/// id. Sessions reference them as their main database or as attached databases, several sessions
/// may reference the same connection and then share its channel, catalog and queries.
///
/// Note that we're deliberately not using immutable maps for the connections here.
/// Following the same reasoning as with the session registry, we don't have code that
/// explicitly observes modifications of the registry map.
/// Instead, shallow-compare the entire registry object again.
export interface ConnectionRegistry {
    connections: Map<string, ConnectionState>;  // connectionId -> ConnectionState
    attachedDatabasesBySession: Map<string, SessionAttachedDatabases>;
    connectionsByType: string[][];  // arrays of databaseIds by connector type
    connectionsBySignature: ConnectionSignatureMap;
}

export interface SessionAttachedDatabases {
    mainDatabaseId: string;
    attachedDatabaseIds: string[];
}

export interface ResolvedSessionAttachedDatabases {
    main: ConnectionState;
    attached: ConnectionState[];
}

export function resolveSessionAttachedDatabases(
    registry: ConnectionRegistry,
    sessionId: string | null,
): ResolvedSessionAttachedDatabases | null {
    if (sessionId == null) return null;
    const mapping = registry.attachedDatabasesBySession.get(sessionId);
    if (mapping == null) return null;
    const main = registry.connections.get(mapping.mainDatabaseId);
    if (main == null) return null;
    const attached = mapping.attachedDatabaseIds
        .map(connectionId => registry.connections.get(connectionId))
        .filter((database): database is ConnectionState => database != null);
    if (attached.length !== mapping.attachedDatabaseIds.length) return null;
    return { main, attached };
}

export function resolveSessionExecutionDatabase(
    registry: ConnectionRegistry,
    sessionId: string | null,
): ConnectionState | null {
    const mapping = sessionId == null ? null : registry.attachedDatabasesBySession.get(sessionId);
    if (mapping == null) return null;
    return registry.connections.get(mapping.mainDatabaseId) ?? null;
}

/// Find the sessions that reference a connection, in registration order
export function findSessionsForConnection(registry: ConnectionRegistry, connectionId: string): string[] {
    const sessions: string[] = [];
    for (const [sessionId, mapping] of registry.attachedDatabasesBySession) {
        if (mapping.mainDatabaseId === connectionId || mapping.attachedDatabaseIds.includes(connectionId)) sessions.push(sessionId);
    }
    return sessions;
}

/// Find the sessions that use a connection as their main database
export function findSessionsWithMainDatabase(registry: ConnectionRegistry, connectionId: string): string[] {
    const sessions: string[] = [];
    for (const [sessionId, mapping] of registry.attachedDatabasesBySession) {
        if (mapping.mainDatabaseId === connectionId) sessions.push(sessionId);
    }
    return sessions;
}

/// The number of sessions that reference a connection
export function connectionRefCount(registry: ConnectionRegistry, connectionId: string): number {
    return findSessionsForConnection(registry, connectionId).length;
}

/// Register a connection in the registry indices (mutates the registry)
export function registerConnection(registry: ConnectionRegistry, database: ConnectionState): void {
    registry.connections.set(database.connectionId, database);
    const byType = registry.connectionsByType[database.connectorInfo.connectorType];
    if (!byType.includes(database.connectionId)) byType.push(database.connectionId);
    registry.connectionsBySignature.set(database.connectionSignature.signatureString, database.connectionId);
}

/// Let a session reference a connection (mutates the registry)
export function attachDatabaseToSession(registry: ConnectionRegistry, sessionId: string, connectionId: string, role: AttachedDatabaseRole): void {
    const current = registry.attachedDatabasesBySession.get(sessionId);
    if (role === 'main') {
        registry.attachedDatabasesBySession.set(sessionId, {
            mainDatabaseId: connectionId,
            attachedDatabaseIds: (current?.attachedDatabaseIds ?? []).filter(id => id !== connectionId),
        });
    } else {
        if (current == null) throw new Error(`cannot attach a database before the main database for session ${sessionId}`);
        if (current.mainDatabaseId === connectionId || current.attachedDatabaseIds.includes(connectionId)) return;
        registry.attachedDatabasesBySession.set(sessionId, {
            ...current,
            attachedDatabaseIds: [...current.attachedDatabaseIds, connectionId],
        });
    }
}

/// Drop the references of a session, the connections stay registered (mutates the registry)
export function detachSession(registry: ConnectionRegistry, sessionId: string): void {
    registry.attachedDatabasesBySession.delete(sessionId);
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
        params: database.params,
        ...(database.paramsDraft == null ? {} : { paramsDraft: database.paramsDraft }),
    };
}

/// Build the copy of a connection that a session file stores
export function sessionDatabaseFromState(database: ConnectionState): AttachedDatabase {
    return { databaseId: database.connectionId, params: database.params };
}

/// Did the saved params change?
export function didConnectionParamsChange(prev: ConnectionState, next: ConnectionState): boolean {
    return !connectionParamsEqual(prev.params, next.params);
}

/// Did the persisted connection entry change?
export function didPersistedConnectionChange(prev: ConnectionState, next: ConnectionState): boolean {
    if (!prev.active && next.active) return true;
    return didConnectionParamsChange(prev, next) || !connectionParamsEqual(prev.paramsDraft, next.paramsDraft);
}

/// Write the saved params of a connection into the app manifest and into every session that
/// references it. The writes are debounced and not awaited, Save awaits them explicitly.
export function scheduleConnectionParamsWrites(registry: ConnectionRegistry, database: ConnectionState, storageWriter: StorageWriter): void {
    void storageWriter.write(
        groupConnectionEntryWrites(database.connectionId),
        { type: WRITE_CONNECTION_ENTRY, value: connectionEntryFromState(database) },
        DEBOUNCE_DURATION_SESSION_WRITE,
    );
    for (const sessionId of findSessionsForConnection(registry, database.connectionId)) {
        void storageWriter.write(
            groupSessionConnectionCopyWrites(sessionId, database.connectionId),
            { type: PATCH_SESSION_CONNECTION, value: [sessionId, database.connectionId, database.params] },
            DEBOUNCE_DURATION_SESSION_WRITE,
        );
    }
}

export type SetConnectionRegistryAction = React.SetStateAction<ConnectionRegistry>;
export type AttachedDatabaseRole = 'main' | 'attached';
export type AttachedDatabaseAllocator = (sessionId: string, state: ConnectionStateWithoutId, role?: AttachedDatabaseRole) => ConnectionState;
export type ConnectionCloner = (state: ConnectionState) => ConnectionState;
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

type Props = {
    children: React.ReactElement | React.ReactElement[];
};

export const ConnectionRegistry: React.FC<Props> = (props: Props) => {
    const [reg, setReg] = React.useState<ConnectionRegistry>(() => {
        return ({
            connections: new Map(),
            attachedDatabasesBySession: new Map(),
            connectionsByType: CONNECTOR_TYPES.map(() => ([])),
            connectionsBySignature: new Map(),
        });
    });
    const listeners = React.useRef(new Set<() => void>());
    const store = React.useMemo<ConnectionRegistryStore>(() => ({
        current: reg,
        subscribe: (listener: () => void) => {
            listeners.current.add(listener);
            return () => listeners.current.delete(listener);
        },
    }), []);
    // Publish the registry during render so that store readers and context consumers see the same registry
    store.current = reg;
    React.useLayoutEffect(() => {
        for (const listener of listeners.current) {
            listener();
        }
    }, [reg]);
    return (
        <CONNECTION_REGISTRY_STORE_CTX.Provider value={store}>
            <CONNECTION_REGISTRY_SETTER_CTX.Provider value={setReg}>
                <CONNECTION_REGISTRY_CTX.Provider value={reg}>
                    {props.children}
                </CONNECTION_REGISTRY_CTX.Provider>
            </CONNECTION_REGISTRY_SETTER_CTX.Provider>
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

/// Allocate a new connection and let a session reference it
export function useAttachedDatabaseStateAllocator(): AttachedDatabaseAllocator {
    const allocateConnection = useConnectionAllocator();
    const attachConnection = useAttachConnection();
    return React.useCallback((sessionId: string, state: ConnectionStateWithoutId, role: AttachedDatabaseRole = 'main') => {
        const database = allocateConnection(state);
        attachConnection(sessionId, database.connectionId, role);
        // The caller writes newly committed sessions. Subsequent edits and successful setups
        // persist through the dispatch boundary, including drafts before the first connection.
        return database;
    }, [allocateConnection, attachConnection]);
}

export type ConnectionAllocator = (state: ConnectionStateWithoutId, connectionId?: string) => ConnectionState;

/// Allocate a new connection that no session references yet.
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

export type ConnectionAttacher = (sessionId: string, connectionId: string, role?: AttachedDatabaseRole) => void;

/// Let a session reference an existing connection
export function useAttachConnection(): ConnectionAttacher {
    const setReg = React.useContext(CONNECTION_REGISTRY_SETTER_CTX)!;
    return React.useCallback((sessionId: string, connectionId: string, role: AttachedDatabaseRole = 'main') => {
        setReg((reg) => {
            attachDatabaseToSession(reg, sessionId, connectionId, role);
            return { ...reg };
        });
    }, [setReg]);
}

/// Drop the references of a session, the connections stay registered
export function useSessionDetacher(): (sessionId: string) => void {
    const setReg = React.useContext(CONNECTION_REGISTRY_SETTER_CTX)!;
    return React.useCallback((sessionId: string) => {
        setReg((reg) => {
            if (!reg.attachedDatabasesBySession.has(sessionId)) return reg;
            detachSession(reg, sessionId);
            return { ...reg };
        });
    }, [setReg]);
}

export function useConnectionRegistry(): [ConnectionRegistry, Dispatch<SetConnectionRegistryAction>] {
    return [React.useContext(CONNECTION_REGISTRY_CTX)!, React.useContext(CONNECTION_REGISTRY_SETTER_CTX)!];
}

export function useDynamicConnectionDispatch(): [ConnectionRegistry, DynamicConnectionDispatch] {
    const registry = React.useContext(CONNECTION_REGISTRY_CTX)!;
    const dispatch = useConnectionDispatch();
    return [registry, dispatch];
}

/// Dispatch actions to attached databases without subscribing to registry changes
export function useConnectionDispatch(): DynamicConnectionDispatch {
    const setRegistry = React.useContext(CONNECTION_REGISTRY_SETTER_CTX)!;
    const storageWriter = useStorageWriter();
    const logger = useLogger();

    // Queue for batching dispatch calls to avoid concurrent rendering issues
    const pendingActionsRef = React.useRef<Array<{ connectionId: string; action: ConnectionAction }>>([]);
    const flushScheduledRef = React.useRef<{ type: 'microtask' } | { type: 'frame'; handle: number } | null>(null);

    React.useEffect(() => () => {
        if (flushScheduledRef.current?.type === 'frame') {
            cancelAnimationFrame(flushScheduledRef.current.handle);
        }
    }, []);

    // Flush all pending actions in a single state update
    const flushPendingActions = React.useCallback(() => {
        flushScheduledRef.current = null;
        const actions = pendingActionsRef.current;
        if (actions.length === 0) return;
        pendingActionsRef.current = [];

        setRegistry((reg: ConnectionRegistry) => {
            for (const { connectionId, action } of actions) {
                const prev = reg.connections.get(connectionId);
                if (!prev) {
                    console.warn(`no attached database registered with id ${connectionId}`);
                    continue;
                }
                const connectionSignature = prev.connectionSignature.signatureString;
                const connectorType = prev.connectorInfo.connectorType;
                const sessionIds = findSessionsForConnection(reg, connectionId);

                // Connections outlive the sessions that reference them, but a referenced connection
                // must neither be deleted nor change its type underneath other sessions.
                if (action.type == DELETE_CONNECTION && sessionIds.length > 0) {
                    logger.warn('refusing to delete a connection that sessions reference', {
                        connectionId,
                        sessions: sessionIds.join(','),
                    }, LOG_CTX);
                    continue;
                }
                if (action.type == SWITCH_CONNECTOR_TYPE && sessionIds.length > 1) {
                    logger.warn('refusing to switch the type of a shared connection', { connectionId }, LOG_CTX);
                    continue;
                }
                const next = reduceConnectionState(prev, action, storageWriter, logger);

                if (action.type == DELETE_CONNECTION) {
                    reg.connectionsBySignature.delete(connectionSignature);
                    reg.connectionsByType[connectorType] = reg.connectionsByType[connectorType].filter(id => id != connectionId);
                    reg.connections.delete(connectionId);
                    if (prev.active) {
                        void storageWriter.write(groupConnectionEntryWrites(connectionId), { type: DELETE_CONNECTION_ENTRY, value: connectionId });
                    }
                    continue;
                }
                reg.connections.set(connectionId, next);
                // Update type index when connector type changes
                if (action.type == SWITCH_CONNECTOR_TYPE && next.connectorInfo.connectorType !== connectorType) {
                    reg.connectionsByType[connectorType] = reg.connectionsByType[connectorType].filter(id => id != connectionId);
                    reg.connectionsByType[next.connectorInfo.connectorType].push(connectionId);
                    // Update signature
                    reg.connectionsBySignature.delete(connectionSignature);
                    reg.connectionsBySignature.set(next.connectionSignature.signatureString, connectionId);
                }
                // Only connections that sessions reference or that were activated are persisted.
                // Saving writes the committed params by itself and awaits the writes.
                if (sessionIds.length === 0 && !next.active) {
                    continue;
                }
                if (action.type !== COMMIT_CONNECTION_PARAMS) {
                    if (didConnectionParamsChange(prev, next) || (!prev.active && next.active)) {
                        // Saved params are replicated into every session that references the connection
                        scheduleConnectionParamsWrites(reg, next, storageWriter);
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
                    continue;
                }
                // The catalog of the connection is written into the app storage, sessions that use the
                // connection as main database keep a copy to stay self-contained.
                const mainOf = findSessionsWithMainDatabase(reg, connectionId);
                if (action.type === CATALOG_UPDATE_SUCCEEDED || action.type === CATALOG_UPDATE_PARTIALLY_SUCCEEDED) {
                    const relationsSql = next.catalogRelationScript.toString();
                    const functionsSql = next.catalogFunctionScript.toString();
                    void storageWriter.write(
                        groupConnectionFileWrites(connectionId, STORAGE_CATALOG_RELATIONS),
                        { type: WRITE_CONNECTION_FILE, value: [connectionId, STORAGE_CATALOG_RELATIONS, relationsSql] },
                        DEBOUNCE_DURATION_SESSION_WRITE,
                    );
                    void storageWriter.write(
                        groupConnectionFileWrites(connectionId, STORAGE_CATALOG_FUNCTIONS),
                        { type: WRITE_CONNECTION_FILE, value: [connectionId, STORAGE_CATALOG_FUNCTIONS, functionsSql] },
                        DEBOUNCE_DURATION_SESSION_WRITE,
                    );
                    for (const sessionId of mainOf) {
                        void storageWriter.write(
                            groupSessionSchemaWrites(sessionId),
                            { type: WRITE_SESSION_CATALOG_SCRIPT, value: [sessionId, next.catalogRelationScript] },
                            DEBOUNCE_DURATION_SESSION_WRITE,
                        );
                        void storageWriter.write(
                            groupSessionFunctionWrites(sessionId),
                            { type: WRITE_SESSION_FUNCTION_SCRIPT, value: [sessionId, next.catalogFunctionScript] },
                            DEBOUNCE_DURATION_SESSION_WRITE,
                        );
                    }
                }
                // Executed statements record catalog changes, a refresh clears them
                if (next.catalogChangesSql !== prev.catalogChangesSql) {
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
            }
            return { ...reg };
        });
    }, [setRegistry, storageWriter, logger]);

    /// Helper to modify a dynamic connection
    const dispatch = React.useCallback((connectionId: string | null, action: ConnectionAction) => {
        // No id provided? Then do nothing.
        if (connectionId == null) {
            return;
        }
        // Queue the action
        pendingActionsRef.current.push({ connectionId, action });

        const frameCoalescible = action.type === QUERY_PROGRESS_UPDATED || action.type === QUERY_RECEIVED_BATCH;
        // Query execution may happen in a worker or remotely, but Arrow batch decoding and these
        // state updates happen on the renderer thread. A fast result stream can therefore enqueue
        // a microtask cascade that repeatedly rerenders the session before the browser gets a
        // frame to paint. Publish only the latest streamed progress once per frame; lifecycle
        // actions stay immediate and flush queued stream updates first to preserve action order.
        if (frameCoalescible && flushScheduledRef.current == null) {
            const handle = requestAnimationFrame(flushPendingActions);
            flushScheduledRef.current = { type: 'frame', handle };
        } else if (!frameCoalescible && flushScheduledRef.current?.type === 'frame') {
            cancelAnimationFrame(flushScheduledRef.current.handle);
            flushPendingActions();
        } else if (!frameCoalescible && flushScheduledRef.current == null) {
            flushScheduledRef.current = { type: 'microtask' };
            queueMicrotask(flushPendingActions);
        }
    }, [flushPendingActions]);

    return dispatch;
}

export function useConnectionState(sessionId: string | null): [ConnectionState | null, ConnectionDispatch] {
    const [registry, dispatch] = useDynamicConnectionDispatch();
    const connectionId = resolveSessionExecutionDatabase(registry, sessionId)?.connectionId ?? null;
    const capturingDispatch = React.useCallback((action: ConnectionAction) => dispatch(connectionId, action), [connectionId, dispatch]);
    return [connectionId == null ? null : (registry.connections.get(connectionId) ?? null), capturingDispatch]
}

export function useSessionAttachedDatabases(sessionId: string | null): ResolvedSessionAttachedDatabases | null {
    const [registry] = useConnectionRegistry();
    return resolveSessionAttachedDatabases(registry, sessionId);
}

export function useSessionExecutionDatabase(sessionId: string | null): ConnectionState | null {
    const [registry] = useConnectionRegistry();
    return resolveSessionExecutionDatabase(registry, sessionId);
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
