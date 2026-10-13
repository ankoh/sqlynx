import * as React from 'react';

import { ANALYZE_OUTDATED_SCRIPT, NotebookScripts, NotebookScriptsAction, ScriptData, destroyNotebookScripts, reduceNotebookScripts } from './notebook_scripts.js';
import { Dispatch } from '../../../utils/variant.js';
import type { DashQLScript } from '@ankoh/dashql-core';
import { CONNECTOR_TYPES, ConnectorType } from '../connections/connector_info.js';
import { useStorageWriter } from '../persistence/storage_provider.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import {
    REPLACE_NOTEBOOK_SCRIPTS,
    DEBOUNCE_DURATION_NOTEBOOK_WRITE,
    groupNotebookFunctionWrites,
    groupNotebookWrites,
    WRITE_NOTEBOOK_FUNCTION_SCRIPT,
} from "../persistence/storage_writer.js";

const LOG_CTX = 'notebook_scripts_registry';

/// The scripts registry.
///
/// Note that we're deliberately not using immutable maps for notebook scripts and the connection index.
/// We're never "observing" these maps directly and thus can live with the simple variants.
/// Shallow-compare the entire registry object instead when reacting to notebook list changes.
export interface NotebookScriptsRegistry {
    /// The scripts map (notebookId -> NotebookScripts)
    notebookScriptsMap: Map<string, NotebookScripts>;
    /// The index to find scripts associated with a connection (connectionId -> notebookId)
    notebookScriptsByConnection: Map<string, string>;
    /// The index to find scripts associated with a connection type (arrays of notebookIds)
    notebookScriptsByConnectionType: string[][];
}

export type NotebookScriptsInput = NotebookScripts;
export type SetNotebookScriptsRegistryAction = React.SetStateAction<NotebookScriptsRegistry>;
export type NotebookScriptsAllocator = (
    scripts: NotebookScriptsInput,
    catalogFunctionScript: DashQLScript,
) => [string, NotebookScripts];
export type ModifyNotebookScripts = (action: NotebookScriptsAction) => Promise<NotebookScripts | null> | void;
export type ModifyConnectionNotebookScripts = (conn: string, action: NotebookScriptsAction) => void;

const NOTEBOOK_SCRIPTS_REGISTRY_CTX = React.createContext<[NotebookScriptsRegistry, Dispatch<SetNotebookScriptsRegistryAction>] | null>(null);

type Props = {};

export const NotebookScriptsRegistryProvider: React.FC<React.PropsWithChildren<Props>> = (props: React.PropsWithChildren<Props>) => {
    const reg = React.useState<NotebookScriptsRegistry>(() => ({
        notebookScriptsMap: new Map(),
        notebookScriptsByConnection: new Map(),
        notebookScriptsByConnectionType: CONNECTOR_TYPES.map(() => []),
    }));
    return (
        <NOTEBOOK_SCRIPTS_REGISTRY_CTX.Provider value={reg}>
            {props.children}
        </NOTEBOOK_SCRIPTS_REGISTRY_CTX.Provider>
    );
};

export function useNotebookScriptsRegistry(): [NotebookScriptsRegistry, Dispatch<SetNotebookScriptsRegistryAction>] {
    return React.useContext(NOTEBOOK_SCRIPTS_REGISTRY_CTX)!;
}

