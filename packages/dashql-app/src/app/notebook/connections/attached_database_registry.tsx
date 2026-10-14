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
} from './attached_database_state.js';
import { QUERY_PROGRESS_UPDATED, QUERY_RECEIVED_BATCH } from '../../../query/query_execution_state.js';
import { Dispatch } from '../../../utils/variant.js';
import { CONNECTOR_TYPES } from './connector_info.js';
import { ConnectionSignatureMap } from './connection_signature.js';
import { useStorageWriter } from '../persistence/storage_provider.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import {
    DEBOUNCE_DURATION_NOTEBOOK_WRITE,
    groupNotebookFunctionWrites,
    groupNotebookConnectionWrites,
    groupNotebookSchemaWrites,
    WRITE_NOTEBOOK_CATALOG_SCRIPT,
    WRITE_NOTEBOOK_FUNCTION_SCRIPT,
    WRITE_NOTEBOOK_MANIFEST,
} from '../persistence/storage_writer.js';
import { connectionParamsEqual, type ConnectionParams } from './connection_params.js';

/// The connection registry
///
/// Note that we're deliberately not using immutable maps for the connections here.
/// Following the same reasoning as with the notebook registry, we don't have code that
/// explicitly observes modifications of the registry map.
/// Instead, shallow-compare the entire registry object again.
export interface AttachedDatabaseRegistry {
    attachedDatabases: Map<string, AttachedDatabaseState>;  // databaseId -> AttachedDatabaseState
    attachedDatabasesByNotebook: Map<string, NotebookAttachedDatabases>;
    attachedDatabasesByType: string[][];  // arrays of databaseIds by connector type
    attachedDatabasesBySignature: ConnectionSignatureMap;
}

export interface NotebookAttachedDatabases {
    mainDatabaseId: string;
    attachedDatabaseIds: string[];
}

export interface ResolvedNotebookAttachedDatabases {
    main: AttachedDatabaseState;
    attached: AttachedDatabaseState[];
}

export function resolveNotebookAttachedDatabases(
    registry: AttachedDatabaseRegistry,
    notebookId: string | null,
): ResolvedNotebookAttachedDatabases | null {
    if (notebookId == null) return null;
    const mapping = registry.attachedDatabasesByNotebook.get(notebookId);
    if (mapping == null) return null;
    const main = registry.attachedDatabases.get(mapping.mainDatabaseId);
    if (main == null) return null;
    const attached = mapping.attachedDatabaseIds
        .map(databaseId => registry.attachedDatabases.get(databaseId))
        .filter((database): database is AttachedDatabaseState => database != null);
    if (attached.length !== mapping.attachedDatabaseIds.length) return null;
    return { main, attached };
}

export function resolveNotebookExecutionDatabase(
    registry: AttachedDatabaseRegistry,
    notebookId: string | null,
): AttachedDatabaseState | null {
    const mapping = notebookId == null ? null : registry.attachedDatabasesByNotebook.get(notebookId);
    if (mapping == null) return null;
    return registry.attachedDatabases.get(mapping.mainDatabaseId) ?? null;
}

export function findNotebookForAttachedDatabase(registry: AttachedDatabaseRegistry, databaseId: string): string | null {
    for (const [notebookId, mapping] of registry.attachedDatabasesByNotebook) {
        if (mapping.mainDatabaseId === databaseId || mapping.attachedDatabaseIds.includes(databaseId)) return notebookId;
    }
    return null;
}

export function didPersistedConnectionChange(prev: AttachedDatabaseState, next: AttachedDatabaseState): boolean {
    if (!prev.active && next.active) return true;
    return !connectionParamsEqual(prev.params, next.params) || !connectionParamsEqual(prev.paramsDraft, next.paramsDraft);
}

export type SetAttachedDatabaseRegistryAction = React.SetStateAction<AttachedDatabaseRegistry>;
export type AttachedDatabaseRole = 'main' | 'attached';
export type AttachedDatabaseAllocator = (notebookId: string, state: AttachedDatabaseStateWithoutId, role?: AttachedDatabaseRole) => AttachedDatabaseState;
export type AttachedDatabaseCloner = (state: AttachedDatabaseState) => AttachedDatabaseState;
export type AttachedDatabaseDispatch = (action: AttachedDatabaseAction) => void;
export type DynamicAttachedDatabaseDispatch = (databaseId: string | null, action: AttachedDatabaseAction) => void;

