import * as React from 'react';

import { ANALYZE_OUTDATED_SCRIPT, SessionScripts, SessionScriptsAction, ScriptData, destroySessionScripts, reduceSessionScripts, sessionConnectionIds, sessionScriptListWrite } from './session_scripts.js';
import { Dispatch } from '../../../utils/variant.js';
import { UpdateQueue, useStore, useStoreState, useUpdateQueue } from '../../../utils/store.js';
import { createDefaultConnectionParamsForConnector } from '../../connections/connection_params.js';
import { useStorageWriter } from '../../storage/storage_provider.js';
import { ConnectionReferencesProvider, type ConnectionReferences } from '../../connections/connection_registry.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { stringifyError } from '../../../platform/logger/logger.js';
import type { InvalidSession } from '../../storage/session_validation.js';
import {
    REPLACE_SESSION_SCRIPTS,
    DEBOUNCE_DURATION_SESSION_WRITE,
    type SessionReplacement,
    groupSessionScriptListWrites,
    groupSessionWrites,
    WRITE_SESSION_SCRIPTS,
} from "../../storage/storage_writer.js";

const LOG_CTX = 'session_scripts_registry';

/// The scripts registry.
///
/// Note that we're deliberately not using immutable maps for session scripts and the connection index.
/// We're never "observing" these maps directly and thus can live with the simple variants.
/// Shallow-compare the entire registry object instead when reacting to session list changes.
export interface SessionScriptsRegistry {
    /// The scripts map (sessionId -> SessionScripts)
    sessionScriptsMap: Map<string, SessionScripts>;
    /// The index to find the sessions with scripts that analyze with a connection (connectionId -> sessionIds)
    sessionScriptsByConnection: Map<string, string[]>;
    /// The sessions that were refused a load (sessionId -> reason). They never enter the scripts map,
    /// the workbench lists them as invalid and they can only be deleted.
    invalidSessions: Map<string, InvalidSession>;
}

export type SetSessionScriptsRegistryAction = React.SetStateAction<SessionScriptsRegistry>;
export type SessionScriptsAllocator = (scripts: SessionScripts) => [string, SessionScripts];
export type ModifySessionScripts = (action: SessionScriptsAction) => Promise<SessionScripts | null> | void;
export type ModifyConnectionSessionScripts = (conn: string, action: SessionScriptsAction) => void;

// The registry changes with every editor update while the setter is stable.
// Hooks that only modify the registry subscribe to the setter context and don't re-render on every update.
const SESSION_SCRIPTS_REGISTRY_CTX = React.createContext<SessionScriptsRegistry | null>(null);
const SESSION_SCRIPTS_REGISTRY_SETTER_CTX = React.createContext<Dispatch<SetSessionScriptsRegistryAction> | null>(null);
// The session script actions of all components are applied in order through one queue
const SESSION_SCRIPTS_REGISTRY_QUEUE_CTX = React.createContext<UpdateQueue<SessionScriptsRegistry> | null>(null);

type Props = {};

export const SessionScriptsRegistryProvider: React.FC<React.PropsWithChildren<Props>> = (props: React.PropsWithChildren<Props>) => {
    // Reducing session scripts mutates Wasm objects and schedules storage writes, the store runs every update once
    const store = useStore<SessionScriptsRegistry>(() => ({
        sessionScriptsMap: new Map(),
        sessionScriptsByConnection: new Map(),
        invalidSessions: new Map(),
    }));
    const queue = useUpdateQueue(store);
    const reg = useStoreState(store);
    // The scripts own the references to their connections, the connection layer reads them from here
    const references = React.useMemo<ConnectionReferences>(() => sessionConnectionReferences(store), [store]);
    return (
        <ConnectionReferencesProvider value={references}>
            <SESSION_SCRIPTS_REGISTRY_QUEUE_CTX.Provider value={queue}>
                <SESSION_SCRIPTS_REGISTRY_SETTER_CTX.Provider value={store.update}>
                    <SESSION_SCRIPTS_REGISTRY_CTX.Provider value={reg}>
                        {props.children}
                    </SESSION_SCRIPTS_REGISTRY_CTX.Provider>
                </SESSION_SCRIPTS_REGISTRY_SETTER_CTX.Provider>
            </SESSION_SCRIPTS_REGISTRY_QUEUE_CTX.Provider>
        </ConnectionReferencesProvider>
    );
};

