import * as React from 'react';

import { SalesforceAPIClient, SalesforceAPIClientInterface } from './salesforce_api_client.js';
import { SalesforceAPIClientMock } from './salesforce_api_client_mock.js';
import { SalesforceAuthFlowMockProvider } from './salesforce_connection_setup_mock.js';
import { SalesforceSetupProvider } from './salesforce_connection_setup.js';
import { useAppConfig } from '../../app_config.js';
import { useHttpClient } from '../../platform/http_client_provider.js';
import { useLogger } from '../../platform/logger_provider.js';

const API_CTX = React.createContext<SalesforceAPIClientInterface | null>(null);

interface Props {
    children: React.ReactElement;
}

export const SalesforceConnector: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const config = useAppConfig();
    const httpClient = useHttpClient();

    if (config == null || !config.isResolved()) {
        return undefined;
    } else if (config.value?.connectors?.salesforce?.mock?.enabled) {
        const api = new SalesforceAPIClientMock(config.value!.connectors?.salesforce?.mock);
        return (
            <API_CTX.Provider value={api}>
                <SalesforceAuthFlowMockProvider>
                    {props.children}
                </SalesforceAuthFlowMockProvider>
            </API_CTX.Provider>
        );
    } else {
        const api = new SalesforceAPIClient(logger, httpClient);
        return (
            <API_CTX.Provider value={api}>
                <SalesforceSetupProvider>
                    {props.children}
                </SalesforceSetupProvider>
            </API_CTX.Provider>
        );
    }
};

export const useSalesforceAPI = (): SalesforceAPIClientInterface => React.useContext(API_CTX)!;
