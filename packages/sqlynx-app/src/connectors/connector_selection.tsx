import React from 'react';
import { Dispatch, VariantKind } from '../utils';
import { CONNECTOR_INFOS, ConnectorInfo, ConnectorType } from './connector_info';

export const SELECT_CONNECTOR = Symbol('SELECT_CONNECTOR');

export type SelectedConnectorDispatch = VariantKind<typeof SELECT_CONNECTOR, ConnectorType>;

function reduceSelectedConnector(_state: ConnectorInfo, action: SelectedConnectorDispatch): ConnectorInfo {
    switch (action.type) {
        case SELECT_CONNECTOR:
            return CONNECTOR_INFOS[action.value as number];
    }
}

interface Props {
    children: React.ReactElement;
}

const ACTIVE_CONNECTOR_CTX = React.createContext<ConnectorInfo | null>(null);
const CONNECTOR_SELECTION_CTX = React.createContext<Dispatch<SelectedConnectorDispatch> | null>(null);

export const ConnectorSelection: React.FC<Props> = (props: Props) => {
    const [connector, dispatch] = React.useReducer<typeof reduceSelectedConnector>(
        reduceSelectedConnector,
        CONNECTOR_INFOS[0],
    );
    return (
        <ACTIVE_CONNECTOR_CTX.Provider value={connector}>
            <CONNECTOR_SELECTION_CTX.Provider value={dispatch}>{props.children}</CONNECTOR_SELECTION_CTX.Provider>
        </ACTIVE_CONNECTOR_CTX.Provider>
    );
};

export const useConnectorList = () => CONNECTOR_INFOS;
export const useConnectorSelection = () => React.useContext(CONNECTOR_SELECTION_CTX)!;
export const useSelectedConnector = () => React.useContext(ACTIVE_CONNECTOR_CTX)!;
