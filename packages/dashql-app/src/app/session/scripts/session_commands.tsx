import * as React from 'react';

import { ConnectionHealth, printConnectionHealth } from '../../connections/attached_database_state.js';
import { ConnectorInfo } from '../../connections/connector_info.js';
import { KeyEventHandler, useKeyEvents } from '../../../utils/key_events.js';
import { getSelectedScriptRef, SELECT_NEXT_SCRIPT, SELECT_PREV_SCRIPT } from './session_scripts.js';
import { useCatalogLoaderQueue } from '../../connections/catalog_loader.js';
import { useAttachedDatabaseState } from '../../connections/attached_database_registry.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { useQueryExecutor } from '../../connections/query_executor.js';
import { useRouteContext } from '../../router/router.js';
import { useSessionScripts } from './session_scripts_registry.js';
import { isCatalogRefreshRunning } from '../../connections/catalog_update_state.js';
import { runSessionScript } from '../ui/rerun_query.js';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppConfig } from '../../config/app_config.js';
import { useAppSettingsReady } from '../../config/app_settings_sync.js';
import { SessionConnectionAttentionContext, useSessionConnectionAttention } from '../ui/session_connection_attention.js';

const LOG_CTX = "session_commands";

export enum SessionCommandType {
    ExecuteEditorQuery = 1,
    RefreshCatalog = 2,
    SaveSessionAsLink = 3,
    SaveQueryAsSql = 4,
    SaveQueryResultsAsArrow = 5,
    SelectPreviousSessionScript = 6,
    SelectNextSessionScript = 7,
    EditSessionConnection = 8,
    CloseSession = 9,
}

export type ScriptCommandDispatch = (command: SessionCommandType) => void;

interface Props {
    children?: React.ReactElement | React.ReactElement[];
    dependencies?: SessionCommandsDependencies;
}

export interface SessionCommandsDependencies {
    useSessionScripts: typeof useSessionScripts;
    useAttachedDatabaseState: typeof useAttachedDatabaseState;
    useQueryExecutor: typeof useQueryExecutor;
    useCatalogLoaderQueue: typeof useCatalogLoaderQueue;
    useLogger: typeof useLogger;
    useAppConfig: typeof useAppConfig;
    useAppSettingsReady: typeof useAppSettingsReady;
}

const DEFAULT_DEPENDENCIES: SessionCommandsDependencies = {
    useSessionScripts, useAttachedDatabaseState,
    useQueryExecutor, useCatalogLoaderQueue, useLogger, useAppConfig, useAppSettingsReady,
};

const COMMAND_DISPATCH_CTX = React.createContext<ScriptCommandDispatch | null>(null);
export const useSessionCommandDispatch = () => React.useContext(COMMAND_DISPATCH_CTX)!;

export enum SessionViewMode {
    Session = 0,
    Shell = 1,
    Dashboard = 2,
}

export interface SessionViewModeContextValue {
    mode: SessionViewMode;
    setMode: React.Dispatch<React.SetStateAction<SessionViewMode>>;
}
const SESSION_VIEW_MODE_CTX = React.createContext<SessionViewModeContextValue | null>(null);
export const useSessionViewMode = () => React.useContext(SESSION_VIEW_MODE_CTX)!;

export function sessionViewModeFromSearch(search: string, dashboardsEnabled: boolean): SessionViewMode {
    return dashboardsEnabled && new URLSearchParams(search).get('view') === 'dashboard'
        ? SessionViewMode.Dashboard
        : SessionViewMode.Session;
}

export function sessionViewSearch(search: string, mode: SessionViewMode): string {
    const params = new URLSearchParams(search);
    if (mode === SessionViewMode.Dashboard) params.set('view', 'dashboard');
    else params.delete('view');
    const next = params.toString();
    return next ? `?${next}` : '';
}

export function sessionViewNavigation(
    location: { pathname: string; search: string; hash: string; state: unknown },
    mode: SessionViewMode,
) {
    return {
        to: {
            pathname: location.pathname,
            search: sessionViewSearch(location.search, mode),
            hash: location.hash,
        },
        options: { replace: true as const, state: location.state },
    };
}

