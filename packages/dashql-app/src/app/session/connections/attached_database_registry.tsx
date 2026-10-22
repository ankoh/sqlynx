import * as React from 'react';

import {
    AttachedDatabaseState,
    AttachedDatabaseAction,
    AttachedDatabaseStateWithoutId,
    CATALOG_UPDATE_PARTIALLY_SUCCEEDED,
    CATALOG_UPDATE_SUCCEEDED,
    DELETE_ATTACHED_DATABASE,
    SWITCH_CONNECTOR_TYPE,
    reduceAttachedDatabaseState,
    SET_CONNECTION_DRAFT,
    DISCARD_CONNECTION_DRAFT,
    COMMIT_CONNECTION_PARAMS,
} from './attached_database_state.js';
import { QUERY_PROGRESS_UPDATED, QUERY_RECEIVED_BATCH } from '../../../query/query_execution_state.js';
import { Dispatch } from '../../../utils/variant.js';
import { CONNECTOR_TYPES } from './connector_info.js';
import { ConnectionSignatureMap } from './connection_signature.js';
import { useStorageWriter } from '../../storage/storage_provider.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';

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
} from '../../storage/storage_writer.js';
import { STORAGE_CATALOG_CHANGES, STORAGE_CATALOG_FUNCTIONS, STORAGE_CATALOG_RELATIONS, type ConnectionEntry } from '../../storage/storage_backend.js';
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
export interface AttachedDatabaseRegistry {
    attachedDatabases: Map<string, AttachedDatabaseState>;  // databaseId -> AttachedDatabaseState
    attachedDatabasesBySession: Map<string, SessionAttachedDatabases>;
    attachedDatabasesByType: string[][];  // arrays of databaseIds by connector type
    attachedDatabasesBySignature: ConnectionSignatureMap;
}

export interface SessionAttachedDatabases {
    mainDatabaseId: string;
    attachedDatabaseIds: string[];
}

export interface ResolvedSessionAttachedDatabases {
    main: AttachedDatabaseState;
    attached: AttachedDatabaseState[];
}

export function resolveSessionAttachedDatabases(
    registry: AttachedDatabaseRegistry,
    sessionId: string | null,
): ResolvedSessionAttachedDatabases | null {
    if (sessionId == null) return null;
    const mapping = registry.attachedDatabasesBySession.get(sessionId);
    if (mapping == null) return null;
    const main = registry.attachedDatabases.get(mapping.mainDatabaseId);
    if (main == null) return null;
    const attached = mapping.attachedDatabaseIds
        .map(databaseId => registry.attachedDatabases.get(databaseId))
        .filter((database): database is AttachedDatabaseState => database != null);
    if (attached.length !== mapping.attachedDatabaseIds.length) return null;
    return { main, attached };
}

export function resolveSessionExecutionDatabase(
    registry: AttachedDatabaseRegistry,
    sessionId: string | null,
): AttachedDatabaseState | null {
    const mapping = sessionId == null ? null : registry.attachedDatabasesBySession.get(sessionId);
    if (mapping == null) return null;
    return registry.attachedDatabases.get(mapping.mainDatabaseId) ?? null;
}

/// Find the sessions that reference a connection, in registration order
export function findSessionsForAttachedDatabase(registry: AttachedDatabaseRegistry, databaseId: string): string[] {
    const sessions: string[] = [];
    for (const [sessionId, mapping] of registry.attachedDatabasesBySession) {
        if (mapping.mainDatabaseId === databaseId || mapping.attachedDatabaseIds.includes(databaseId)) sessions.push(sessionId);
    }
    return sessions;
}

/// Find the sessions that use a connection as their main database
export function findSessionsWithMainDatabase(registry: AttachedDatabaseRegistry, databaseId: string): string[] {
    const sessions: string[] = [];
    for (const [sessionId, mapping] of registry.attachedDatabasesBySession) {
        if (mapping.mainDatabaseId === databaseId) sessions.push(sessionId);
    }
    return sessions;
}

/// The number of sessions that reference a connection
export function connectionRefCount(registry: AttachedDatabaseRegistry, databaseId: string): number {
    return findSessionsForAttachedDatabase(registry, databaseId).length;
}

/// Register a connection in the registry indices (mutates the registry)
export function registerAttachedDatabase(registry: AttachedDatabaseRegistry, database: AttachedDatabaseState): void {
    registry.attachedDatabases.set(database.databaseId, database);
    const byType = registry.attachedDatabasesByType[database.connectorInfo.connectorType];
    if (!byType.includes(database.databaseId)) byType.push(database.databaseId);
    registry.attachedDatabasesBySignature.set(database.connectionSignature.signatureString, database.databaseId);
}

