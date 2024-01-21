import React from 'react';
import { KeyEventHandler, useKeyEvents } from '../utils/key_events';
import { SELECT_NEXT_CONNECTOR, useConnectorSelection, useSelectedConnector } from '../connectors/connector_selection';
import { ConnectorInfo } from '../connectors/connector_info';
import { FULL_CATALOG_REFRESH } from '../connectors/catalog_update';
import { useScriptStateDispatch } from './script_state_provider';
import { EXECUTE_QUERY, UPDATE_CATALOG } from './script_state_reducer';

export enum ScriptCommandType {
    NextConnector = 0,
    ExecuteQuery = 1,
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

export const ScriptCommands: React.FC<Props> = (props: Props) => {
    const connector = useSelectedConnector();
    const stateDispatch = useScriptStateDispatch();
    const selectConnector = useConnectorSelection();

    // Setup command dispatch logic
    const commandDispatch = React.useCallback(
        async (command: ScriptCommandType) => {
            switch (command) {
                case ScriptCommandType.NextConnector:
                    selectConnector({ type: SELECT_NEXT_CONNECTOR, value: null });
                    break;
                case ScriptCommandType.ExecuteQuery:
                    stateDispatch({
                        type: EXECUTE_QUERY,
                        value: null,
                    });
                    break;
                case ScriptCommandType.RefreshSchema:
                    stateDispatch({
                        type: UPDATE_CATALOG,
                        value: {
                            type: FULL_CATALOG_REFRESH,
                            value: null,
                        },
                    });
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
        [connector],
    );
    // Helper to signal that a command is not implemented
    const commandNotImplemented = (connector: ConnectorInfo, actionName: string) => {
        console.warn(`connector '${connector.displayName.long}' does not implement the command '${actionName}'`);
    };
    // Create key event handlers
    const keyHandlers = React.useMemo<KeyEventHandler[]>(
        () => [
            {
                key: 'n',
                ctrlKey: true,
                callback: () => commandDispatch(ScriptCommandType.NextConnector),
            },
            {
                key: 'e',
                ctrlKey: true,
                callback: !connector.features.executeQueryAction
                    ? () => commandNotImplemented(connector, 'EXECUTE_QUERY')
                    : () => commandDispatch(ScriptCommandType.ExecuteQuery),
            },
            {
                key: 'r',
                ctrlKey: true,
                callback: !connector.features.executeQueryAction
                    ? () => commandNotImplemented(connector, 'REFRESH_SCHEMA')
                    : () => commandDispatch(ScriptCommandType.RefreshSchema),
            },
            {
                key: 'l',
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
                callback: !connector.features.executeQueryAction
                    ? () => commandNotImplemented(connector, 'SAVE_QUERY_RESULTS_AS_ARROW')
                    : () => commandDispatch(ScriptCommandType.SaveQueryResultsAsArrow),
            },
        ],
        [connector, commandDispatch],
    );

    // Setup key event handlers
    useKeyEvents(keyHandlers);

    return <COMMAND_DISPATCH_CTX.Provider value={commandDispatch}>{props.children}</COMMAND_DISPATCH_CTX.Provider>;
};
