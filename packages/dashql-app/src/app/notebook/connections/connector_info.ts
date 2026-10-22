import { isNativePlatform } from "../../../platform/native_globals.js";

export const SALESFORCE_DATA_CLOUD_CONNECTOR = Symbol('SALESFORCE_DATA_CLOUD_CONNECTOR');
export const HYPER_CONNECTOR = Symbol('HYPER_CONNECTOR');
export const TRINO_CONNECTOR = Symbol('TRINO_CONNECTOR');

export enum ConnectorType {
    HYPER = 0,
    SALESFORCE_DATA_CLOUD = 1,
    TRINO = 2,
}
export const CONNECTOR_TYPES: ConnectorType[] = [
    ConnectorType.HYPER,
    ConnectorType.SALESFORCE_DATA_CLOUD,
    ConnectorType.TRINO,
];

export enum CatalogResolver {
    SQL_SCRIPT = 0,
    SQL_INFORMATION_SCHEMA = 1,
    SQL_PG_ATTRIBUTE = 2,
    SALESFORCE_METDATA_API = 3,
    SQL_HYPER = 4,
}

export interface ConnectorInfo {
    /// The connector type
    connectorType: ConnectorType;
    /// The query shown in the first script of a new notebook.
    helloWorldScript: string;
    /// The connector name
    names: {
        displayLong: string;
        displayShort: string;
        fileShort: string;
    };
    /// The icons
    icons: {
        colored: string,
        uncolored: string,
        outlines: string,
    }
    /// The catalog resolution type
    catalogResolver: CatalogResolver;
    /// The connector features
    features: ConnectorFeatures;
    /// The connector platforms
    platforms: ConnectorPlatforms;
}

export interface ConnectorPlatforms {
    /// Supports the browser?
    browser: boolean;
    /// Supports the electron app?
    native: boolean;
}

export interface ConnectorFeatures {
    /// Can manually set up connector? (vs. static / preloaded)
    manualSetup: boolean;
    /// Has health checks?
    healthChecks: boolean;
    /// User-editable schema script?
    schemaScript: boolean;
    /// Can execute queries?
    executeQueryAction: boolean;
    /// Can refresh a schema?
    refreshSchemaAction: boolean;
    /// Do new notebooks cache query results?
    queryResultCaching: boolean;
}

export const CONNECTOR_INFOS: ConnectorInfo[] = [
    {
        connectorType: ConnectorType.HYPER,
        helloWorldScript: 'select version();',
        names: {
            displayShort: 'Hyper',
            displayLong: 'Hyper',
            fileShort: 'hyper',
        },
        icons: {
            colored: "hyper",
            uncolored: "hyper_nocolor",
            outlines: "hyper_outlines",
        },
        catalogResolver: CatalogResolver.SQL_HYPER,
        features: {
            manualSetup: true,
            healthChecks: true,
            schemaScript: false,
            executeQueryAction: true,
            refreshSchemaAction: true,
            queryResultCaching: false,
        },
        platforms: {
            browser: true,
            native: true,
        },
    },
    {
        connectorType: ConnectorType.SALESFORCE_DATA_CLOUD,
        helloWorldScript: 'select version();',
        names: {
            displayShort: 'Salesforce',
            displayLong: 'Salesforce Data Cloud',
            fileShort: 'sfdc',
        },
        icons: {
            colored: "salesforce_notext",
            uncolored: "salesforce_notext_nocolor",
            outlines: "salesforce_outlines",
        },
        catalogResolver: CatalogResolver.SALESFORCE_METDATA_API,
        features: {
            manualSetup: true,
            healthChecks: true,
            schemaScript: false,
            executeQueryAction: true,
            refreshSchemaAction: true,
            queryResultCaching: true,
        },
        platforms: {
            browser: true,
            native: true,
        },
    },
    {
        connectorType: ConnectorType.TRINO,
        helloWorldScript: 'select version();',
        names: {
            displayShort: 'Trino',
            displayLong: 'Trino',
            fileShort: 'trino',
        },
        icons: {
            colored: "trino",
            uncolored: "trino_nocolor",
            outlines: "trino_outlines",
        },
        catalogResolver: CatalogResolver.SQL_INFORMATION_SCHEMA,
        features: {
            manualSetup: true,
            healthChecks: true,
            schemaScript: false,
            executeQueryAction: true,
            refreshSchemaAction: true,
            queryResultCaching: true,
        },
        platforms: {
            browser: true,
            native: true,
        },
    },
];

export function getConnectorInfoForParams(params: { hyper?: any; salesforce?: any; trino?: any }): ConnectorInfo | null {
    if ("hyper" in params) return CONNECTOR_INFOS[ConnectorType.HYPER];
    if ("salesforce" in params) return CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD];
    if ("trino" in params) return CONNECTOR_INFOS[ConnectorType.TRINO];
    return null;
}

export function isConnectorAvailable(info: ConnectorInfo): boolean {
    return isNativePlatform() ? info.platforms.native : info.platforms.browser;
}

export function requiresSwitchingToNative(info: ConnectorInfo) {
    return !isConnectorAvailable(info);
}

export const useConnectorList = () => {
    const connectorTypes = [ConnectorType.HYPER, ConnectorType.SALESFORCE_DATA_CLOUD, ConnectorType.TRINO];
    return connectorTypes.map(type => CONNECTOR_INFOS[type]).filter(isConnectorAvailable);
};