/// The connections that the sessions of a scripts registry use
export function sessionConnectionReferences(registry: { current: SessionScriptsRegistry; subscribe: (listener: () => void) => () => void }): ConnectionReferences {
    return {
        sessionsOf: connectionId => registry.current.sessionScriptsByConnection.get(connectionId) ?? [],
        connectionsOf: sessionId => {
            const scripts = registry.current.sessionScriptsMap.get(sessionId);
            return scripts == null ? [] : sessionConnectionIds(scripts);
        },
        subscribe: registry.subscribe,
    };
}

export function useSessionScriptsRegistry(): [SessionScriptsRegistry, Dispatch<SetSessionScriptsRegistryAction>] {
    return [React.useContext(SESSION_SCRIPTS_REGISTRY_CTX)!, React.useContext(SESSION_SCRIPTS_REGISTRY_SETTER_CTX)!];
}

/// Modify the registry without subscribing to its changes
export function useSessionScriptsRegistrySetter(): Dispatch<SetSessionScriptsRegistryAction> {
    return React.useContext(SESSION_SCRIPTS_REGISTRY_SETTER_CTX)!;
}

/// The sessions that were refused a load
export interface InvalidSessions {
    /// The invalid sessions (sessionId -> reason)
    invalidSessions: ReadonlyMap<string, InvalidSession>;
    /// Delete the files of an invalid session and drop it from the list
    deleteInvalidSession: (sessionId: string) => Promise<void>;
}

export function useInvalidSessions(): InvalidSessions {
    const reg = React.useContext(SESSION_SCRIPTS_REGISTRY_CTX)!;
    const setReg = React.useContext(SESSION_SCRIPTS_REGISTRY_SETTER_CTX)!;
    const storage = useStorageWriter();
    const logger = useLogger();
    const deleteInvalidSession = React.useCallback(async (sessionId: string) => {
        try {
            await storage.deleteSession(sessionId);
        } catch (error) {
            logger.error('Failed to delete invalid session', { sessionId, error: stringifyError(error) }, LOG_CTX);
        }
        setReg(reg => {
            if (!reg.invalidSessions.has(sessionId)) return reg;
            const invalidSessions = new Map(reg.invalidSessions);
            invalidSessions.delete(sessionId);
            return { ...reg, invalidSessions };
        });
    }, [logger, setReg, storage]);
    return React.useMemo(() => ({ invalidSessions: reg.invalidSessions, deleteInvalidSession }), [reg.invalidSessions, deleteInvalidSession]);
}

export function useSessionScriptsAllocator(): SessionScriptsAllocator {
    const storage = useStorageWriter();
    const setReg = React.useContext(SESSION_SCRIPTS_REGISTRY_SETTER_CTX)!;
    return React.useCallback((state: SessionScripts) => {
        const sessionId = state.sessionId;
        const scripts: SessionScripts = { ...state };

        // Modify the registry
        setReg((reg) => {
            if (scripts.sessionMetadata.originalFileName == "") {
                scripts.sessionMetadata.originalFileName = `${scripts.connectorInfo.names.fileShort}`;
            }

            for (const connectionId of sessionConnectionIds(scripts)) {
                addSessionScriptsForConnection(reg, connectionId, sessionId);
            }
            reg.sessionScriptsMap.set(sessionId, scripts);
            return { ...reg };
        });

        storage.write(groupSessionWrites(scripts.sessionId), {
            type: REPLACE_SESSION_SCRIPTS,
            value: sessionReplacement(scripts),
        }, DEBOUNCE_DURATION_SESSION_WRITE);
        // Scheduled after the session file is written, the script list has a single writer
        storage.write(groupSessionScriptListWrites(scripts.sessionId), {
            type: WRITE_SESSION_SCRIPTS,
            value: [scripts.sessionId, sessionScriptListWrite(scripts)],
        }, DEBOUNCE_DURATION_SESSION_WRITE);
        return [sessionId, scripts];
    }, [setReg, storage]);
}

