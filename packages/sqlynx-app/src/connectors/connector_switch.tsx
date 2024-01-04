import React from 'react';
import { Dispatch, VariantKind } from '../utils';

export enum ConnectorType {
    NO_CONNECTOR = 0,
    SALESFORCE_DATA_CLOUD_CONNECTOR = 1,
}

export const SWITCH_CONNECTOR = Symbol('SWITCH_CONNECTOR');

export type ConnectorSwitchAction = VariantKind<typeof SWITCH_CONNECTOR, ConnectorType>;

export interface ConnectorInfo {
    /// The connector type
    connectorType: ConnectorType;
    /// The connector features
    features: ConnectorFeatures;
}

export interface ConnectorFeatures {
    /// User-editable schema script?
    schemaScript: boolean;
    /// The connector allows to execute queries?
    executeQueryAction: boolean;
    /// The connector allows to refresh a schema?
    refreshSchemaAction: boolean;
}

const FEATURES_NO_CONNECTOR: ConnectorFeatures = {
    schemaScript: true,
    executeQueryAction: false,
    refreshSchemaAction: false,
};
const FEATURES_SALESFORCE_DATA_CLOUD: ConnectorFeatures = {
    schemaScript: false,
    executeQueryAction: true,
    refreshSchemaAction: true,
};

function getConnectorFeatures(type: ConnectorType): ConnectorFeatures {
    switch (type) {
        case ConnectorType.NO_CONNECTOR:
            return FEATURES_NO_CONNECTOR;
        case ConnectorType.SALESFORCE_DATA_CLOUD_CONNECTOR:
            return FEATURES_SALESFORCE_DATA_CLOUD;
    }
}

function reduceConnectorInfo(state: ConnectorInfo, action: ConnectorSwitchAction): ConnectorInfo {
    switch (action.type) {
        case SWITCH_CONNECTOR:
            return {
                connectorType: action.value,
                features: getConnectorFeatures(action.value),
            };
    }
}

interface Props {
    children: React.ReactElement;
}

const CONNECTOR_INFO_CTX = React.createContext<ConnectorInfo | null>(null);
const CONNECTOR_SWITCH_CTX = React.createContext<Dispatch<ConnectorSwitchAction> | null>(null);

export const ConnectorSwitch: React.FC<Props> = (props: Props) => {
    const [state, dispatch] = React.useReducer<typeof reduceConnectorInfo, null>(reduceConnectorInfo, null, () => ({
        connectorType: ConnectorType.NO_CONNECTOR,
        features: getConnectorFeatures(ConnectorType.NO_CONNECTOR),
    }));
    return (
        <CONNECTOR_INFO_CTX.Provider value={state}>
            <CONNECTOR_SWITCH_CTX.Provider value={dispatch}>{props.children}</CONNECTOR_SWITCH_CTX.Provider>
        </CONNECTOR_INFO_CTX.Provider>
    );
};

export const useActiveConnector = () => React.useContext(CONNECTOR_INFO_CTX)!;
export const useConnectorSwitch = () => React.useContext(CONNECTOR_SWITCH_CTX)!;