export function useNotebookScriptsAllocator(): NotebookScriptsAllocator {
    const storage = useStorageWriter();
    const [_reg, setReg] = React.useContext(NOTEBOOK_SCRIPTS_REGISTRY_CTX)!;
    return React.useCallback((state: NotebookScriptsInput, catalogFunctionScript: DashQLScript) => {
        const notebookId = state.notebookId;
        const scripts: NotebookScripts = { ...state };

        // Modify the registry
        setReg((reg) => {
            if (scripts.notebookMetadata.originalFileName == "") {
                scripts.notebookMetadata.originalFileName = `${scripts.connectorInfo.names.fileShort}`;
            }

            reg.notebookScriptsByConnection.set(state.databaseId, notebookId);
            reg.notebookScriptsByConnectionType[state.connectorInfo.connectorType].push(notebookId);
            reg.notebookScriptsMap.set(notebookId, scripts);
            return { ...reg };
        });

        storage.write(groupNotebookWrites(scripts.notebookId), {
            type: REPLACE_NOTEBOOK_SCRIPTS,
            value: scripts
        }, DEBOUNCE_DURATION_NOTEBOOK_WRITE);
        storage.write(groupNotebookFunctionWrites(scripts.notebookId), {
            type: WRITE_NOTEBOOK_FUNCTION_SCRIPT,
            value: [scripts.notebookId, catalogFunctionScript]
        }, DEBOUNCE_DURATION_NOTEBOOK_WRITE);
        return [notebookId, scripts];
    }, [setReg, storage]);
}

/// Remove a notebook from all three registry indices.
///
/// Pure and idempotent (a missing entry is a no-op), so it is safe to run inside a React state
/// updater that may be invoked more than once. It touches no Wasm — freeing the notebook's Wasm is
/// the caller's responsibility and must happen separately (see useNotebookScriptsDeletion), because that
/// teardown is order-sensitive against the shared connection catalog.
export function removeNotebookScriptsFromRegistry(reg: NotebookScriptsRegistry, notebookId: string): NotebookScriptsRegistry {
    const entry = reg.notebookScriptsMap.get(notebookId);
    if (!entry) return reg;
    reg.notebookScriptsMap.delete(notebookId);
    reg.notebookScriptsByConnection.delete(entry.databaseId);
    const connectorType = entry.connectorInfo.connectorType;
    reg.notebookScriptsByConnectionType[connectorType] =
        reg.notebookScriptsByConnectionType[connectorType].filter(id => id !== notebookId);
    return { ...reg };
}

/// Delete a notebook's scripts and free their Wasm.
///
/// Notebook scripts share the connection's catalog by reference (see notebook_scripts_setup) and own every
/// editor session they create. destroyNotebookScripts() drops those sessions from the shared catalog and then frees
/// them, so it MUST run while that catalog is still alive, i.e.
/// *before* the connection is deleted (DELETE_ATTACHED_DATABASE destroys the catalog). We therefore tear
/// the Wasm down synchronously here, in the event handler, and keep the registry-map removal a
/// pure updater (safe to run more than once). Callers must invoke this before dispatching
/// DELETE_ATTACHED_DATABASE for the same notebook.
export function useNotebookScriptsDeletion(): (notebookId: string) => void {
    const [reg, setReg] = React.useContext(NOTEBOOK_SCRIPTS_REGISTRY_CTX)!;
    return React.useCallback((notebookId: string) => {
        // Free the notebook-owned Wasm now, before the shared catalog can be destroyed. The
        // registry closure is recreated on every change, so this read is current at call time.
        const scripts = reg.notebookScriptsMap.get(notebookId);
        if (scripts) {
            destroyNotebookScripts(scripts);
        }
        // Drop the entry from all three indices.
        setReg((prev) => removeNotebookScriptsFromRegistry(prev, notebookId));
    }, [reg, setReg]);
}

