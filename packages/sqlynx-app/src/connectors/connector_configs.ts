import { HyperGrpcConnectionParams } from './hyper/hyper_connection_params.js';
import { SalesforceAuthParams } from './salesforce/salesforce_connection_params.js';
import { SalesforceConnectorMockConfig } from './salesforce/salesforce_api_client_mock.js';

export interface HyperGrpcConnectorConfig {
    /// The default parameters
    defaultParams?: HyperGrpcConnectionParams;
}

export interface SalesforceAuthConfig {
    /// The oauth redirect
    oauthRedirect: string;
}

export interface SalesforceConnectorConfig {
    /// The connector auth config
    auth: SalesforceAuthConfig;
    /// The default parameters
    defaultParams?: SalesforceAuthParams;
    /// The mock config
    mock?: SalesforceConnectorMockConfig;
}

export interface ConnectorConfigs {
    /// The config for the Salesforce Data Cloud connector
    salesforce?: SalesforceConnectorConfig;
    /// The config for the Hyper gRPC connector
    hyperGrpc?: HyperGrpcConnectorConfig;
}

export function readConnectorConfigs(configs: any): ConnectorConfigs {
    const out: ConnectorConfigs = {};
    if (configs.salesforce) {
        out.salesforce = configs.salesforce;
    }
    return out;
}
