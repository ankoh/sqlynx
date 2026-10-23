import * as React from 'react';

import { ConnectionHealth, printConnectionHealth, type ConnectionState } from '../../connections/connection_state.js';
import { KeyEventHandler, useKeyEvents } from '../../../utils/key_events.js';
import { getSelectedScriptRef, SELECT_NEXT_SCRIPT, SELECT_PREV_SCRIPT, type ScriptData, type SessionScripts } from './session_scripts.js';
import type { ScriptRef } from './script_types.js';
import { useCatalogLoaderQueue } from '../../connections/catalog_loader.js';
import { useConnectionRegistryStore, useDefaultConnection, type ConnectionRegistry } from '../../connections/connection_registry.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { useQueryExecutor } from '../../connections/query_executor.js';
import { useRouteContext } from '../../router/router.js';
import { useSessionScripts } from './session_scripts_registry.js';
import { isCatalogRefreshRunning } from '../../connections/catalog_update_state.js';
import { runSessionScript } from '../ui/rerun_query.js';
import { SessionConnectionAttentionContext, useSessionConnectionAttention } from '../ui/session_connection_attention.js';
import { SessionViewMode, useSessionViewMode } from '../ui/session_view_mode.js';

const LOG_CTX = "session_commands";

/// The selected script and the connection it runs on, the default connection without a selected script
function selectedScriptConnection(sessionScripts: SessionScripts, registry: ConnectionRegistry, defaultConnection: ConnectionState | null): {
    entry: ScriptRef | undefined;
    scriptData: ScriptData | undefined;
    scriptConnection: ConnectionState | null;
} {
    const entry = getSelectedScriptRef(sessionScripts);
    const scriptData = entry != null ? sessionScripts.scripts[entry.scriptId] : undefined;
    const scriptConnection = scriptData != null
        ? registry.connections.get(scriptData.connection.connectionId) ?? null
        : defaultConnection;
    return { entry, scriptData, scriptConnection };
}

export enum SessionCommandType {
    ExecuteEditorQuery = 1,
    RefreshCatalog = 2,
    SelectPreviousSessionScript = 6,
    SelectNextSessionScript = 7,
}

export type ScriptCommandDispatch = (command: SessionCommandType) => void;

interface Props {
    children?: React.ReactElement | React.ReactElement[];
    dependencies?: SessionCommandsDependencies;
}

export interface SessionCommandsDependencies {
    useSessionScripts: typeof useSessionScripts;
    useDefaultConnection: typeof useDefaultConnection;
    useConnectionRegistryStore: typeof useConnectionRegistryStore;
    useQueryExecutor: typeof useQueryExecutor;
    useCatalogLoaderQueue: typeof useCatalogLoaderQueue;
    useLogger: typeof useLogger;
    useSessionViewMode: typeof useSessionViewMode;
}

const DEFAULT_DEPENDENCIES: SessionCommandsDependencies = {
    useSessionScripts, useDefaultConnection, useConnectionRegistryStore,
    useQueryExecutor, useCatalogLoaderQueue, useLogger, useSessionViewMode,
};

const COMMAND_DISPATCH_CTX = React.createContext<ScriptCommandDispatch | null>(null);
export const useSessionCommandDispatch = () => React.useContext(COMMAND_DISPATCH_CTX)!;

