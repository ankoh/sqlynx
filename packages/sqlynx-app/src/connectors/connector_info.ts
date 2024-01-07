export enum ConnectorType {
    LOCAL_SCRIPT = 0,
    SALESFORCE_DATA_CLOUD_CONNECTOR = 1,
    HYPER_DATABASE = 2,
}

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

export const CONNECTORS: ConnectorInfo[] = [
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
