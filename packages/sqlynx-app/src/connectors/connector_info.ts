import * as proto from '@ankoh/sqlynx-pb';
import { isNativePlatform } from "../platform/native_globals.js";

export const SERVERLESS_CONNECTOR = Symbol('SERVERLESS_CONNECTOR');
export const SALESFORCE_DATA_CLOUD_CONNECTOR = Symbol('SALESFORCE_DATA_CLOUD_CONNECTOR');
export const HYPER_GRPC_CONNECTOR = Symbol('HYPER_GRPC_CONNECTOR');

export enum ConnectorType {
    SERVERLESS = 0,
    SALESFORCE_DATA_CLOUD = 1,
    HYPER_GRPC = 2,
}

export interface ConnectorInfo {
    /// The connector type
    connectorType: ConnectorType;
    /// The connector title
    displayName: {
        long: string;
        short: string;
    };
    /// The icons
    icons: {
        colored: string,
        uncolored: string,
        outlines: string,
    }
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
        connectorType: ConnectorType.SERVERLESS,
        displayName: {
            short: 'Serverless',
            long: 'Serverless',
        },
        icons: {
            colored: "cloud_offline",
            uncolored: "cloud_offline",
            outlines: "cloud_offline",
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
        icons: {
            colored: "hyper",
            uncolored: "hyper_nocolor",
            outlines: "hyper_outlines",
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
        connectorType: ConnectorType.HYPER_GRPC,
        displayName: {
            short: 'Hyper',
            long: 'Hyper Database',
        },
        icons: {
            colored: "salesforce_notext",
            uncolored: "salesforce_notext",
            outlines: "salesforce_outlines",
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
        case "hyper": return CONNECTOR_INFOS[ConnectorType.HYPER_GRPC];
        case "salesforce": return CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD];
        case "serverless": return CONNECTOR_INFOS[ConnectorType.SERVERLESS];
        default: return null;
    }
}

export function requiresSwitchingToNative(info: ConnectorInfo) {
    return !info.platforms.browser && !isNativePlatform();
}

export const useConnectorList = () => CONNECTOR_INFOS;
