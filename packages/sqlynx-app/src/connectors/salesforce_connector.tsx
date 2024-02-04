import * as React from 'react';
import { SalesforceAPIClient, SalesforceAPIClientInterface } from './salesforce_api_client.js';
import { SalesforceAPIClientMock } from './salesforce_api_client_mock.js';
import { useAppConfig } from '../app_config.js';
import { SalesforceAuthFlow } from './salesforce_auth_flow.js';
import { SalesforceAuthFlowMock } from './salesforce_auth_flow_mock.js';
import { SalesforceUserInfoResolver } from './salesforce_userinfo_resolver.js';

const API_CTX = React.createContext<SalesforceAPIClientInterface | null>(null);

interface Props {
    children: React.ReactElement;
}

export const SalesforceConnector: React.FC<Props> = (props: Props) => {
    const config = useAppConfig();
    if (config == null || !config.isResolved()) {
        return undefined;
    } else if (config.value?.connectors?.salesforce?.mock?.enabled) {
        const api = new SalesforceAPIClientMock(config.value!.connectors?.salesforce?.mock);
        return (
            <API_CTX.Provider value={api}>
                <SalesforceAuthFlowMock>
                    <SalesforceUserInfoResolver>{props.children}</SalesforceUserInfoResolver>
                </SalesforceAuthFlowMock>
            </API_CTX.Provider>
        );
    } else {
        const api = new SalesforceAPIClient();
        return (
            <API_CTX.Provider value={api}>
                <SalesforceAuthFlow>
                    <SalesforceUserInfoResolver>{props.children}</SalesforceUserInfoResolver>
                </SalesforceAuthFlow>
            </API_CTX.Provider>
        );
    }
};

export const useSalesforceAPI = (): SalesforceAPIClientInterface => React.useContext(API_CTX)!;
