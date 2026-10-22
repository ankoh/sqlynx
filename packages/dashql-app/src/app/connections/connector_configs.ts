import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import { SalesforceConnectorMockConfig } from './salesforce/salesforce_api_client_mock.js';

export interface HyperConnectorConfig {
    /// The default parameters
    defaultParams?: connection.HyperConnectionParams;
}

export interface SalesforceConnectorConfig {
    /// The connector auth config
    auth?: connection.SalesforceOAuthConfig;
    /// The default parameters
    defaultParams?: connection.SalesforceConnectionParams;
    /// The mock config
    mock?: SalesforceConnectorMockConfig;
}

export interface TrinoConnectorConfig {
}

export interface ConnectorConfigs {
    /// The config for the Salesforce Data Cloud connector
    salesforce?: SalesforceConnectorConfig;
    /// The config for the Hyper connector
    hyper?: HyperConnectorConfig;
    /// The config for the Trino connector
    trino?: TrinoConnectorConfig;
}

export function readConnectorConfigs(configs: any): ConnectorConfigs {
    const out: ConnectorConfigs = {};
    if (configs.salesforce) {
        out.salesforce = configs.salesforce;
    } else {
        out.salesforce = {};
    }
    if (configs.hyper) {
        out.hyper = configs.hyper;
    } else {
        out.hyper = {};
    }
    if (configs.trino) {
        out.trino = configs.trino;
    } else {
        out.trino = {};
    }
    return out;
}