/// Let a session reference a connection (mutates the registry)
export function attachDatabaseToSession(registry: AttachedDatabaseRegistry, sessionId: string, databaseId: string, role: AttachedDatabaseRole): void {
    const current = registry.attachedDatabasesBySession.get(sessionId);
    if (role === 'main') {
        registry.attachedDatabasesBySession.set(sessionId, {
            mainDatabaseId: databaseId,
            attachedDatabaseIds: (current?.attachedDatabaseIds ?? []).filter(id => id !== databaseId),
        });
    } else {
        if (current == null) throw new Error(`cannot attach a database before the main database for session ${sessionId}`);
        if (current.mainDatabaseId === databaseId || current.attachedDatabaseIds.includes(databaseId)) return;
        registry.attachedDatabasesBySession.set(sessionId, {
            ...current,
            attachedDatabaseIds: [...current.attachedDatabaseIds, databaseId],
        });
    }
}

/// Drop the references of a session, the connections stay registered (mutates the registry)
export function detachSession(registry: AttachedDatabaseRegistry, sessionId: string): void {
    registry.attachedDatabasesBySession.delete(sessionId);
}

/// The queries a session issued on a connection, active ones first
export function findSessionQueries(database: AttachedDatabaseState, sessionId: string, includeFinished: boolean = true): number[] {
    const active = database.queriesActiveOrdered.filter(queryId => database.queriesActive.get(queryId)?.queryMetadata.sessionId === sessionId);
    if (!includeFinished) return active;
    const finished = database.queriesFinishedOrdered.filter(queryId => database.queriesFinished.get(queryId)?.queryMetadata.sessionId === sessionId);
    return [...active, ...finished];
}

/// Build the manifest entry of a connection
export function connectionEntryFromState(database: AttachedDatabaseState): ConnectionEntry {
    return {
        id: database.databaseId,
        params: database.params,
        ...(database.paramsDraft == null ? {} : { paramsDraft: database.paramsDraft }),
    };
}

/// Did the saved params change?
export function didConnectionParamsChange(prev: AttachedDatabaseState, next: AttachedDatabaseState): boolean {
    return !connectionParamsEqual(prev.params, next.params);
}

/// Did the persisted connection entry change?
export function didPersistedConnectionChange(prev: AttachedDatabaseState, next: AttachedDatabaseState): boolean {
    if (!prev.active && next.active) return true;
    return didConnectionParamsChange(prev, next) || !connectionParamsEqual(prev.paramsDraft, next.paramsDraft);
}

/// Write the saved params of a connection into the app manifest and into every session that
/// references it. The writes are debounced and not awaited, Save awaits them explicitly.
export function scheduleConnectionParamsWrites(registry: AttachedDatabaseRegistry, database: AttachedDatabaseState, storageWriter: StorageWriter): void {
    void storageWriter.write(
        groupConnectionEntryWrites(database.databaseId),
        { type: WRITE_CONNECTION_ENTRY, value: connectionEntryFromState(database) },
        DEBOUNCE_DURATION_SESSION_WRITE,
    );
    for (const sessionId of findSessionsForAttachedDatabase(registry, database.databaseId)) {
        void storageWriter.write(
            groupSessionConnectionCopyWrites(sessionId, database.databaseId),
            { type: PATCH_SESSION_CONNECTION, value: [sessionId, database.databaseId, database.params] },
            DEBOUNCE_DURATION_SESSION_WRITE,
        );
    }
}

export type SetAttachedDatabaseRegistryAction = React.SetStateAction<AttachedDatabaseRegistry>;
export type AttachedDatabaseRole = 'main' | 'attached';
export type AttachedDatabaseAllocator = (sessionId: string, state: AttachedDatabaseStateWithoutId, role?: AttachedDatabaseRole) => AttachedDatabaseState;
export type AttachedDatabaseCloner = (state: AttachedDatabaseState) => AttachedDatabaseState;
export type AttachedDatabaseDispatch = (action: AttachedDatabaseAction) => void;
export type DynamicAttachedDatabaseDispatch = (databaseId: string | null, action: AttachedDatabaseAction) => void;