/// The write of a whole session, its script texts are read when the write runs
export function sessionReplacement(scripts: SessionScripts): SessionReplacement {
    return {
        sessionId: scripts.sessionId,
        name: scripts.name,
        scripts: scripts.scriptOrder.flatMap(fileName => {
            const script = scripts.scripts[scripts.scriptRefs[fileName]?.scriptId];
            return script == null ? [] : [{
                fileName,
                readText: () => script.scriptSession.getText(),
            }];
        }),
        defaultConnection: {
            connectionId: scripts.connectionId,
            params: createDefaultConnectionParamsForConnector(scripts.connectorInfo),
        },
        originalFileName: scripts.sessionMetadata.originalFileName,
        settings: scripts.settings,
    };
}

/// Record that a session analyzes its scripts with a connection (mutates the registry)
export function addSessionScriptsForConnection(reg: SessionScriptsRegistry, connectionId: string, sessionId: string): void {
    const sessions = reg.sessionScriptsByConnection.get(connectionId) ?? [];
    if (!sessions.includes(sessionId)) {
        reg.sessionScriptsByConnection.set(connectionId, [...sessions, sessionId]);
    }
}

/// Follow the connections of a session's scripts in the connection index (mutates the registry)
export function reindexSessionScriptConnections(reg: SessionScriptsRegistry, prev: SessionScripts, next: SessionScripts): void {
    if (prev.scripts === next.scripts && prev.connectionId === next.connectionId) return;
    const prevIds = new Set(sessionConnectionIds(prev));
    const nextIds = new Set(sessionConnectionIds(next));
    for (const connectionId of prevIds) {
        if (!nextIds.has(connectionId)) removeSessionScriptsForConnection(reg, connectionId, next.sessionId);
    }
    for (const connectionId of nextIds) {
        if (!prevIds.has(connectionId)) addSessionScriptsForConnection(reg, connectionId, next.sessionId);
    }
}

/// Drop a session from the scripts of a connection (mutates the registry)
export function removeSessionScriptsForConnection(reg: SessionScriptsRegistry, connectionId: string, sessionId: string): void {
    const sessions = (reg.sessionScriptsByConnection.get(connectionId) ?? []).filter(id => id !== sessionId);
    if (sessions.length === 0) {
        reg.sessionScriptsByConnection.delete(connectionId);
    } else {
        reg.sessionScriptsByConnection.set(connectionId, sessions);
    }
}

/// Remove a session from all three registry indices.
///
/// Pure and idempotent (a missing entry is a no-op), so it is safe to run inside a React state
/// updater that may be invoked more than once. It touches no Wasm — freeing the session's Wasm is
/// the caller's responsibility and must happen separately (see useSessionScriptsDeletion), because that
/// teardown is order-sensitive against the shared connection catalog.
export function removeSessionScriptsFromRegistry(reg: SessionScriptsRegistry, sessionId: string): SessionScriptsRegistry {
    const entry = reg.sessionScriptsMap.get(sessionId);
    if (!entry) return reg;
    reg.sessionScriptsMap.delete(sessionId);
    for (const connectionId of sessionConnectionIds(entry)) {
        removeSessionScriptsForConnection(reg, connectionId, sessionId);
    }
    return { ...reg };
}

