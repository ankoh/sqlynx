import { SalesforceConnectorMockConfig } from '../connectors/salesforce_api_client_mock.js';

export interface SalesforceAuthConfig {
    /// The oauth redirect
    oauthRedirect: string;
}

export interface SalesforceAuthParams {
    /// The base URL
    instanceUrl: string;
    /// The client id
    appConsumerKey: string;
    /// The client secret
    appConsumerSecret: string | null;
}

export interface SalesforceConnectorConfig {
    auth: SalesforceAuthConfig;
    defaultApp?: SalesforceAuthParams;
    mock?: SalesforceConnectorMockConfig;
}

export interface ConnectorConfigs {
    salesforce?: SalesforceConnectorConfig;
}

export function readConnectorConfigs(configs: any): ConnectorConfigs {
    const out: ConnectorConfigs = {};
    if (configs.salesforce) {
        out.salesforce = configs.salesforce;
    }
    return out;
}
