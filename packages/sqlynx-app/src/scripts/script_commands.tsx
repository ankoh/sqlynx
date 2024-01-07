import React from 'react';
import { KeyEventHandler, useKeyEvents } from '../utils/key_events';
import { useSelectedConnector } from '../connectors/connector_selection';
import { Connector } from 'connectors/connector';

export const EXECUTE_QUERY = Symbol('EXECUTE_QUERY');
export const REFRESH_SCHEMA = Symbol('REFRESH_SCHEMA');
export const SAVE_QUERY_AS_LINK = Symbol('SAVE_QUERY_AS_LINK');
export const SAVE_QUERY_AS_SQL = Symbol('SAVE_QUERY_AS_SQL');
export const SAVE_QUERY_RESULTS_AS_ARROW = Symbol('SAVE_QUERY_RESULTS_AS_ARROW');

export enum ScriptCommandType {
    ExecuteQuery = 0,
    RefreshSchema = 1,
    SaveQueryAsSql = 2,
    SaveQueryAsLink = 3,
    SaveQueryResultsAsArrow = 4,
}

export type ScriptCommandDispatch = (command: ScriptCommandType) => void;

interface Props {
    children?: React.ReactElement | React.ReactElement[];
}

const COMMAND_DISPATCH_CTX = React.createContext<ScriptCommandDispatch | null>(null);

export const ScriptCommands: React.FC<Props> = (props: Props) => {
    const connector = useSelectedConnector();
    // const stateDispatch = useScriptStateDispatch();

    // Setup command dispatch logic
    const commandDispatch = React.useCallback(
        async (command: ScriptCommandType) => {
            switch (command) {
                case ScriptCommandType.ExecuteQuery:
                    break;
                case ScriptCommandType.RefreshSchema:
                    break;
                case ScriptCommandType.SaveQueryAsSql:
                    break;
                case ScriptCommandType.SaveQueryAsLink:
                    break;
                case ScriptCommandType.SaveQueryResultsAsArrow:
                    break;
            }
        },
        [connector],
    );
    // Helper to signal that a command is not implemented
    const commandNotImplemented = (connector: Connector, actionName: string) => {
        console.warn(`connector ${connector.displayName} does not implement the command '${actionName}'`);
    };
    // Create key event handlers
    const keyHandlers = React.useMemo<KeyEventHandler[]>(() => {
        return [
            {
                key: 'E',
                ctrlKey: true,
                callback: !connector.features.executeQueryAction
                    ? () => commandNotImplemented(connector, 'EXECUTE_QUERY')
                    : () => commandDispatch(ScriptCommandType.ExecuteQuery),
            },
            {
                key: 'R',
                ctrlKey: true,
                callback: !connector.features.executeQueryAction
                    ? () => commandNotImplemented(connector, 'REFRESH_SCHEMA')
                    : () => commandDispatch(ScriptCommandType.RefreshSchema),
            },
            {
                key: 'L',
                ctrlKey: true,
                callback: () => commandDispatch(ScriptCommandType.SaveQueryAsLink),
            },
            {
                key: 'S',
                ctrlKey: true,
                callback: () => commandDispatch(ScriptCommandType.SaveQueryAsSql),
            },
            {
                key: 'A',
                ctrlKey: true,
                callback: !connector.features.executeQueryAction
                    ? () => commandNotImplemented(connector, 'SAVE_QUERY_RESULTS_AS_ARROW')
                    : () => commandDispatch(ScriptCommandType.SaveQueryResultsAsArrow),
            },
        ];
    }, [connector, commandDispatch]);

    // Setup key event handlers
    useKeyEvents(keyHandlers);

    return <COMMAND_DISPATCH_CTX.Provider value={commandDispatch}>{props.children}</COMMAND_DISPATCH_CTX.Provider>;
};
