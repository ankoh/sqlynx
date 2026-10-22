import * as React from 'react';

import { ANALYZE_OUTDATED_SCRIPT, SessionScripts, SessionScriptsAction, ScriptData, destroySessionScripts, reduceSessionScripts } from './session_scripts.js';
import { Dispatch } from '../../../utils/variant.js';
import type { DashQLScript } from '@ankoh/dashql-core';
import { CONNECTOR_TYPES, ConnectorType } from '../connections/connector_info.js';
import { useStorageWriter } from '../persistence/storage_provider.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import {
    REPLACE_SESSION_SCRIPTS,
    DEBOUNCE_DURATION_SESSION_WRITE,
    groupSessionFunctionWrites,
    groupSessionWrites,
    WRITE_SESSION_FUNCTION_SCRIPT,
} from "../persistence/storage_writer.js";

const LOG_CTX = 'session_scripts_registry';

/// The scripts registry.
///
/// Note that we're deliberately not using immutable maps for session scripts and the connection index.
/// We're never "observing" these maps directly and thus can live with the simple variants.
/// Shallow-compare the entire registry object instead when reacting to session list changes.
export interface SessionScriptsRegistry {
    /// The scripts map (sessionId -> SessionScripts)
    sessionScriptsMap: Map<string, SessionScripts>;
    /// The index to find the scripts of sessions that analyze with a connection (connectionId -> sessionIds)
    sessionScriptsByConnection: Map<string, string[]>;
    /// The index to find scripts associated with a connection type (arrays of sessionIds)
    sessionScriptsByConnectionType: string[][];
}

export type SessionScriptsInput = SessionScripts;
export type SetSessionScriptsRegistryAction = React.SetStateAction<SessionScriptsRegistry>;
export type SessionScriptsAllocator = (
    scripts: SessionScriptsInput,
    catalogFunctionScript: DashQLScript,
) => [string, SessionScripts];
export type ModifySessionScripts = (action: SessionScriptsAction) => Promise<SessionScripts | null> | void;
export type ModifyConnectionSessionScripts = (conn: string, action: SessionScriptsAction) => void;

// The registry changes with every editor update while the setter is stable.
// Hooks that only modify the registry subscribe to the setter context and don't re-render on every update.
const SESSION_SCRIPTS_REGISTRY_CTX = React.createContext<SessionScriptsRegistry | null>(null);
const SESSION_SCRIPTS_REGISTRY_SETTER_CTX = React.createContext<Dispatch<SetSessionScriptsRegistryAction> | null>(null);

type Props = {};

export const SessionScriptsRegistryProvider: React.FC<React.PropsWithChildren<Props>> = (props: React.PropsWithChildren<Props>) => {
    const [reg, setReg] = React.useState<SessionScriptsRegistry>(() => ({
        sessionScriptsMap: new Map(),
        sessionScriptsByConnection: new Map(),
        sessionScriptsByConnectionType: CONNECTOR_TYPES.map(() => []),
    }));
    return (
        <SESSION_SCRIPTS_REGISTRY_SETTER_CTX.Provider value={setReg}>
            <SESSION_SCRIPTS_REGISTRY_CTX.Provider value={reg}>
                {props.children}
            </SESSION_SCRIPTS_REGISTRY_CTX.Provider>
        </SESSION_SCRIPTS_REGISTRY_SETTER_CTX.Provider>
    );
};

export function useSessionScriptsRegistry(): [SessionScriptsRegistry, Dispatch<SetSessionScriptsRegistryAction>] {
    return [React.useContext(SESSION_SCRIPTS_REGISTRY_CTX)!, React.useContext(SESSION_SCRIPTS_REGISTRY_SETTER_CTX)!];
}

/// Modify the registry without subscribing to its changes
export function useSessionScriptsRegistrySetter(): Dispatch<SetSessionScriptsRegistryAction> {
    return React.useContext(SESSION_SCRIPTS_REGISTRY_SETTER_CTX)!;
}

export function useSessionScriptsAllocator(): SessionScriptsAllocator {
    const storage = useStorageWriter();
    const setReg = React.useContext(SESSION_SCRIPTS_REGISTRY_SETTER_CTX)!;
    return React.useCallback((state: SessionScriptsInput, catalogFunctionScript: DashQLScript) => {
        const sessionId = state.sessionId;
        const scripts: SessionScripts = { ...state };

        // Modify the registry
        setReg((reg) => {
            if (scripts.sessionMetadata.originalFileName == "") {
                scripts.sessionMetadata.originalFileName = `${scripts.connectorInfo.names.fileShort}`;
            }

            addSessionScriptsForConnection(reg, state.databaseId, sessionId);
            reg.sessionScriptsByConnectionType[state.connectorInfo.connectorType].push(sessionId);
            reg.sessionScriptsMap.set(sessionId, scripts);
            return { ...reg };
        });

        storage.write(groupSessionWrites(scripts.sessionId), {
            type: REPLACE_SESSION_SCRIPTS,
            value: scripts
        }, DEBOUNCE_DURATION_SESSION_WRITE);
        storage.write(groupSessionFunctionWrites(scripts.sessionId), {
            type: WRITE_SESSION_FUNCTION_SCRIPT,
            value: [scripts.sessionId, catalogFunctionScript]
        }, DEBOUNCE_DURATION_SESSION_WRITE);
        return [sessionId, scripts];
    }, [setReg, storage]);
}

