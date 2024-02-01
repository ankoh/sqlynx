import { SalesforceConnectorMockConfig } from '../connectors/salesforce_api_client_mock';
import { SalesforceAuthConfig, SalesforceAuthParams } from '../connectors/salesforce_auth_state';
import { HyperApiVersion, instantiateHyperApiReleaseInfo } from './hyperapi_release';

export interface SalesforceConnectorConfig {
    auth: SalesforceAuthConfig;
    defaultApp?: SalesforceAuthParams;
    mock?: SalesforceConnectorMockConfig;
}

export interface HyperApiConfig {
    version: HyperApiVersion;
    downloadBaseUrl: string;
}

export interface HyperConnectorConfig {
    hyperApi: HyperApiConfig;
}

export interface ConnectorConfigs {
    salesforce?: SalesforceConnectorConfig;
    hyper?: HyperConnectorConfig;
}

export function readConnectorConfigs(configs: any): ConnectorConfigs {
    const hyperApi = configs.hyper.hyperApi;
    if (hyperApi) {
        instantiateHyperApiReleaseInfo(hyperApi);
    }
    return configs as ConnectorConfigs;
}
