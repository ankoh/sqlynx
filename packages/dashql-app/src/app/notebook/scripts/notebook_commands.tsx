import * as React from 'react';

import { ConnectionHealth, printConnectionHealth } from '../connections/attached_database_state.js';
import { ConnectorInfo } from '../connections/connector_info.js';
import { KeyEventHandler, useKeyEvents } from '../../../utils/key_events.js';
import { getSelectedScriptRef, SELECT_NEXT_SCRIPT, SELECT_PREV_SCRIPT } from './notebook_scripts.js';
import { useCatalogLoaderQueue } from '../connections/catalog_loader.js';
import { useAttachedDatabaseState } from '../connections/attached_database_registry.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { useQueryExecutor } from '../connections/query_executor.js';
import { useRouteContext } from '../../router/router.js';
import { useNotebookScripts } from './notebook_scripts_registry.js';
import { isCatalogRefreshRunning } from '../connections/catalog_update_state.js';
import { runNotebookScript } from '../ui/rerun_query.js';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppConfig } from '../../config/app_config.js';
import { useAppSettingsReady } from '../../config/app_settings_sync.js';
import { NotebookConnectionAttentionContext, useNotebookConnectionAttention } from '../ui/notebook_connection_attention.js';

const LOG_CTX = "notebook_commands";

export enum NotebookCommandType {
    ExecuteEditorQuery = 1,
    RefreshCatalog = 2,
    SaveNotebookAsLink = 3,
    SaveQueryAsSql = 4,
    SaveQueryResultsAsArrow = 5,
    SelectPreviousNotebookScript = 6,
    SelectNextNotebookScript = 7,
    EditNotebookConnection = 8,
    CloseNotebook = 9,
}

export type ScriptCommandDispatch = (command: NotebookCommandType) => void;

interface Props {
    children?: React.ReactElement | React.ReactElement[];
    dependencies?: NotebookCommandsDependencies;
}

export interface NotebookCommandsDependencies {
    useNotebookScripts: typeof useNotebookScripts;
    useAttachedDatabaseState: typeof useAttachedDatabaseState;
    useQueryExecutor: typeof useQueryExecutor;
    useCatalogLoaderQueue: typeof useCatalogLoaderQueue;
    useLogger: typeof useLogger;
    useAppConfig: typeof useAppConfig;
    useAppSettingsReady: typeof useAppSettingsReady;
}

const DEFAULT_DEPENDENCIES: NotebookCommandsDependencies = {
    useNotebookScripts, useAttachedDatabaseState,
    useQueryExecutor, useCatalogLoaderQueue, useLogger, useAppConfig, useAppSettingsReady,
};

const COMMAND_DISPATCH_CTX = React.createContext<ScriptCommandDispatch | null>(null);
export const useNotebookCommandDispatch = () => React.useContext(COMMAND_DISPATCH_CTX)!;

export enum NotebookViewMode {
    Notebook = 0,
    Shell = 1,
    Dashboard = 2,
}

export interface NotebookViewModeContextValue {
    mode: NotebookViewMode;
    setMode: React.Dispatch<React.SetStateAction<NotebookViewMode>>;
}
const NOTEBOOK_VIEW_MODE_CTX = React.createContext<NotebookViewModeContextValue | null>(null);
export const useNotebookViewMode = () => React.useContext(NOTEBOOK_VIEW_MODE_CTX)!;

export function notebookViewModeFromSearch(search: string, dashboardsEnabled: boolean): NotebookViewMode {
    return dashboardsEnabled && new URLSearchParams(search).get('view') === 'dashboard'
        ? NotebookViewMode.Dashboard
        : NotebookViewMode.Notebook;
}

export function notebookViewSearch(search: string, mode: NotebookViewMode): string {
    const params = new URLSearchParams(search);
    if (mode === NotebookViewMode.Dashboard) params.set('view', 'dashboard');
    else params.delete('view');
    const next = params.toString();
    return next ? `?${next}` : '';
}

export function notebookViewNavigation(
    location: { pathname: string; search: string; hash: string; state: unknown },
    mode: NotebookViewMode,
) {
    return {
        to: {
            pathname: location.pathname,
            search: notebookViewSearch(location.search, mode),
            hash: location.hash,
        },
        options: { replace: true as const, state: location.state },
    };
}

