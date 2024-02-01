import { SalesforceConnectorMockConfig } from '../connectors/salesforce_api_client_mock';
import { SalesforceAuthConfig, SalesforceAuthParams } from '../connectors/salesforce_auth_state';
import { HyperApiConfig, loadReleaseInfo } from './hyperapi_release';

export interface SalesforceConnectorConfig {
    auth: SalesforceAuthConfig;
    defaultApp?: SalesforceAuthParams;
    mock?: SalesforceConnectorMockConfig;
}

interface HyperConnectorConfig {
    hyperApi: HyperApiConfig;
}

export interface ConnectorConfigs {
    salesforce?: SalesforceConnectorConfig;
    hyper?: HyperConnectorConfig;
}

export function readConnectorConfigs(configs: any): ConnectorConfigs {
    const out: ConnectorConfigs = {};
    if (configs.salesforce) {
        out.salesforce = configs.salesforce;
    }
    if (configs.hyper?.hyperApi) {
        out.hyper = {
            hyperApi: loadReleaseInfo(configs.hyper.hyperApi),
        };
    }
    console.log(out);
    return out;
}
