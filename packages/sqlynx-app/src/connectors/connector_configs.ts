import { SalesforceConnectorMockConfig } from '../connectors/salesforce_api_client_mock.js';
import { SalesforceAuthConfig, SalesforceAuthParams } from '../connectors/salesforce_auth_state.js';

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