const ATTACHED_DATABASE_REGISTRY_CTX = React.createContext<[AttachedDatabaseRegistry, Dispatch<SetAttachedDatabaseRegistryAction>] | null>(null);

type Props = {
    children: React.ReactElement | React.ReactElement[];
};

export const AttachedDatabaseRegistry: React.FC<Props> = (props: Props) => {
    const [reg, setReg] = React.useState<AttachedDatabaseRegistry>(() => {
        return ({
            attachedDatabases: new Map(),
            attachedDatabasesByNotebook: new Map(),
            attachedDatabasesByType: CONNECTOR_TYPES.map(() => ([])),
            attachedDatabasesBySignature: new Map(),
        });
    });
    return (
        <ATTACHED_DATABASE_REGISTRY_CTX.Provider value={[reg, setReg]}>
            {props.children}
        </ATTACHED_DATABASE_REGISTRY_CTX.Provider>
    );
};

export function useAttachedDatabaseStateAllocator(): AttachedDatabaseAllocator {
    const [_reg, setReg] = React.useContext(ATTACHED_DATABASE_REGISTRY_CTX)!;
    return React.useCallback((notebookId: string, state: AttachedDatabaseStateWithoutId, role: AttachedDatabaseRole = 'main') => {
        const databaseId = crypto.randomUUID();
        const database: AttachedDatabaseState = { ...state, databaseId };
        setReg((reg) => {
            reg.attachedDatabases.set(databaseId, database);
            const current = reg.attachedDatabasesByNotebook.get(notebookId);
            if (role === 'main') {
                reg.attachedDatabasesByNotebook.set(notebookId, {
                    mainDatabaseId: databaseId,
                    attachedDatabaseIds: current?.attachedDatabaseIds ?? [],
                });
            } else {
                if (current == null) throw new Error(`cannot attach a database before the main database for notebook ${notebookId}`);
                reg.attachedDatabasesByNotebook.set(notebookId, {
                    ...current,
                    attachedDatabaseIds: [...current.attachedDatabaseIds, databaseId],
                });
            }
            reg.attachedDatabasesByType[state.connectorInfo.connectorType].push(databaseId);
            reg.attachedDatabasesBySignature.set(state.connectionSignature.signatureString, databaseId);
            return { ...reg };
        });
        // The caller writes newly committed notebooks. Subsequent edits and successful setups
        // persist through the dispatch boundary, including drafts before the first connection.
        return database;
    }, [setReg]);
}

export function useAttachedDatabaseRegistry(): [AttachedDatabaseRegistry, Dispatch<SetAttachedDatabaseRegistryAction>] {
    return React.useContext(ATTACHED_DATABASE_REGISTRY_CTX)!;
}