export const NotebookCommands: React.FC<Props> = (props: Props) => {
    const dependencies = props.dependencies ?? DEFAULT_DEPENDENCIES;
    const route = useRouteContext();
    const location = useLocation();
    const navigate = useNavigate();
    const logger = dependencies.useLogger();
    const dashboardsEnabled = dependencies.useAppConfig()?.settings?.enableDashboards === true;
    const settingsReady = dependencies.useAppSettingsReady();

    const [notebookScripts, modifyNotebookScripts] = dependencies.useNotebookScripts(route.notebookId ?? null);
    const [connection, _dispatchConnection] = dependencies.useAttachedDatabaseState(notebookScripts?.notebookId ?? null);
    const connectionAttention = useNotebookConnectionAttention(notebookScripts?.notebookId ?? null, connection?.databaseId ?? null, connection?.connectionHealth);
    const executeQuery = dependencies.useQueryExecutor();
    const refreshCatalog = dependencies.useCatalogLoaderQueue();
    const [notebookViewMode, setNotebookViewModeState] = React.useState(() => notebookViewModeFromSearch(location.search, dashboardsEnabled));
    const visibleViewMode = !dashboardsEnabled && notebookViewMode === NotebookViewMode.Dashboard
        ? NotebookViewMode.Notebook : notebookViewMode;
    const notebookViewModeRef = React.useRef(visibleViewMode);
    const pendingViewSearchRef = React.useRef<string | null>(null);
    notebookViewModeRef.current = visibleViewMode;
    const setNotebookViewMode = React.useCallback<React.Dispatch<React.SetStateAction<NotebookViewMode>>>((update) => {
        const next = typeof update === 'function' ? update(notebookViewModeRef.current) : update;
        const allowed = next === NotebookViewMode.Dashboard && !dashboardsEnabled ? NotebookViewMode.Notebook : next;
        notebookViewModeRef.current = allowed;
        setNotebookViewModeState(allowed);
        const navigation = notebookViewNavigation(location, allowed);
        if (navigation.to.search !== location.search) {
            pendingViewSearchRef.current = navigation.to.search;
            navigate(navigation.to, navigation.options);
        }
    }, [dashboardsEnabled, location.pathname, location.search, location.hash, location.state, navigate]);
    const notebookViewModeValue = React.useMemo<NotebookViewModeContextValue>(
        () => ({ mode: visibleViewMode, setMode: setNotebookViewMode }),
        [visibleViewMode, setNotebookViewMode],
    );

    React.useEffect(() => {
        if (!settingsReady) return;
        if (!dashboardsEnabled) {
            pendingViewSearchRef.current = null;
            if (notebookViewMode === NotebookViewMode.Dashboard) {
                notebookViewModeRef.current = NotebookViewMode.Notebook;
                setNotebookViewModeState(NotebookViewMode.Notebook);
            }
            if (new URLSearchParams(location.search).get('view') === 'dashboard') {
                const navigation = notebookViewNavigation(location, NotebookViewMode.Notebook);
                navigate(navigation.to, navigation.options);
            }
            return;
        }
        if (pendingViewSearchRef.current != null) {
            if (pendingViewSearchRef.current === location.search) pendingViewSearchRef.current = null;
            return;
        }
        const requested = notebookViewModeFromSearch(location.search, dashboardsEnabled);
        if (requested === NotebookViewMode.Dashboard && notebookViewModeRef.current !== requested) {
            notebookViewModeRef.current = requested;
            setNotebookViewModeState(requested);
        } else if (requested !== NotebookViewMode.Dashboard && notebookViewModeRef.current === NotebookViewMode.Dashboard) {
            notebookViewModeRef.current = NotebookViewMode.Notebook;
            setNotebookViewModeState(NotebookViewMode.Notebook);
        }
    }, [dashboardsEnabled, settingsReady, location.search, navigate]);

    // Setup command dispatch logic
    const commandDispatch = React.useCallback(
        async (command: NotebookCommandType) => {
            if (notebookScripts == null) {
                logger.warn("Notebook is null", {});
                return;
            }
            switch (command) {
                // Execute the query script in the current notebook
                case NotebookCommandType.ExecuteEditorQuery:
                    logger.info("Ctrl+E notebook command received", {
                        notebookId: route.notebookId,
                        viewMode: notebookViewModeRef.current.toString(),
                        connectionHealth: printConnectionHealth(connection?.connectionHealth ?? ConnectionHealth.NOT_STARTED),
                        focusedFile: notebookScripts.scriptFocus.fileName,
                    }, LOG_CTX);
                    if (notebookViewModeRef.current !== NotebookViewMode.Notebook) {
                        logger.warn("Ignoring Ctrl+E outside notebook view", { notebookId: route.notebookId }, LOG_CTX);
                        break;
                    }
                    if (connection == null || connection.connectionHealth !== ConnectionHealth.ONLINE) {
                        connectionAttention.request(notebookScripts.notebookId);
                        logger.warn("Cannot execute query command with an unhealthy connection", {
                            notebookId: route.notebookId,
                            status: printConnectionHealth(connection?.connectionHealth ?? ConnectionHealth.NOT_STARTED)
                        }, LOG_CTX);
                    } else {
                        const entry = getSelectedScriptRef(notebookScripts);
                        if (!entry) {
                            logger.warn("Ignoring Ctrl+E because no committed script is selected", {
                                notebookId: route.notebookId,
                                focusedFile: notebookScripts.scriptFocus.fileName,
                            }, LOG_CTX);
                            break;
                        }
                        const scriptData = notebookScripts.scripts[entry.scriptId];
                        if (!scriptData) {
                            logger.warn("Ignoring Ctrl+E because selected script data is missing", {
                                notebookId: route.notebookId,
                                scriptKey: entry.scriptId.toString(),
                            }, LOG_CTX);
                            break;
                        }
                        await runNotebookScript(
                            connection.databaseId,
                            notebookScripts,
                            scriptData,
                            executeQuery,
                            modifyNotebookScripts,
                            logger,
                        );
                    }
                    break;
                case NotebookCommandType.RefreshCatalog:
                    if (connection?.connectionHealth != ConnectionHealth.ONLINE) {
                        logger.warn("Cannot refresh the catalog of unhealthy connection", {}, LOG_CTX);
                    } else if (isCatalogRefreshRunning(connection)) {
                        logger.debug("Catalog refresh already running", { notebookId: notebookScripts.notebookId }, LOG_CTX);
                    } else {
                        refreshCatalog(connection.databaseId, true);
                    }
                    break;
                case NotebookCommandType.CloseNotebook: {
                    break;
                }

                case NotebookCommandType.SaveNotebookAsLink:
                    console.log('Save notebook as link');
                    break;
                case NotebookCommandType.SaveQueryAsSql:
                    console.log('Save query as sql command');
                    break;
                case NotebookCommandType.SaveQueryResultsAsArrow:
                    console.log('Save query results as arrow');
                    break;
                case NotebookCommandType.SelectPreviousNotebookScript:
                    if (modifyNotebookScripts) {
                        modifyNotebookScripts({
                            type: SELECT_PREV_SCRIPT,
                            value: null,
                        });
                    }
                    break;
                case NotebookCommandType.SelectNextNotebookScript:
                    if (modifyNotebookScripts) {
                        modifyNotebookScripts({
                            type: SELECT_NEXT_SCRIPT,
                            value: null,
                        });
                    }
                    break;
                case NotebookCommandType.EditNotebookConnection:
                    // Connection settings are now handled via overlay in the UI
                    break;
            }
        },
        [connection, notebookScripts, notebookScripts?.connectorInfo, connectionAttention.request],
    );

    // Helper to require connector info
    const requireConnector = (handler: (connectorInfo: ConnectorInfo) => () => void) => {
        const connectorInfo = notebookScripts?.connectorInfo ?? null;
        if (connectorInfo == null) {
            return () => console.warn(`Command requires an active connector`);
        } else {
            return handler(connectorInfo);
        }
    };

    // Helper to signal that a command is not implemented
    const commandNotImplemented = (connector: ConnectorInfo, actionName: string) => {
        console.warn(`Connector '${connector.names.displayLong}' does not implement the command '${actionName}'`);
    };
    // Create key event handlers
    const keyHandlers = React.useMemo<KeyEventHandler[]>(
        () => [
            {
                key: 'e',
                ctrlKey: true,
                callback: () => commandDispatch(NotebookCommandType.ExecuteEditorQuery),
            },
            {
                key: 'r',
                ctrlKey: true,
                callback: requireConnector(c =>
                    !c.features.refreshSchemaAction
                        ? () => commandNotImplemented(c, 'REFRESH_SCHEMA')
                        : () => commandDispatch(NotebookCommandType.RefreshCatalog),
                ),
            },
            {
                key: 's',
                ctrlKey: true,
                callback: () => commandDispatch(NotebookCommandType.SaveQueryAsSql),
            },
            {
                key: 'a',
                ctrlKey: true,
                callback: requireConnector(c =>
                    !c.features.executeQueryAction
                        ? () => commandNotImplemented(c, 'SAVE_QUERY_RESULTS_AS_ARROW')
                        : () => commandDispatch(NotebookCommandType.SaveQueryResultsAsArrow),
                ),
            },
                    // Ctrl+H / Ctrl+L (page-bar navigation) and Ctrl+J / Ctrl+K (feed navigation) are
                    // handled in the notebook page, where the meta tabs (relations/functions) and the
            // editing/details view state are in scope. They fold the meta tabs into the same
            // left/right stepping and become no-ops when the feed isn't showing. They are
            // intentionally not bound here to avoid double-handling the key.
        ],
        [notebookScripts?.connectorInfo, commandDispatch],
    );

    // Setup key event handlers
    useKeyEvents(keyHandlers);

    return (
        <NotebookConnectionAttentionContext.Provider value={connectionAttention}>
            <COMMAND_DISPATCH_CTX.Provider value={commandDispatch}>
                <NOTEBOOK_VIEW_MODE_CTX.Provider value={notebookViewModeValue}>
                    {props.children}
                </NOTEBOOK_VIEW_MODE_CTX.Provider>
            </COMMAND_DISPATCH_CTX.Provider>
        </NotebookConnectionAttentionContext.Provider>
    );
};
