export const LOCAL_SCRIPT = Symbol('LOCAL_SCRIPT');
export const SALESFORCE_DATA_CLOUD = Symbol('SCALESFORCE_DATA_CLOUD');
export const HYPER_DATABASE = Symbol('HYPER_DATABASE');

export enum ConnectorType {
    LOCAL_SCRIPT = 0,
    SALESFORCE_DATA_CLOUD = 1,
    HYPER_DATABASE = 2,
}

export interface ConnectorInfo {
    /// The connector type
    connectorType: ConnectorType;
    /// The connector title
    displayName: {
        long: string;
        short: string;
    };
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

export const CONNECTOR_INFOS: ConnectorInfo[] = [
    {
        connectorType: ConnectorType.LOCAL_SCRIPT,
        displayName: {
            short: 'Local',
            long: 'Local Script',
        },
        features: {
            schemaScript: true,
            executeQueryAction: false,
            refreshSchemaAction: false,
        },
    },
    {
        connectorType: ConnectorType.SALESFORCE_DATA_CLOUD,
        displayName: {
            short: 'Salesforce',
            long: 'Salesforce Data Cloud',
        },
        features: {
            schemaScript: false,
            executeQueryAction: true,
            refreshSchemaAction: true,
        },
    },
    {
        connectorType: ConnectorType.HYPER_DATABASE,
        displayName: {
            short: 'Hyper',
            long: 'Hyper Database',
        },
        features: {
            schemaScript: false,
            executeQueryAction: true,
            refreshSchemaAction: true,
        },
    },
];

export enum ConnectorAuthCheck {
    UNKNOWN,
    AUTHENTICATED,
    AUTHENTICATION_FAILED,
    AUTHENTICATION_IN_PROGRESS,
    AUTHENTICATION_NOT_STARTED,
    CLIENT_ID_MISMATCH,
}

export const useConnectorList = () => CONNECTOR_INFOS;