export function useDynamicAttachedDatabaseDispatch(): [AttachedDatabaseRegistry, DynamicAttachedDatabaseDispatch] {
    const [registry, setRegistry] = React.useContext(ATTACHED_DATABASE_REGISTRY_CTX)!;
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
                const next = reduceAttachedDatabaseState(prev, action, storageWriter, logger);
                const notebookId = findNotebookForAttachedDatabase(reg, databaseId);

                if (action.type == DELETE_ATTACHED_DATABASE) {
                    reg.attachedDatabasesBySignature.delete(connectionSignature);
                    reg.attachedDatabasesByType[connectorType] = reg.attachedDatabasesByType[connectorType].filter(id => id != databaseId);
                    for (const [notebookId, mapping] of reg.attachedDatabasesByNotebook) {
                        if (mapping.mainDatabaseId === databaseId) {
                            reg.attachedDatabasesByNotebook.delete(notebookId);
                        } else if (mapping.attachedDatabaseIds.includes(databaseId)) {
                            reg.attachedDatabasesByNotebook.set(notebookId, {
                                ...mapping,
                                attachedDatabaseIds: mapping.attachedDatabaseIds.filter(id => id !== databaseId),
                            });
                        }
                    }
                    reg.attachedDatabases.delete(databaseId);
                } else {
                    reg.attachedDatabases.set(databaseId, next);
                    // Update type index when connector type changes
                    if (action.type == SWITCH_CONNECTOR_TYPE && next.connectorInfo.connectorType !== connectorType) {
                        reg.attachedDatabasesByType[connectorType] = reg.attachedDatabasesByType[connectorType].filter(id => id != databaseId);
                        reg.attachedDatabasesByType[next.connectorInfo.connectorType].push(databaseId);
                        // Update signature
                        reg.attachedDatabasesBySignature.delete(connectionSignature);
                        reg.attachedDatabasesBySignature.set(next.connectionSignature.signatureString, databaseId);
                    }
                    if (notebookId != null) {
                        if (didPersistedConnectionChange(prev, next)) {
                            void storageWriter.write(
                                groupNotebookConnectionWrites(notebookId),
                                {
                                    type: WRITE_NOTEBOOK_MANIFEST,
                                    value: [notebookId, mappingMainDatabaseId(reg, notebookId), notebookAttachedDatabaseStates(reg, notebookId)],
                                },
                                DEBOUNCE_DURATION_NOTEBOOK_WRITE,
                            );
                        }
                        if (next.active && databaseId === mappingMainDatabaseId(reg, notebookId)
                            && (action.type === CATALOG_UPDATE_SUCCEEDED || action.type === CATALOG_UPDATE_PARTIALLY_SUCCEEDED)) {
                            void storageWriter.write(
                                groupNotebookSchemaWrites(notebookId),
                                { type: WRITE_NOTEBOOK_CATALOG_SCRIPT, value: [notebookId, next.catalogRelationScript] },
                                DEBOUNCE_DURATION_NOTEBOOK_WRITE,
                            );
                            void storageWriter.write(
                                groupNotebookFunctionWrites(notebookId),
                                { type: WRITE_NOTEBOOK_FUNCTION_SCRIPT, value: [notebookId, next.catalogFunctionScript] },
                                DEBOUNCE_DURATION_NOTEBOOK_WRITE,
                            );
                        }
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
        // a microtask cascade that repeatedly rerenders the notebook before the browser gets a
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

    return [registry, dispatch];
}

function notebookAttachedDatabaseStates(registry: AttachedDatabaseRegistry, notebookId: string): AttachedDatabaseState[] {
    const mapping = registry.attachedDatabasesByNotebook.get(notebookId);
    if (mapping == null) return [];
    const databases = [
        registry.attachedDatabases.get(mapping.mainDatabaseId),
        ...mapping.attachedDatabaseIds.map(databaseId => registry.attachedDatabases.get(databaseId)),
    ];
    return databases.filter((database): database is AttachedDatabaseState => database != null);
}

function mappingMainDatabaseId(registry: AttachedDatabaseRegistry, notebookId: string): string {
    const mapping = registry.attachedDatabasesByNotebook.get(notebookId);
    if (mapping == null) throw new Error(`no attached databases registered for notebook ${notebookId}`);
    return mapping.mainDatabaseId;
}

export function useAttachedDatabaseState(notebookId: string | null): [AttachedDatabaseState | null, AttachedDatabaseDispatch] {
    const [registry, dispatch] = useDynamicAttachedDatabaseDispatch();
    const databaseId = resolveNotebookExecutionDatabase(registry, notebookId)?.databaseId ?? null;
    const capturingDispatch = React.useCallback((action: AttachedDatabaseAction) => dispatch(databaseId, action), [databaseId, dispatch]);
    return [databaseId == null ? null : (registry.attachedDatabases.get(databaseId) ?? null), capturingDispatch]
}

export function useNotebookAttachedDatabases(notebookId: string | null): ResolvedNotebookAttachedDatabases | null {
    const [registry] = useAttachedDatabaseRegistry();
    return resolveNotebookAttachedDatabases(registry, notebookId);
}

export function useNotebookExecutionDatabase(notebookId: string | null): AttachedDatabaseState | null {
    const [registry] = useAttachedDatabaseRegistry();
    return resolveNotebookExecutionDatabase(registry, notebookId);
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