/// Delete a session's scripts and free their Wasm.
///
/// Session scripts share the connection's catalog by reference (see session_creation) and own every
/// editor session they create. destroySessionScripts() drops those editor sessions from the shared catalog and then frees
/// them, so it MUST run while that catalog is still alive, i.e.
/// *before* the connection is deleted (DELETE_CONNECTION destroys the catalog). We therefore tear
/// the Wasm down synchronously here, in the event handler, and keep the registry-map removal a
/// pure updater (safe to run more than once). Callers must invoke this before dispatching
/// DELETE_CONNECTION for the same session.
export function useSessionScriptsDeletion(): (sessionId: string) => void {
    const reg = React.useContext(SESSION_SCRIPTS_REGISTRY_CTX)!;
    const setReg = React.useContext(SESSION_SCRIPTS_REGISTRY_SETTER_CTX)!;
    return React.useCallback((sessionId: string) => {
        // Free the session-owned Wasm now, before the shared catalog can be destroyed. The
        // registry closure is recreated on every change, so this read is current at call time.
        const scripts = reg.sessionScriptsMap.get(sessionId);
        if (scripts) {
            destroySessionScripts(scripts);
        }
        // Drop the entry from all three indices.
        setReg((prev) => removeSessionScriptsFromRegistry(prev, sessionId));
    }, [reg, setReg]);
}

export function useSessionScripts(id: string | null): [SessionScripts | null, ModifySessionScripts] {
    const registry = React.useContext(SESSION_SCRIPTS_REGISTRY_CTX)!;
    const queue = React.useContext(SESSION_SCRIPTS_REGISTRY_QUEUE_CTX)!;
    const storageWriter = useStorageWriter();
    const logger = useLogger();

    /// Wrapper to modify an individual session scripts collection
    const dispatch = React.useCallback((action: SessionScriptsAction) => {
        if (id == null) return Promise.resolve(null);
        return new Promise<SessionScripts | null>((resolve) => {
            logger.debug('Queued session script action', {
                sessionId: id,
                actionType: action.type.description ?? action.type.toString(),
            }, LOG_CTX);
            queue.push(reg => {
                const prev = reg.sessionScriptsMap.get(id);
                if (!prev) {
                    logger.warn('No session scripts registered for session', { sessionId: id }, LOG_CTX);
                    resolve(null);
                    return reg;
                }
                const next = reduceSessionScripts(prev, action, storageWriter, logger);
                resolve(next);
                // Keep the registry identity for no-ops (e.g. re-selecting the hovered script)
                if (next === prev) return reg;
                reg.sessionScriptsMap.set(id, next);
                reindexSessionScriptConnections(reg, prev, next);
                return { ...reg };
            });
        });
    }, [id, queue, storageWriter, logger]);

    return [id == null ? null : registry.sessionScriptsMap.get(id) ?? null, dispatch];
};

/// Return a script with current analysis, synchronizing session state first when necessary.
export async function ensureSessionScriptAnalyzed(
    sessionScripts: SessionScripts,
    scriptKey: number,
    modifySessionScripts: ModifySessionScripts,
): Promise<ScriptData | null> {
    const scriptData = sessionScripts.scripts[scriptKey];
    if (!scriptData) return null;
    if (!scriptData.analysisOutdated) return scriptData;
    const result = modifySessionScripts({ type: ANALYZE_OUTDATED_SCRIPT, value: scriptKey });
    if (!result) return null;
    const next = await result;
    return next ? next.scripts[scriptKey] ?? null : null;
}

export function useConnectionScriptsDispatch(): ModifyConnectionSessionScripts {
    const queue = React.useContext(SESSION_SCRIPTS_REGISTRY_QUEUE_CTX)!;
    const storage = useStorageWriter();
    const logger = useLogger();

    return React.useCallback<ModifyConnectionSessionScripts>((conn: string, action: SessionScriptsAction) => {
        queue.push(reg => {
            let changed = false;
            // Every session with scripts that analyze with the connection receives the action
            for (const sessionId of [...(reg.sessionScriptsByConnection.get(conn) ?? [])]) {
                const prev = reg.sessionScriptsMap.get(sessionId);
                if (prev) {
                    const next = reduceSessionScripts(prev, action, storage, logger);
                    reg.sessionScriptsMap.set(sessionId, next);
                    reindexSessionScriptConnections(reg, prev, next);
                    changed ||= next !== prev;
                }
            }
            return changed ? { ...reg } : reg;
        });
    }, [queue, storage, logger]);
}
