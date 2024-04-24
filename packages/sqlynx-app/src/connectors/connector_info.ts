import * as proto from '@ankoh/sqlynx-pb';
import { isNativePlatform } from "../platform/native_globals.js";

export const BRAINSTORM_MODE = Symbol('BRAINSTORM_MODE');
export const SALESFORCE_DATA_CLOUD = Symbol('SALESFORCE_DATA_CLOUD');
export const HYPER_DATABASE = Symbol('HYPER_DATABASE');

export enum ConnectorType {
    BRAINSTORM_MODE = 0,
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
    /// User-editable schema script?
    schemaScript: boolean;
    /// Can execute queries?
    executeQueryAction: boolean;
    /// Can refresh a schema?
    refreshSchemaAction: boolean;
}

export const CONNECTOR_INFOS: ConnectorInfo[] = [
    {
        connectorType: ConnectorType.BRAINSTORM_MODE,
        displayName: {
            short: 'Brainstorm',
            long: 'Brainstorm Mode',
        },
        features: {
            schemaScript: true,
            executeQueryAction: false,
            refreshSchemaAction: false,
        },
        platforms: {
            browser: true,
            native: true,
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
        platforms: {
            browser: false,
            native: true,
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
        platforms: {
            browser: false,
            native: true,
        },
    },
];

export function getConnectorInfoForParams(params: proto.sqlynx_session.pb.ConnectorParams): ConnectorInfo | null {
    switch (params.connector.case) {
        case "hyper": return CONNECTOR_INFOS[ConnectorType.HYPER_DATABASE];
        case "salesforce": return CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD];
        case "brainstorm": return CONNECTOR_INFOS[ConnectorType.BRAINSTORM_MODE];
        default: return null;
    }
}

export function requiresSwitchingToNative(info: ConnectorInfo) {
    return !info.platforms.browser && !isNativePlatform();
}

export const useConnectorList = () => CONNECTOR_INFOS;
