import { SalesforceConnectorMockConfig } from '../connectors/salesforce_api_client_mock';
import { SalesforceAuthConfig, SalesforceAuthParams } from '../connectors/salesforce_auth_state';

export interface SalesforceConnectorConfig {
    auth: SalesforceAuthConfig;
    defaultApp?: SalesforceAuthParams;
    mock?: SalesforceConnectorMockConfig;
}

export interface ConnectorConfigs {
    salesforce?: SalesforceConnectorConfig;
}

export function readConnectorConfigs(configs: any): ConnectorConfigs {
    // XXX
    return configs as ConnectorConfigs;
}