export const SessionCommands: React.FC<Props> = (props: Props) => {
    const dependencies = props.dependencies ?? DEFAULT_DEPENDENCIES;
    const route = useRouteContext();
    const logger = dependencies.useLogger();
    const viewMode = dependencies.useSessionViewMode().mode;

    const [sessionScripts, modifySessionScripts] = dependencies.useSessionScripts(route.sessionId ?? null);
    const [connection, _dispatchConnection] = dependencies.useDefaultConnection(sessionScripts?.sessionId ?? null);
    const connectionRegistryStore = dependencies.useConnectionRegistryStore();
    const connectionAttention = useSessionConnectionAttention(sessionScripts?.sessionId ?? null, connection?.connectionId ?? null, connection?.connectionHealth);
    const executeQuery = dependencies.useQueryExecutor();
    const refreshCatalog = dependencies.useCatalogLoaderQueue();

    // Setup command dispatch logic.
    // The session scripts change with every keystroke and the connection with every query event.
    // Read them through a ref to keep the dispatch (and the context value) stable.
    const latest = React.useRef({ sessionScripts, modifySessionScripts, connection, connectionAttention, executeQuery, refreshCatalog, viewMode, sessionId: route.sessionId });
    latest.current = { sessionScripts, modifySessionScripts, connection, connectionAttention, executeQuery, refreshCatalog, viewMode, sessionId: route.sessionId };
    const commandDispatch = React.useCallback(
        async (command: SessionCommandType) => {
            const { sessionScripts, modifySessionScripts, connection, connectionAttention, executeQuery, refreshCatalog, viewMode, sessionId } = latest.current;
            if (sessionScripts == null) {
                logger.warn("Session is null", {});
                return;
            }
            switch (command) {
                // Execute the query script in the current session
                case SessionCommandType.ExecuteEditorQuery:
                    logger.info("Ctrl+E session command received", {
                        sessionId,
                        viewMode: viewMode.toString(),
                        connectionHealth: printConnectionHealth(connection?.connectionHealth ?? ConnectionHealth.NOT_STARTED),
                        focusedFile: sessionScripts.scriptFocus.fileName,
                    }, LOG_CTX);
                    if (viewMode !== SessionViewMode.Session) {
                        logger.warn("Ignoring Ctrl+E outside session view", { sessionId }, LOG_CTX);
                        break;
                    }
                    {
                        const { entry, scriptData, scriptConnection } = selectedScriptConnection(sessionScripts, connectionRegistryStore.current, connection);
                        if (scriptConnection == null || scriptConnection.connectionHealth !== ConnectionHealth.ONLINE) {
                            connectionAttention.request(sessionScripts.sessionId);
                            logger.warn("Cannot execute query command with an unhealthy connection", {
                                sessionId,
                                status: printConnectionHealth(scriptConnection?.connectionHealth ?? ConnectionHealth.NOT_STARTED)
                            }, LOG_CTX);
                        } else if (!entry) {
                            logger.warn("Ignoring Ctrl+E because no committed script is selected", {
                                sessionId,
                                focusedFile: sessionScripts.scriptFocus.fileName,
                            }, LOG_CTX);
                        } else if (!scriptData) {
                            logger.warn("Ignoring Ctrl+E because selected script data is missing", {
                                sessionId,
                                scriptKey: entry.scriptId.toString(),
                            }, LOG_CTX);
                        } else {
                            await runSessionScript(
                                sessionScripts,
                                scriptData,
                                executeQuery,
                                modifySessionScripts,
                                logger,
                            );
                        }
                    }
                    break;
                case SessionCommandType.RefreshCatalog: {
                    // The catalog of the connection that the selected script runs on is refreshed
                    const { scriptConnection } = selectedScriptConnection(sessionScripts, connectionRegistryStore.current, connection);
                    if (scriptConnection?.connectionHealth != ConnectionHealth.ONLINE) {
                        logger.warn("Cannot refresh the catalog of unhealthy connection", {}, LOG_CTX);
                    } else if (isCatalogRefreshRunning(scriptConnection)) {
                        logger.debug("Catalog refresh already running", { sessionId: sessionScripts.sessionId }, LOG_CTX);
                    } else {
                        refreshCatalog(scriptConnection.connectionId, true);
                    }
                    break;
                }
                case SessionCommandType.SelectPreviousSessionScript:
                    if (modifySessionScripts) {
                        modifySessionScripts({
                            type: SELECT_PREV_SCRIPT,
                            value: null,
                        });
                    }
                    break;
                case SessionCommandType.SelectNextSessionScript:
                    if (modifySessionScripts) {
                        modifySessionScripts({
                            type: SELECT_NEXT_SCRIPT,
                            value: null,
                        });
                    }
                    break;
            }
        },
        [logger],
    );

    // Create key event handlers
    const keyHandlers = React.useMemo<KeyEventHandler[]>(
        () => [
            {
                key: 'e',
                ctrlKey: true,
                callback: () => commandDispatch(SessionCommandType.ExecuteEditorQuery),
            },
            {
                key: 'r',
                ctrlKey: true,
                callback: () => commandDispatch(SessionCommandType.RefreshCatalog),
            },
            // Ctrl+H / Ctrl+L (page-bar navigation) and Ctrl+J / Ctrl+K (feed navigation) are
            // handled in the session page, where the meta tabs (relations/functions) and the
            // editing/details view state are in scope. They fold the meta tabs into the same
            // left/right stepping and become no-ops when the feed isn't showing. They are
            // intentionally not bound here to avoid double-handling the key.
        ],
        [commandDispatch],
    );

    // Setup key event handlers
    useKeyEvents(keyHandlers);

    return (
        <SessionConnectionAttentionContext.Provider value={connectionAttention}>
            <COMMAND_DISPATCH_CTX.Provider value={commandDispatch}>
                {props.children}
            </COMMAND_DISPATCH_CTX.Provider>
        </SessionConnectionAttentionContext.Provider>
    );
};