/// Record that a session analyzes its scripts with a connection (mutates the registry)
export function addSessionScriptsForConnection(reg: SessionScriptsRegistry, connectionId: string, sessionId: string): void {
    const sessions = reg.sessionScriptsByConnection.get(connectionId) ?? [];
    if (!sessions.includes(sessionId)) {
        reg.sessionScriptsByConnection.set(connectionId, [...sessions, sessionId]);
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
    removeSessionScriptsForConnection(reg, entry.databaseId, sessionId);
    const connectorType = entry.connectorInfo.connectorType;
    reg.sessionScriptsByConnectionType[connectorType] =
        reg.sessionScriptsByConnectionType[connectorType].filter(id => id !== sessionId);
    return { ...reg };
}

/// Delete a session's scripts and free their Wasm.
///
/// Session scripts share the connection's catalog by reference (see session_scripts_setup) and own every
/// editor session they create. destroySessionScripts() drops those editor sessions from the shared catalog and then frees
/// them, so it MUST run while that catalog is still alive, i.e.
/// *before* the connection is deleted (DELETE_ATTACHED_DATABASE destroys the catalog). We therefore tear
/// the Wasm down synchronously here, in the event handler, and keep the registry-map removal a
/// pure updater (safe to run more than once). Callers must invoke this before dispatching
/// DELETE_ATTACHED_DATABASE for the same session.
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
    const setRegistry = React.useContext(SESSION_SCRIPTS_REGISTRY_SETTER_CTX)!;
    const storageWriter = useStorageWriter();
    const logger = useLogger();

    // Queue for batching rapid dispatch calls to avoid concurrent rendering issues
    const pendingActionsRef = React.useRef<Array<{
        sessionId: string;
        action: SessionScriptsAction;
        resolve: (state: SessionScripts | null) => void;
    }>>([]);
    const flushScheduledRef = React.useRef(false);

    // Flush all pending actions in a single state update
    const flushPendingActions = React.useCallback(() => {
        flushScheduledRef.current = false;
        const pending = pendingActionsRef.current;
        if (pending.length === 0) return;
        pendingActionsRef.current = [];
        logger.debug('Flushing session script actions', {
            sessionId: id,
            actionCount: pending.length.toString(),
            actionTypes: pending.map(({ action }) => action.type.description ?? action.type.toString()).join(','),
        }, LOG_CTX);

        setRegistry((reg: SessionScriptsRegistry) => {
            let changed = false;
            for (const { sessionId, action, resolve } of pending) {
                const prev = reg.sessionScriptsMap.get(sessionId);
                if (!prev) {
                    logger.warn('No session scripts registered for session', { sessionId: id }, LOG_CTX);
                    resolve(null);
                    continue;
                }
                logger.debug('Reducing session script action', {
                    sessionId: id,
                    actionType: action.type.description ?? action.type.toString(),
                }, LOG_CTX);
                const next = reduceSessionScripts(prev, action, storageWriter, logger, true);
                reg.sessionScriptsMap.set(sessionId, next);
                changed ||= next !== prev;
                resolve(next);
            }
            // Keep the registry identity if all actions were no-ops (e.g. re-selecting the hovered script)
            return changed ? { ...reg } : reg;
        });
    }, [id, setRegistry, storageWriter, logger]);

    /// Wrapper to modify an individual session scripts collection
    const dispatch = React.useCallback((action: SessionScriptsAction) => {
        if (id == null) return Promise.resolve(null);
        return new Promise<SessionScripts | null>((resolve) => {
            logger.debug('Queued session script action', {
                sessionId: id,
                actionType: action.type.description ?? action.type.toString(),
                queueLength: (pendingActionsRef.current.length + 1).toString(),
            }, LOG_CTX);
            // Queue the action
            pendingActionsRef.current.push({ sessionId: id, action, resolve });

            // Schedule a flush if not already scheduled
            if (!flushScheduledRef.current) {
                flushScheduledRef.current = true;
                queueMicrotask(flushPendingActions);
            }
        });
    }, [id, flushPendingActions]);

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
    const setRegistry = React.useContext(SESSION_SCRIPTS_REGISTRY_SETTER_CTX)!;
    const storage = useStorageWriter();
    const logger = useLogger();

    // Queue for batching rapid dispatch calls to avoid concurrent rendering issues
    const pendingActionsRef = React.useRef<Array<{ conn: string; action: SessionScriptsAction }>>([]);
    const flushScheduledRef = React.useRef(false);

    // Flush all pending actions in a single state update
    const flushPendingActions = React.useCallback(() => {
        flushScheduledRef.current = false;
        const actions = pendingActionsRef.current;
        if (actions.length === 0) return;
        pendingActionsRef.current = [];

        setRegistry((reg: SessionScriptsRegistry) => {
            let changed = false;
            for (const { conn, action } of actions) {
                // Every session that analyzes with the connection receives the action
                for (const sessionId of reg.sessionScriptsByConnection.get(conn) ?? []) {
                    const prev = reg.sessionScriptsMap.get(sessionId);
                    if (prev) {
                        const next = reduceSessionScripts(prev, action, storage, logger, true);
                        reg.sessionScriptsMap.set(sessionId, next);
                        changed ||= next !== prev;
                    }
                }
            }
            return changed ? { ...reg } : reg;
        });
    }, [setRegistry, storage, logger]);

    const dispatch = React.useCallback<ModifyConnectionSessionScripts>((conn: string, action: SessionScriptsAction) => {
        // Queue the action
        pendingActionsRef.current.push({ conn, action });

        // Schedule a flush if not already scheduled
        if (!flushScheduledRef.current) {
            flushScheduledRef.current = true;
            queueMicrotask(flushPendingActions);
        }
    }, [flushPendingActions]);

    return dispatch;
}
