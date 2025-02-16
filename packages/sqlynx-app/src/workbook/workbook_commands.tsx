import * as React from 'react';

import { KeyEventHandler, useKeyEvents } from '../utils/key_events.js';
import { ConnectorInfo } from '../connection/connector_info.js';
import { useCurrentWorkbookState } from './current_workbook.js';
import { useQueryExecutor } from '../connection/query_executor.js';
import { useConnectionState } from '../connection/connection_registry.js';
import { ConnectionHealth } from '../connection/connection_state.js';
import { useLogger } from '../platform/logger_provider.js';
import { REGISTER_QUERY } from './workbook_state.js';

export enum WorkbookCommandType {
    ExecuteEditorQuery = 1,
    RefreshSchema = 2,
    SaveWorkbookAsLink = 3,
    SaveQueryAsSql = 4,
    SaveQueryResultsAsArrow = 5,
}

export type ScriptCommandDispatch = (command: WorkbookCommandType) => void;

interface Props {
    children?: React.ReactElement | React.ReactElement[];
}

const COMMAND_DISPATCH_CTX = React.createContext<ScriptCommandDispatch | null>(null);
export const useWorkbookCommandDispatch = () => React.useContext(COMMAND_DISPATCH_CTX)!;

export const WorkbookCommands: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const [workbook, dispatchWorkbook] = useCurrentWorkbookState();
    const [connection, _dispatchConnection] = useConnectionState(workbook?.connectionId ?? null);
    const executeQuery = useQueryExecutor();

    // Setup command dispatch logic
    const commandDispatch = React.useCallback(
        async (command: WorkbookCommandType) => {
            if (workbook == null) {
                logger.error("workbook is null", {});
                return;
            }
            switch (command) {
                // Execute the query script in the current workbook
                case WorkbookCommandType.ExecuteEditorQuery:
                    if (connection!.connectionHealth != ConnectionHealth.ONLINE) {
                        logger.error("cannot execute query command with an unhealthy connection", {});
                    } else {
                        const entry = workbook.workbookEntries[workbook.selectedWorkbookEntry];
                        const script = workbook.scripts[entry.scriptKey];
                        const mainScriptText = script.toString();
                        const [queryId, _run] = executeQuery(workbook.connectionId, {
                            query: mainScriptText,
                            analyzeResults: true
                        });
                        dispatchWorkbook({
                            type: REGISTER_QUERY,
                            value: [workbook.selectedWorkbookEntry, script.scriptKey, queryId]
                        })
                    }
                    break;
                case WorkbookCommandType.RefreshSchema:
                    // XXX
                    // modifySession({
                    //     type: UPDATE_CATALOG,
                    //     value: {
                    //         type: FULL_CATALOG_REFRESH,
                    //         value: null,
                    //     },
                    // });
                    break;
                case WorkbookCommandType.SaveWorkbookAsLink:
                    console.log('save workbook as link');
                    break;
                case WorkbookCommandType.SaveQueryAsSql:
                    console.log('save query as sql command');
                    break;
                case WorkbookCommandType.SaveQueryResultsAsArrow:
                    console.log('save query results as arrow');
                    break;
            }
        },
        [connection, workbook, workbook?.connectorInfo],
    );

    // Helper to require connector info
    const requireConnector = (handler: (connectorInfo: ConnectorInfo) => () => void) => {
        const connectorInfo = workbook?.connectorInfo ?? null;
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
                        : () => commandDispatch(WorkbookCommandType.ExecuteEditorQuery),
                ),
            },
            {
                key: 'r',
                ctrlKey: true,
                callback: requireConnector(c =>
                    !c.features.executeQueryAction
                        ? () => commandNotImplemented(c, 'REFRESH_SCHEMA')
                        : () => commandDispatch(WorkbookCommandType.RefreshSchema),
                ),
            },
            {
                key: 'u',
                ctrlKey: true,
                callback: () => commandDispatch(WorkbookCommandType.SaveWorkbookAsLink),
            },
            {
                key: 's',
                ctrlKey: true,
                callback: () => commandDispatch(WorkbookCommandType.SaveQueryAsSql),
            },
            {
                key: 'a',
                ctrlKey: true,
                callback: requireConnector(c =>
                    !c.features.executeQueryAction
                        ? () => commandNotImplemented(c, 'SAVE_QUERY_RESULTS_AS_ARROW')
                        : () => commandDispatch(WorkbookCommandType.SaveQueryResultsAsArrow),
                ),
            },
        ],
        [workbook?.connectorInfo, commandDispatch],
    );

    // Setup key event handlers
    useKeyEvents(keyHandlers);

    return <COMMAND_DISPATCH_CTX.Provider value={commandDispatch}>{props.children}</COMMAND_DISPATCH_CTX.Provider>;
};
