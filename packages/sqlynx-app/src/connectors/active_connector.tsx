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

const CONNECTOR_INFO_CTX = React.createContext<Connector | null>(null);
const CONNECTOR_SWITCH_CTX = React.createContext<Dispatch<ConnectorSwitchAction> | null>(null);

export const ActiveConnector: React.FC<Props> = (props: Props) => {
    const [state, dispatch] = React.useReducer<typeof reduceConnectorSwitch>(reduceConnectorSwitch, CONNECTORS[0]);
    return (
        <CONNECTOR_INFO_CTX.Provider value={state}>
            <CONNECTOR_SWITCH_CTX.Provider value={dispatch}>{props.children}</CONNECTOR_SWITCH_CTX.Provider>
        </CONNECTOR_INFO_CTX.Provider>
    );
};

export const useConnectorList = () => CONNECTORS;
export const useActiveConnector = () => React.useContext(CONNECTOR_INFO_CTX)!;
export const useActiveConnectorSelection = () => React.useContext(CONNECTOR_SWITCH_CTX)!;
