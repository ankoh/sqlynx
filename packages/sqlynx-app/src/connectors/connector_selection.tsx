import React from 'react';
import { Dispatch, VariantKind } from '../utils';
import { CONNECTORS, ConnectorInfo, ConnectorType } from './connector_info';
import { ConnectorActions, DEFAULT_CONNECTOR_ACTIONS } from './connector_actions';

export const SELECT_CONNECTOR = Symbol('SELECT_CONNECTOR');

export type SelectedConnectorDispatch = VariantKind<typeof SELECT_CONNECTOR, ConnectorType>;

function reduceSelectedConnector(_state: ConnectorInfo, action: SelectedConnectorDispatch): ConnectorInfo {
    switch (action.type) {
        case SELECT_CONNECTOR:
            return CONNECTORS[action.value as number];
    }
}

interface Connector {
    /// The connector info
    info: ConnectorInfo;
    /// The actions
    actions: ConnectorActions;
}

interface Props {
    children: React.ReactElement;
}

const ACTIVE_CONNECTOR_CTX = React.createContext<Connector | null>(null);
const CONNECTOR_SELECTION_CTX = React.createContext<Dispatch<SelectedConnectorDispatch> | null>(null);

export const ConnectorSelection: React.FC<Props> = (props: Props) => {
    const [connectorInfo, dispatch] = React.useReducer<typeof reduceSelectedConnector>(
        reduceSelectedConnector,
        CONNECTORS[0],
    );
    let connectorActions: ConnectorActions;
    switch (connectorInfo.connectorType) {
        case ConnectorType.HYPER_DATABASE:
        case ConnectorType.SALESFORCE_DATA_CLOUD_CONNECTOR:
        case ConnectorType.LOCAL_SCRIPT:
            connectorActions = DEFAULT_CONNECTOR_ACTIONS;
    }
    const connector = {
        info: connectorInfo,
        actions: connectorActions,
    };
    return (
        <ACTIVE_CONNECTOR_CTX.Provider value={connector}>
            <CONNECTOR_SELECTION_CTX.Provider value={dispatch}>{props.children}</CONNECTOR_SELECTION_CTX.Provider>
        </ACTIVE_CONNECTOR_CTX.Provider>
    );
};

export const useConnectorList = () => CONNECTORS;
export const useConnectorSelection = () => React.useContext(CONNECTOR_SELECTION_CTX)!;
export const useSelectedConnector = () => React.useContext(ACTIVE_CONNECTOR_CTX)!;
