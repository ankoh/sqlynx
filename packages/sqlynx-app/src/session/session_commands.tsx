import * as React from 'react';

import { KeyEventHandler, useKeyEvents } from '../utils/key_events.js';
import { ConnectorInfo } from '../connectors/connector_info.js';
import { useCurrentSessionState } from './current_session.js';
import { useQueryExecutor } from '../connectors/query_executor.js';
import { useConnectionState } from '../connectors/connection_registry.js';
import { ConnectionHealth } from '../connectors/connection_state.js';
import { useLogger } from '../platform/logger_provider.js';
import { REGISTER_EDITOR_QUERY, ScriptKey } from './session_state.js';

export enum ScriptCommandType {
    ExecuteEditorQuery = 1,
    RefreshSchema = 2,
    SaveQueryAsSql = 3,
    SaveQueryAsLink = 4,
    SaveQueryResultsAsArrow = 5,
}

export type ScriptCommandDispatch = (command: ScriptCommandType) => void;

interface Props {
    children?: React.ReactElement | React.ReactElement[];
}

const COMMAND_DISPATCH_CTX = React.createContext<ScriptCommandDispatch | null>(null);

export const SessionCommands: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const [session, dispatchSession] = useCurrentSessionState();
    const [connection, _dispatchConnection] = useConnectionState(session?.connectionId ?? null);
    const executeQuery = useQueryExecutor();

    // Setup command dispatch logic
    const commandDispatch = React.useCallback(
        async (command: ScriptCommandType) => {
            if (session == null) {
                logger.error("session is null");
                return;
            }
            switch (command) {
                // Execute the query script in the current session
                case ScriptCommandType.ExecuteEditorQuery:
                    if (connection!.connectionHealth != ConnectionHealth.ONLINE) {
                        logger.error("cannot execute query command with an unhealthy connection");
                    } else {
                        const mainScript = session.scripts[ScriptKey.MAIN_SCRIPT];
                        const mainScriptText = mainScript.script!.toString();
                        const [queryId, _run] = executeQuery(session.connectionId, {
                            query: mainScriptText
                        });
                        dispatchSession({
                            type: REGISTER_EDITOR_QUERY,
                            value: queryId
                        })
                    }
                    break;
                case ScriptCommandType.RefreshSchema:
                    // XXX
                    // modifySession({
                    //     type: UPDATE_CATALOG,
                    //     value: {
                    //         type: FULL_CATALOG_REFRESH,
                    //         value: null,
                    //     },
                    // });
                    break;
                case ScriptCommandType.SaveQueryAsSql:
                    console.log('save query as sql command');
                    break;
                case ScriptCommandType.SaveQueryAsLink:
                    console.log('save query as sql link');
                    break;
                case ScriptCommandType.SaveQueryResultsAsArrow:
                    console.log('save query results as arrow');
                    break;
            }
        },
        [connection, session, session?.connectorInfo],
    );

    // Helper to require connector info
    const requireConnector = (handler: (connectorInfo: ConnectorInfo) => () => void) => {
        const connectorInfo = session?.connectorInfo ?? null;
        if (connectorInfo == null) {
            return () => console.warn(`command requires an active connector`);
        } else {
            return handler(connectorInfo);
        }
    };

    // Helper to signal that a command is not implemented
    const commandNotImplemented = (connector: ConnectorInfo, actionName: string) => {
        console.warn(`connector '${connector.displayName.long}' does not implement the command '${actionName}'`);
    };
    // Create key event handlers
    const keyHandlers = React.useMemo<KeyEventHandler[]>(
        () => [
            {
                key: 'e',
                ctrlKey: true,
                callback: requireConnector(c =>
                    !c.features.executeQueryAction
                        ? () => commandNotImplemented(c, 'EXECUTE_QUERY')
                        : () => commandDispatch(ScriptCommandType.ExecuteEditorQuery),
                ),
            },
            {
                key: 'r',
                ctrlKey: true,
                callback: requireConnector(c =>
                    !c.features.executeQueryAction
                        ? () => commandNotImplemented(c, 'REFRESH_SCHEMA')
                        : () => commandDispatch(ScriptCommandType.RefreshSchema),
                ),
            },
            {
                key: 'u',
                ctrlKey: true,
                callback: () => commandDispatch(ScriptCommandType.SaveQueryAsLink),
            },
            {
                key: 's',
                ctrlKey: true,
                callback: () => commandDispatch(ScriptCommandType.SaveQueryAsSql),
            },
            {
                key: 'a',
                ctrlKey: true,
                callback: requireConnector(c =>
                    !c.features.executeQueryAction
                        ? () => commandNotImplemented(c, 'SAVE_QUERY_RESULTS_AS_ARROW')
                        : () => commandDispatch(ScriptCommandType.SaveQueryResultsAsArrow),
                ),
            },
        ],
        [session?.connectorInfo, commandDispatch],
    );

    // Setup key event handlers
    useKeyEvents(keyHandlers);

    return <COMMAND_DISPATCH_CTX.Provider value={commandDispatch}>{props.children}</COMMAND_DISPATCH_CTX.Provider>;
};
