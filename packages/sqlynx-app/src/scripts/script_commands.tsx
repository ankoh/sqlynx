import React from 'react';
import { KeyEventHandler, useKeyEvents } from '../utils/key_events';
import { useSelectedConnector } from '../connectors/connector_selection';
import { VariantKind } from '../utils';
import { Connector } from 'connectors/connector';
import { useScriptStateDispatch } from './script_state_provider';

export const EXECUTE_QUERY = Symbol('EXECUTE_QUERY');
export const REFRESH_SCHEMA = Symbol('REFRESH_SCHEMA');
export const SAVE_QUERY_AS_LINK = Symbol('SAVE_QUERY_AS_LINK');
export const SAVE_QUERY_AS_SQL = Symbol('SAVE_QUERY_AS_SQL');
export const SAVE_QUERY_RESULTS_AS_ARROW = Symbol('SAVE_QUERY_RESULTS_AS_ARROW');

export type ScriptCommandVariant =
    | VariantKind<typeof EXECUTE_QUERY, null>
    | VariantKind<typeof REFRESH_SCHEMA, null>
    | VariantKind<typeof SAVE_QUERY_AS_LINK, null>
    | VariantKind<typeof SAVE_QUERY_AS_SQL, null>
    | VariantKind<typeof SAVE_QUERY_RESULTS_AS_ARROW, null>;

export type ScriptCommandDispatch = (command: ScriptCommandVariant) => void;

interface Props {
    children?: React.ReactElement | React.ReactElement[];
}

const COMMAND_DISPATCH_CTX = React.createContext<ScriptCommandDispatch | null>(null);

function commandNotImplemented(connector: Connector, actionName: string) {
    console.warn(`connector ${connector.displayName} does not implement the command '${actionName}'`);
}

export const ScriptCommands: React.FC<Props> = (props: Props) => {
    const connector = useSelectedConnector();
    // const stateDispatch = useScriptStateDispatch();

    // Setup command dispatch logic
    const commandDispatch = React.useCallback(
        async (command: ScriptCommandVariant) => {
            switch (command.type) {
                case EXECUTE_QUERY:
                    break;
                case REFRESH_SCHEMA:
                    break;
                case SAVE_QUERY_AS_LINK:
                    break;
                case SAVE_QUERY_RESULTS_AS_ARROW:
                    break;
            }
        },
        [connector],
    );
    // Create key event handlers
    const keyHandlers = React.useMemo<KeyEventHandler[]>(() => {
        return [
            {
                key: 'E',
                ctrlKey: true,
                callback: !connector.features.executeQueryAction
                    ? () => commandNotImplemented(connector, 'EXECUTE_QUERY')
                    : () =>
                          commandDispatch({
                              type: EXECUTE_QUERY,
                              value: null,
                          }),
            },
            {
                key: 'R',
                ctrlKey: true,
                callback: !connector.features.executeQueryAction
                    ? () => commandNotImplemented(connector, 'REFRESH_SCHEMA')
                    : () =>
                          commandDispatch({
                              type: REFRESH_SCHEMA,
                              value: null,
                          }),
            },
            {
                key: 'L',
                ctrlKey: true,
                callback: () =>
                    commandDispatch({
                        type: SAVE_QUERY_AS_LINK,
                        value: null,
                    }),
            },
            {
                key: 'S',
                ctrlKey: true,
                callback: () =>
                    commandDispatch({
                        type: SAVE_QUERY_AS_SQL,
                        value: null,
                    }),
            },
            {
                key: 'A',
                ctrlKey: true,
                callback: !connector.features.executeQueryAction
                    ? () => commandNotImplemented(connector, 'SAVE_QUERY_RESULTS_AS_ARROW')
                    : () =>
                          commandDispatch({
                              type: SAVE_QUERY_RESULTS_AS_ARROW,
                              value: null,
                          }),
            },
        ];
    }, [connector, commandDispatch]);

    // Setup key event handlers
    useKeyEvents(keyHandlers);

    return <COMMAND_DISPATCH_CTX.Provider value={commandDispatch}>{props.children}</COMMAND_DISPATCH_CTX.Provider>;
};