export const SessionCommands: React.FC<Props> = (props: Props) => {
    const dependencies = props.dependencies ?? DEFAULT_DEPENDENCIES;
    const route = useRouteContext();
    const location = useLocation();
    const navigate = useNavigate();
    const logger = dependencies.useLogger();
    const dashboardsEnabled = dependencies.useAppConfig()?.settings?.experimental_dashboards === true;
    const settingsReady = dependencies.useAppSettingsReady();

    const [sessionScripts, modifySessionScripts] = dependencies.useSessionScripts(route.sessionId ?? null);
    const [connection, _dispatchConnection] = dependencies.useAttachedDatabaseState(sessionScripts?.sessionId ?? null);
    const connectionAttention = useSessionConnectionAttention(sessionScripts?.sessionId ?? null, connection?.databaseId ?? null, connection?.connectionHealth);
    const executeQuery = dependencies.useQueryExecutor();
    const refreshCatalog = dependencies.useCatalogLoaderQueue();
    const [sessionViewMode, setSessionViewModeState] = React.useState(() => sessionViewModeFromSearch(location.search, dashboardsEnabled));
    const visibleViewMode = !dashboardsEnabled && sessionViewMode === SessionViewMode.Dashboard
        ? SessionViewMode.Session : sessionViewMode;
    const sessionViewModeRef = React.useRef(visibleViewMode);
    const pendingViewSearchRef = React.useRef<string | null>(null);
    sessionViewModeRef.current = visibleViewMode;
    const setSessionViewMode = React.useCallback<React.Dispatch<React.SetStateAction<SessionViewMode>>>((update) => {
        const next = typeof update === 'function' ? update(sessionViewModeRef.current) : update;
        const allowed = next === SessionViewMode.Dashboard && !dashboardsEnabled ? SessionViewMode.Session : next;
        sessionViewModeRef.current = allowed;
        setSessionViewModeState(allowed);
        const navigation = sessionViewNavigation(location, allowed);
        if (navigation.to.search !== location.search) {
            pendingViewSearchRef.current = navigation.to.search;
            navigate(navigation.to, navigation.options);
        }
    }, [dashboardsEnabled, location.pathname, location.search, location.hash, location.state, navigate]);
    const sessionViewModeValue = React.useMemo<SessionViewModeContextValue>(
        () => ({ mode: visibleViewMode, setMode: setSessionViewMode }),
        [visibleViewMode, setSessionViewMode],
    );

    React.useEffect(() => {
        if (!settingsReady) return;
        if (!dashboardsEnabled) {
            pendingViewSearchRef.current = null;
            if (sessionViewMode === SessionViewMode.Dashboard) {
                sessionViewModeRef.current = SessionViewMode.Session;
                setSessionViewModeState(SessionViewMode.Session);
            }
            if (new URLSearchParams(location.search).get('view') === 'dashboard') {
                const navigation = sessionViewNavigation(location, SessionViewMode.Session);
                navigate(navigation.to, navigation.options);
            }
            return;
        }
        if (pendingViewSearchRef.current != null) {
            if (pendingViewSearchRef.current === location.search) pendingViewSearchRef.current = null;
            return;
        }
        const requested = sessionViewModeFromSearch(location.search, dashboardsEnabled);
        if (requested === SessionViewMode.Dashboard && sessionViewModeRef.current !== requested) {
            sessionViewModeRef.current = requested;
            setSessionViewModeState(requested);
        } else if (requested !== SessionViewMode.Dashboard && sessionViewModeRef.current === SessionViewMode.Dashboard) {
            sessionViewModeRef.current = SessionViewMode.Session;
            setSessionViewModeState(SessionViewMode.Session);
        }
    }, [dashboardsEnabled, settingsReady, location.search, navigate]);

    // Setup command dispatch logic.
    // The session scripts change with every keystroke and the connection with every query event.
    // Read them through a ref to keep the dispatch (and the context value) stable.
    const latest = React.useRef({ sessionScripts, modifySessionScripts, connection, connectionAttention, executeQuery, refreshCatalog, sessionId: route.sessionId });
    latest.current = { sessionScripts, modifySessionScripts, connection, connectionAttention, executeQuery, refreshCatalog, sessionId: route.sessionId };
    const commandDispatch = React.useCallback(
        async (command: SessionCommandType) => {
            const { sessionScripts, modifySessionScripts, connection, connectionAttention, executeQuery, refreshCatalog, sessionId } = latest.current;
            if (sessionScripts == null) {
                logger.warn("Session is null", {});
                return;
            }
            switch (command) {
                // Execute the query script in the current session
                case SessionCommandType.ExecuteEditorQuery:
                    logger.info("Ctrl+E session command received", {
                        sessionId,
                        viewMode: sessionViewModeRef.current.toString(),
                        connectionHealth: printConnectionHealth(connection?.connectionHealth ?? ConnectionHealth.NOT_STARTED),
                        focusedFile: sessionScripts.scriptFocus.fileName,
                    }, LOG_CTX);
                    if (sessionViewModeRef.current !== SessionViewMode.Session) {
                        logger.warn("Ignoring Ctrl+E outside session view", { sessionId }, LOG_CTX);
                        break;
                    }
                    if (connection == null || connection.connectionHealth !== ConnectionHealth.ONLINE) {
                        connectionAttention.request(sessionScripts.sessionId);
                        logger.warn("Cannot execute query command with an unhealthy connection", {
                            sessionId,
                            status: printConnectionHealth(connection?.connectionHealth ?? ConnectionHealth.NOT_STARTED)
                        }, LOG_CTX);
                    } else {
                        const entry = getSelectedScriptRef(sessionScripts);
                        if (!entry) {
                            logger.warn("Ignoring Ctrl+E because no committed script is selected", {
                                sessionId,
                                focusedFile: sessionScripts.scriptFocus.fileName,
                            }, LOG_CTX);
                            break;
                        }
                        const scriptData = sessionScripts.scripts[entry.scriptId];
                        if (!scriptData) {
                            logger.warn("Ignoring Ctrl+E because selected script data is missing", {
                                sessionId,
                                scriptKey: entry.scriptId.toString(),
                            }, LOG_CTX);
                            break;
                        }
                        await runSessionScript(
                            connection.databaseId,
                            sessionScripts,
                            scriptData,
                            executeQuery,
                            modifySessionScripts,
                            logger,
                        );
                    }
                    break;
                case SessionCommandType.RefreshCatalog:
                    if (connection?.connectionHealth != ConnectionHealth.ONLINE) {
                        logger.warn("Cannot refresh the catalog of unhealthy connection", {}, LOG_CTX);
                    } else if (isCatalogRefreshRunning(connection)) {
                        logger.debug("Catalog refresh already running", { sessionId: sessionScripts.sessionId }, LOG_CTX);
                    } else {
                        refreshCatalog(connection.databaseId, true);
                    }
                    break;
                case SessionCommandType.CloseSession: {
                    break;
                }

                case SessionCommandType.SaveSessionAsLink:
                    console.log('Save session as link');
                    break;
                case SessionCommandType.SaveQueryAsSql:
                    console.log('Save query as sql command');
                    break;
                case SessionCommandType.SaveQueryResultsAsArrow:
                    console.log('Save query results as arrow');
                    break;
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
                case SessionCommandType.EditSessionConnection:
                    // Connection settings are now handled via overlay in the UI
                    break;
            }
        },
        [logger],
    );

    // Helper to require connector info
    const requireConnector = (handler: (connectorInfo: ConnectorInfo) => () => void) => {
        const connectorInfo = sessionScripts?.connectorInfo ?? null;
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
                callback: () => commandDispatch(SessionCommandType.ExecuteEditorQuery),
            },
            {
                key: 'r',
                ctrlKey: true,
                callback: requireConnector(c =>
                    !c.features.refreshSchemaAction
                        ? () => commandNotImplemented(c, 'REFRESH_SCHEMA')
                        : () => commandDispatch(SessionCommandType.RefreshCatalog),
                ),
            },
            {
                key: 's',
                ctrlKey: true,
                callback: () => commandDispatch(SessionCommandType.SaveQueryAsSql),
            },
            {
                key: 'a',
                ctrlKey: true,
                callback: requireConnector(c =>
                    !c.features.executeQueryAction
                        ? () => commandNotImplemented(c, 'SAVE_QUERY_RESULTS_AS_ARROW')
                        : () => commandDispatch(SessionCommandType.SaveQueryResultsAsArrow),
                ),
            },
                    // Ctrl+H / Ctrl+L (page-bar navigation) and Ctrl+J / Ctrl+K (feed navigation) are
                    // handled in the session page, where the meta tabs (relations/functions) and the
            // editing/details view state are in scope. They fold the meta tabs into the same
            // left/right stepping and become no-ops when the feed isn't showing. They are
            // intentionally not bound here to avoid double-handling the key.
        ],
        [sessionScripts?.connectorInfo, commandDispatch],
    );

    // Setup key event handlers
    useKeyEvents(keyHandlers);

    return (
        <SessionConnectionAttentionContext.Provider value={connectionAttention}>
            <COMMAND_DISPATCH_CTX.Provider value={commandDispatch}>
                <SESSION_VIEW_MODE_CTX.Provider value={sessionViewModeValue}>
                    {props.children}
                </SESSION_VIEW_MODE_CTX.Provider>
            </COMMAND_DISPATCH_CTX.Provider>
        </SessionConnectionAttentionContext.Provider>
    );
};
