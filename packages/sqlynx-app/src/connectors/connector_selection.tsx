import React from 'react';
import { Dispatch, VariantKind } from '../utils';
import { CONNECTORS, Connector, ConnectorType } from './connector';

export const SELECT_CONNECTOR = Symbol('SELECT_CONNECTOR');

export type SelectedConnectorDispatch = VariantKind<typeof SELECT_CONNECTOR, ConnectorType>;

function reduceSelectedConnector(_state: Connector, action: SelectedConnectorDispatch): Connector {
    switch (action.type) {
        case SELECT_CONNECTOR:
            return CONNECTORS[action.value as number];
    }
}

interface Props {
    children: React.ReactElement;
}

const ACTIVE_CONNECTOR_CTX = React.createContext<Connector | null>(null);
const CONNECTOR_SELECTION_CTX = React.createContext<Dispatch<SelectedConnectorDispatch> | null>(null);

export const ConnectorSelection: React.FC<Props> = (props: Props) => {
    const [connector, dispatch] = React.useReducer<typeof reduceSelectedConnector>(
        reduceSelectedConnector,
        CONNECTORS[0],
    );
    return (
        <ACTIVE_CONNECTOR_CTX.Provider value={connector}>
            <CONNECTOR_SELECTION_CTX.Provider value={dispatch}>{props.children}</CONNECTOR_SELECTION_CTX.Provider>
        </ACTIVE_CONNECTOR_CTX.Provider>
    );
};

export const useConnectorList = () => CONNECTORS;
export const useConnectorSelection = () => React.useContext(CONNECTOR_SELECTION_CTX)!;
export const useSelectedConnector = () => React.useContext(ACTIVE_CONNECTOR_CTX)!;