/// A stable handle to the latest registry.
///
/// The registry changes with every query lifecycle event (including the internal SQLFrame queries of
/// computations), which re-renders every context consumer.
/// Components that only care about a small slice of the registry subscribe to the store instead.
export interface AttachedDatabaseRegistryStore {
    /// The latest registry
    current: AttachedDatabaseRegistry;
    /// Subscribe to registry changes
    subscribe: (listener: () => void) => () => void;
}

const ATTACHED_DATABASE_REGISTRY_CTX = React.createContext<AttachedDatabaseRegistry | null>(null);
const ATTACHED_DATABASE_REGISTRY_SETTER_CTX = React.createContext<Dispatch<SetAttachedDatabaseRegistryAction> | null>(null);
const ATTACHED_DATABASE_REGISTRY_STORE_CTX = React.createContext<AttachedDatabaseRegistryStore | null>(null);

type Props = {
    children: React.ReactElement | React.ReactElement[];
};

export const AttachedDatabaseRegistry: React.FC<Props> = (props: Props) => {
    const [reg, setReg] = React.useState<AttachedDatabaseRegistry>(() => {
        return ({
            attachedDatabases: new Map(),
            attachedDatabasesBySession: new Map(),
            attachedDatabasesByType: CONNECTOR_TYPES.map(() => ([])),
            attachedDatabasesBySignature: new Map(),
        });
    });
    const listeners = React.useRef(new Set<() => void>());
    const store = React.useMemo<AttachedDatabaseRegistryStore>(() => ({
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
        <ATTACHED_DATABASE_REGISTRY_STORE_CTX.Provider value={store}>
            <ATTACHED_DATABASE_REGISTRY_SETTER_CTX.Provider value={setReg}>
                <ATTACHED_DATABASE_REGISTRY_CTX.Provider value={reg}>
                    {props.children}
                </ATTACHED_DATABASE_REGISTRY_CTX.Provider>
            </ATTACHED_DATABASE_REGISTRY_SETTER_CTX.Provider>
        </ATTACHED_DATABASE_REGISTRY_STORE_CTX.Provider>
    );
};

/// Get the registry store without subscribing to registry changes
export function useAttachedDatabaseRegistryStore(): AttachedDatabaseRegistryStore {
    return React.useContext(ATTACHED_DATABASE_REGISTRY_STORE_CTX)!;
}

/// Subscribe to a slice of the registry.
/// The component only re-renders when the selected value changes.
/// The selector must return values that keep their identity while unchanged.
export function useAttachedDatabaseRegistrySelector<T>(select: (registry: AttachedDatabaseRegistry) => T): T {
    const store = useAttachedDatabaseRegistryStore();
    return React.useSyncExternalStore(store.subscribe, () => select(store.current));
}

/// Modify the registry without subscribing to registry changes
export function useAttachedDatabaseRegistrySetter(): Dispatch<SetAttachedDatabaseRegistryAction> {
    return React.useContext(ATTACHED_DATABASE_REGISTRY_SETTER_CTX)!;
}

/// Allocate a new connection and let a session reference it
export function useAttachedDatabaseStateAllocator(): AttachedDatabaseAllocator {
    const allocateConnection = useConnectionAllocator();
    const attachConnection = useAttachConnection();
    return React.useCallback((sessionId: string, state: AttachedDatabaseStateWithoutId, role: AttachedDatabaseRole = 'main') => {
        const database = allocateConnection(state);
        attachConnection(sessionId, database.databaseId, role);
        // The caller writes newly committed sessions. Subsequent edits and successful setups
        // persist through the dispatch boundary, including drafts before the first connection.
        return database;
    }, [allocateConnection, attachConnection]);
}

export type ConnectionAllocator = (state: AttachedDatabaseStateWithoutId, connectionId?: string) => AttachedDatabaseState;

/// Allocate a new connection that no session references yet.
/// Active connections are written into the app manifest right away.
export function useConnectionAllocator(): ConnectionAllocator {
    const setReg = React.useContext(ATTACHED_DATABASE_REGISTRY_SETTER_CTX)!;
    const storageWriter = useStorageWriter();
    return React.useCallback((state: AttachedDatabaseStateWithoutId, connectionId?: string) => {
        const databaseId = connectionId ?? crypto.randomUUID();
        const database: AttachedDatabaseState = { ...state, databaseId };
        setReg((reg) => {
            registerAttachedDatabase(reg, database);
            return { ...reg };
        });
        if (database.active) {
            void storageWriter.write(
                groupConnectionEntryWrites(databaseId),
                { type: WRITE_CONNECTION_ENTRY, value: { ...connectionEntryFromState(database), createdAt: new Date().toISOString() } },
            );
        }
        return database;
    }, [setReg, storageWriter]);
}

export type ConnectionAttacher = (sessionId: string, connectionId: string, role?: AttachedDatabaseRole) => void;

/// Let a session reference an existing connection
export function useAttachConnection(): ConnectionAttacher {
    const setReg = React.useContext(ATTACHED_DATABASE_REGISTRY_SETTER_CTX)!;
    return React.useCallback((sessionId: string, connectionId: string, role: AttachedDatabaseRole = 'main') => {
        setReg((reg) => {
            attachDatabaseToSession(reg, sessionId, connectionId, role);
            return { ...reg };
        });
    }, [setReg]);
}

/// Drop the references of a session, the connections stay registered
export function useSessionDetacher(): (sessionId: string) => void {
    const setReg = React.useContext(ATTACHED_DATABASE_REGISTRY_SETTER_CTX)!;
    return React.useCallback((sessionId: string) => {
        setReg((reg) => {
            if (!reg.attachedDatabasesBySession.has(sessionId)) return reg;
            detachSession(reg, sessionId);
            return { ...reg };
        });
    }, [setReg]);
}

export function useAttachedDatabaseRegistry(): [AttachedDatabaseRegistry, Dispatch<SetAttachedDatabaseRegistryAction>] {
    return [React.useContext(ATTACHED_DATABASE_REGISTRY_CTX)!, React.useContext(ATTACHED_DATABASE_REGISTRY_SETTER_CTX)!];
}

export function useDynamicAttachedDatabaseDispatch(): [AttachedDatabaseRegistry, DynamicAttachedDatabaseDispatch] {
    const registry = React.useContext(ATTACHED_DATABASE_REGISTRY_CTX)!;
    const dispatch = useAttachedDatabaseDispatch();
    return [registry, dispatch];
}

/// Dispatch actions to attached databases without subscribing to registry changes
export function useAttachedDatabaseDispatch(): DynamicAttachedDatabaseDispatch {
    const setRegistry = React.useContext(ATTACHED_DATABASE_REGISTRY_SETTER_CTX)!;
    const storageWriter = useStorageWriter();
    const logger = useLogger();

    // Queue for batching dispatch calls to avoid concurrent rendering issues
    const pendingActionsRef = React.useRef<Array<{ databaseId: string; action: AttachedDatabaseAction }>>([]);
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

        setRegistry((reg: AttachedDatabaseRegistry) => {
            for (const { databaseId, action } of actions) {
                const prev = reg.attachedDatabases.get(databaseId);
                if (!prev) {
                    console.warn(`no attached database registered with id ${databaseId}`);
                    continue;
                }
                const connectionSignature = prev.connectionSignature.signatureString;
                const connectorType = prev.connectorInfo.connectorType;
                const sessionIds = findSessionsForAttachedDatabase(reg, databaseId);

                // Connections outlive the sessions that reference them, but a referenced connection
                // must neither be deleted nor change its type underneath other sessions.
                if (action.type == DELETE_ATTACHED_DATABASE && sessionIds.length > 0) {
                    logger.warn('refusing to delete a connection that sessions reference', {
                        databaseId,
                        sessions: sessionIds.join(','),
                    }, LOG_CTX);
                    continue;
                }
                if (action.type == SWITCH_CONNECTOR_TYPE && sessionIds.length > 1) {
                    logger.warn('refusing to switch the type of a shared connection', { databaseId }, LOG_CTX);
                    continue;
                }
                const next = reduceAttachedDatabaseState(prev, action, storageWriter, logger);

                if (action.type == DELETE_ATTACHED_DATABASE) {
                    reg.attachedDatabasesBySignature.delete(connectionSignature);
                    reg.attachedDatabasesByType[connectorType] = reg.attachedDatabasesByType[connectorType].filter(id => id != databaseId);
                    reg.attachedDatabases.delete(databaseId);
                    if (prev.active) {
                        void storageWriter.write(groupConnectionEntryWrites(databaseId), { type: DELETE_CONNECTION_ENTRY, value: databaseId });
                    }
                    continue;
                }
                reg.attachedDatabases.set(databaseId, next);
                // Update type index when connector type changes
                if (action.type == SWITCH_CONNECTOR_TYPE && next.connectorInfo.connectorType !== connectorType) {
                    reg.attachedDatabasesByType[connectorType] = reg.attachedDatabasesByType[connectorType].filter(id => id != databaseId);
                    reg.attachedDatabasesByType[next.connectorInfo.connectorType].push(databaseId);
                    // Update signature
                    reg.attachedDatabasesBySignature.delete(connectionSignature);
                    reg.attachedDatabasesBySignature.set(next.connectionSignature.signatureString, databaseId);
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
                            groupConnectionEntryWrites(databaseId),
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
                const mainOf = findSessionsWithMainDatabase(reg, databaseId);
                if (action.type === CATALOG_UPDATE_SUCCEEDED || action.type === CATALOG_UPDATE_PARTIALLY_SUCCEEDED) {
                    const relationsSql = next.catalogRelationScript.toString();
                    const functionsSql = next.catalogFunctionScript.toString();
                    void storageWriter.write(
                        groupConnectionFileWrites(databaseId, STORAGE_CATALOG_RELATIONS),
                        { type: WRITE_CONNECTION_FILE, value: [databaseId, STORAGE_CATALOG_RELATIONS, relationsSql] },
                        DEBOUNCE_DURATION_SESSION_WRITE,
                    );
                    void storageWriter.write(
                        groupConnectionFileWrites(databaseId, STORAGE_CATALOG_FUNCTIONS),
                        { type: WRITE_CONNECTION_FILE, value: [databaseId, STORAGE_CATALOG_FUNCTIONS, functionsSql] },
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
                        groupConnectionFileWrites(databaseId, STORAGE_CATALOG_CHANGES),
                        { type: WRITE_CONNECTION_FILE, value: [databaseId, STORAGE_CATALOG_CHANGES, next.catalogChangesSql] },
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
    const dispatch = React.useCallback((databaseId: string | null, action: AttachedDatabaseAction) => {
        // No id provided? Then do nothing.
        if (databaseId == null) {
            return;
        }
        // Queue the action
        pendingActionsRef.current.push({ databaseId, action });

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

export function useAttachedDatabaseState(sessionId: string | null): [AttachedDatabaseState | null, AttachedDatabaseDispatch] {
    const [registry, dispatch] = useDynamicAttachedDatabaseDispatch();
    const databaseId = resolveSessionExecutionDatabase(registry, sessionId)?.databaseId ?? null;
    const capturingDispatch = React.useCallback((action: AttachedDatabaseAction) => dispatch(databaseId, action), [databaseId, dispatch]);
    return [databaseId == null ? null : (registry.attachedDatabases.get(databaseId) ?? null), capturingDispatch]
}

export function useSessionAttachedDatabases(sessionId: string | null): ResolvedSessionAttachedDatabases | null {
    const [registry] = useAttachedDatabaseRegistry();
    return resolveSessionAttachedDatabases(registry, sessionId);
}

export function useSessionExecutionDatabase(sessionId: string | null): AttachedDatabaseState | null {
    const [registry] = useAttachedDatabaseRegistry();
    return resolveSessionExecutionDatabase(registry, sessionId);
}

export function useAttachedDatabaseById(databaseId: string | null): [AttachedDatabaseState | null, AttachedDatabaseDispatch] {
    const [registry, dispatch] = useDynamicAttachedDatabaseDispatch();
    const capturingDispatch = React.useCallback((action: AttachedDatabaseAction) => dispatch(databaseId, action), [databaseId, dispatch]);
    return [databaseId == null ? null : registry.attachedDatabases.get(databaseId) ?? null, capturingDispatch];
}

/// Editing dispatches immediately; the registry debounces only the durable manifest write.
export function useConnectionDraft(databaseId: string | null) {
    const [database, dispatch] = useAttachedDatabaseById(databaseId);
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
    databaseId: string | null,
    decode: (params: ConnectionParams | null) => T,
    encode: (form: T) => ConnectionParams,
): [T, React.Dispatch<React.SetStateAction<T>>] {
    const { params, paramsDraft, setDraft } = useConnectionDraft(databaseId);
    const source = paramsDraft ?? params;
    const [form, setForm] = React.useState(() => decode(source));
    const sourceRef = React.useRef(source);
    const formRef = React.useRef(form);
    const databaseIdRef = React.useRef(databaseId);
    const editedParamsRef = React.useRef<ConnectionParams | undefined>(undefined);
    if (databaseIdRef.current !== databaseId || sourceRef.current !== source) {
        const ownEdit = databaseIdRef.current === databaseId && paramsDraft != null
            && connectionParamsEqual(editedParamsRef.current, paramsDraft);
        databaseIdRef.current = databaseId;
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