export function useNotebookScripts(id: string | null): [NotebookScripts | null, ModifyNotebookScripts] {
    const [registry, setRegistry] = React.useContext(NOTEBOOK_SCRIPTS_REGISTRY_CTX)!;
    const storageWriter = useStorageWriter();
    const logger = useLogger();

    // Queue for batching rapid dispatch calls to avoid concurrent rendering issues
    const pendingActionsRef = React.useRef<Array<{
        notebookId: string;
        action: NotebookScriptsAction;
        resolve: (state: NotebookScripts | null) => void;
    }>>([]);
    const flushScheduledRef = React.useRef(false);

    // Flush all pending actions in a single state update
    const flushPendingActions = React.useCallback(() => {
        flushScheduledRef.current = false;
        const pending = pendingActionsRef.current;
        if (pending.length === 0) return;
        pendingActionsRef.current = [];
        logger.debug('Flushing notebook script actions', {
            notebookId: id,
            actionCount: pending.length.toString(),
            actionTypes: pending.map(({ action }) => action.type.description ?? action.type.toString()).join(','),
        }, LOG_CTX);

        setRegistry((reg: NotebookScriptsRegistry) => {
            for (const { notebookId, action, resolve } of pending) {
                const prev = reg.notebookScriptsMap.get(notebookId);
                if (!prev) {
                    logger.warn('No notebook scripts registered for notebook', { notebookId: id }, LOG_CTX);
                    resolve(null);
                    continue;
                }
                logger.debug('Reducing notebook script action', {
                    notebookId: id,
                    actionType: action.type.description ?? action.type.toString(),
                }, LOG_CTX);
                const next = reduceNotebookScripts(prev, action, storageWriter, logger, true);
                reg.notebookScriptsMap.set(notebookId, next);
                resolve(next);
            }
            return { ...reg };
        });
    }, [id, setRegistry, storageWriter, logger]);

    /// Wrapper to modify an individual notebook scripts collection
    const dispatch = React.useCallback((action: NotebookScriptsAction) => {
        if (id == null) return Promise.resolve(null);
        return new Promise<NotebookScripts | null>((resolve) => {
            logger.debug('Queued notebook script action', {
                notebookId: id,
                actionType: action.type.description ?? action.type.toString(),
                queueLength: (pendingActionsRef.current.length + 1).toString(),
            }, LOG_CTX);
            // Queue the action
            pendingActionsRef.current.push({ notebookId: id, action, resolve });

            // Schedule a flush if not already scheduled
            if (!flushScheduledRef.current) {
                flushScheduledRef.current = true;
                queueMicrotask(flushPendingActions);
            }
        });
    }, [id, flushPendingActions]);

    return [id == null ? null : registry.notebookScriptsMap.get(id) ?? null, dispatch];
};

/// Return a script with current analysis, synchronizing notebook state first when necessary.
export async function ensureNotebookScriptAnalyzed(
    notebookScripts: NotebookScripts,
    scriptKey: number,
    modifyNotebookScripts: ModifyNotebookScripts,
): Promise<ScriptData | null> {
    const scriptData = notebookScripts.scripts[scriptKey];
    if (!scriptData) return null;
    if (!scriptData.analysisOutdated) return scriptData;
    const result = modifyNotebookScripts({ type: ANALYZE_OUTDATED_SCRIPT, value: scriptKey });
    if (!result) return null;
    const next = await result;
    return next ? next.scripts[scriptKey] ?? null : null;
}

export function useConnectionScriptsDispatch(): ModifyConnectionNotebookScripts {
    const [_registry, setRegistry] = React.useContext(NOTEBOOK_SCRIPTS_REGISTRY_CTX)!;
    const storage = useStorageWriter();
    const logger = useLogger();

    // Queue for batching rapid dispatch calls to avoid concurrent rendering issues
    const pendingActionsRef = React.useRef<Array<{ conn: string; action: NotebookScriptsAction }>>([]);
    const flushScheduledRef = React.useRef(false);

    // Flush all pending actions in a single state update
    const flushPendingActions = React.useCallback(() => {
        flushScheduledRef.current = false;
        const actions = pendingActionsRef.current;
        if (actions.length === 0) return;
        pendingActionsRef.current = [];

        setRegistry((reg: NotebookScriptsRegistry) => {
            for (const { conn, action } of actions) {
                const notebookId = reg.notebookScriptsByConnection.get(conn);
                if (notebookId) {
                    const prev = reg.notebookScriptsMap.get(notebookId);
                    if (prev) {
                        const next = reduceNotebookScripts(prev, action, storage, logger, true);
                        reg.notebookScriptsMap.set(notebookId, next);
                    }
                }
            }
            return { ...reg };
        });
    }, [setRegistry, storage, logger]);

    const dispatch = React.useCallback<ModifyConnectionNotebookScripts>((conn: string, action: NotebookScriptsAction) => {
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
