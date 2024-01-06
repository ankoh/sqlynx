import React from 'react';
import { Dispatch, VariantKind } from '../utils';

export enum ConnectorType {
    LOCAL_SCRIPT = 0,
    SALESFORCE_DATA_CLOUD_CONNECTOR = 1,
    HYPER_DATABASE = 2,
}

export const SWITCH_CONNECTOR = Symbol('SWITCH_CONNECTOR');

export type ConnectorSwitchAction = VariantKind<typeof SWITCH_CONNECTOR, ConnectorType>;

export interface ConnectorInfo {
    /// The connector type
    connectorType: ConnectorType;
    /// The connector title
    title: string;
    /// The connector features
    features: ConnectorFeatures;
}

export interface ConnectorFeatures {
    /// User-editable schema script?
    schemaScript: boolean;
    /// Can execute queries?
    executeQueryAction: boolean;
    /// Can refresh a schema?
    refreshSchemaAction: boolean;
}

const CONNECTOR_INFOS: ConnectorInfo[] = [
    {
        connectorType: ConnectorType.LOCAL_SCRIPT,
        title: 'Local Script',
        features: {
            schemaScript: true,
            executeQueryAction: false,
            refreshSchemaAction: false,
        },
    },
    {
        connectorType: ConnectorType.SALESFORCE_DATA_CLOUD_CONNECTOR,
        title: 'Salesforce Data Cloud',
        features: {
            schemaScript: false,
            executeQueryAction: true,
            refreshSchemaAction: true,
        },
    },
    {
        connectorType: ConnectorType.HYPER_DATABASE,
        title: 'Hyper Database',
        features: {
            schemaScript: false,
            executeQueryAction: true,
            refreshSchemaAction: true,
        },
    },
];

function reduceConnectorInfo(_state: ConnectorInfo, action: ConnectorSwitchAction): ConnectorInfo {
    switch (action.type) {
        case SWITCH_CONNECTOR:
            return CONNECTOR_INFOS[action.value as number];
    }
}

interface Props {
    children: React.ReactElement;
}

const CONNECTOR_INFO_CTX = React.createContext<ConnectorInfo | null>(null);
const CONNECTOR_SWITCH_CTX = React.createContext<Dispatch<ConnectorSwitchAction> | null>(null);

export const ConnectorSwitch: React.FC<Props> = (props: Props) => {
    const [state, dispatch] = React.useReducer<typeof reduceConnectorInfo>(reduceConnectorInfo, CONNECTOR_INFOS[0]);
    return (
        <CONNECTOR_INFO_CTX.Provider value={state}>
            <CONNECTOR_SWITCH_CTX.Provider value={dispatch}>{props.children}</CONNECTOR_SWITCH_CTX.Provider>
        </CONNECTOR_INFO_CTX.Provider>
    );
};

export const useActiveConnectorInfo = () => React.useContext(CONNECTOR_INFO_CTX)!;
export const useConnectorInfos = () => CONNECTOR_INFOS;
export const useConnectorSwitch = () => React.useContext(CONNECTOR_SWITCH_CTX)!;
