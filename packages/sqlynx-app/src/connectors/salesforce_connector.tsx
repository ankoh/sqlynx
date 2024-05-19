import * as React from 'react';
import { useAppConfig } from '../app_config.js';
import { useAllocatedConnectionState } from './connection_registry.js';
import { useHttpClient } from '../platform/http_client_provider.js';
import { useLogger } from '../platform/logger_provider.js';
import { SalesforceAPIClient, SalesforceAPIClientInterface } from './salesforce_api_client.js';
import { SalesforceAPIClientMock } from './salesforce_api_client_mock.js';
import { SalesforceAuthFlowProvider } from './salesforce_auth_flow.js';
import { SalesforceAuthFlowMockProvider } from './salesforce_auth_flow_mock.js';
import { createEmptyTimings } from './connection_state.js';
import { AUTH_FLOW_DEFAULT_STATE } from './salesforce_auth_state.js';
import { SALESFORCE_DATA_CLOUD } from './connector_info.js';

const API_CTX = React.createContext<SalesforceAPIClientInterface | null>(null);
const CONNECTION_ID_CTX = React.createContext<number | null>(null);

interface Props {
    children: React.ReactElement;
}

export const SalesforceConnector: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const config = useAppConfig();
    const httpClient = useHttpClient();

    // Pre-allocate a connection id for all Salesforce connections.
    // This might change in the future when we start maintaining multiple connections per connector.
    // In that case, someone else would create the connection id, and we would need an "active" connection id provider
    // similar to how we maintain the active session.
    const connectionId = useAllocatedConnectionState((_) => ({
        type: SALESFORCE_DATA_CLOUD,
        value: {
            timings: createEmptyTimings(),
            auth: AUTH_FLOW_DEFAULT_STATE,
        }
    }));

    if (config == null || !config.isResolved()) {
        return undefined;
    } else if (config.value?.connectors?.salesforce?.mock?.enabled) {
        const api = new SalesforceAPIClientMock(config.value!.connectors?.salesforce?.mock);
        return (
            <API_CTX.Provider value={api}>
                <CONNECTION_ID_CTX.Provider value={connectionId}>
                    <SalesforceAuthFlowMockProvider>
                        {props.children}
                    </SalesforceAuthFlowMockProvider>
                </CONNECTION_ID_CTX.Provider>
            </API_CTX.Provider>
        );
    } else {
        const api = new SalesforceAPIClient(logger, httpClient);
        return (
            <API_CTX.Provider value={api}>
                <CONNECTION_ID_CTX.Provider value={connectionId}>
                    <SalesforceAuthFlowProvider>
                        {props.children}
                    </SalesforceAuthFlowProvider>
                </CONNECTION_ID_CTX.Provider>
            </API_CTX.Provider>
        );
    }
};

export const useSalesforceAPI = (): SalesforceAPIClientInterface => React.useContext(API_CTX)!;
export const useSalesforceConnectionId = (): number => React.useContext(CONNECTION_ID_CTX)!;
