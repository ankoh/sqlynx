import React from 'react';
import { Dispatch, VariantKind } from '../utils';
import { CONNECTORS, Connector, ConnectorType } from './connector';

export const SELECT_CONNECTOR = Symbol('SELECT_CONNECTOR');

export type ConnectorSwitchAction = VariantKind<typeof SELECT_CONNECTOR, ConnectorType>;

function reduceConnectorSwitch(_state: Connector, action: ConnectorSwitchAction): Connector {
    switch (action.type) {
        case SELECT_CONNECTOR:
            return CONNECTORS[action.value as number];
    }
}

interface Props {
    children: React.ReactElement;
}

const ACTIVE_CONNECTOR_CTX = React.createContext<Connector | null>(null);
const CONNECTOR_SELECTION_CTX = React.createContext<Dispatch<ConnectorSwitchAction> | null>(null);

export const ActiveConnector: React.FC<Props> = (props: Props) => {
    const [state, dispatch] = React.useReducer<typeof reduceConnectorSwitch>(reduceConnectorSwitch, CONNECTORS[0]);
    return (
        <ACTIVE_CONNECTOR_CTX.Provider value={state}>
            <CONNECTOR_SELECTION_CTX.Provider value={dispatch}>{props.children}</CONNECTOR_SELECTION_CTX.Provider>
        </ACTIVE_CONNECTOR_CTX.Provider>
    );
};

export const useConnectorList = () => CONNECTORS;
export const useConnectorSelection = () => React.useContext(CONNECTOR_SELECTION_CTX)!;
export const useActiveConnector = () => React.useContext(ACTIVE_CONNECTOR_CTX)!;
