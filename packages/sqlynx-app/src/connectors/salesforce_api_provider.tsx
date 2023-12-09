import React from 'react';
import { SalesforceAPIClient, SalesforceAPIClientInterface } from './salesforce_api_client';
import { SalesforceAPIClientMock } from './salesforce_api_client_mock';
import { useAppConfig } from '../state/app_config';
import { SalesforceAuthFlow } from './salesforce_auth_flow';
import { SalesforceUserInfoResolver } from './salesforce_userinfo_resolver';
import { SalesforceMetadataResolver } from './salesforce_metadata_resolver';

const API_CLIENT_CTX = React.createContext<SalesforceAPIClientInterface | null>(null);

interface Props {
    children: React.ReactElement;
}

export const SalesforceApiProvider: React.FC<Props> = (props: Props) => {
    const config = useAppConfig();
    let api: SalesforceAPIClientInterface;
    if (config == null || !config.isResolved()) {
        return undefined;
    } else if (config.value!.connectors?.salesforce?.mockAuth) {
        api = new SalesforceAPIClientMock();
    } else {
        api = new SalesforceAPIClient();
    }
    return (
        <API_CLIENT_CTX.Provider value={api}>
            <SalesforceAuthFlow>
                <SalesforceUserInfoResolver>
                    <SalesforceMetadataResolver>{props.children}</SalesforceMetadataResolver>
                </SalesforceUserInfoResolver>
            </SalesforceAuthFlow>
        </API_CLIENT_CTX.Provider>
    );
};

export const useSalesforceApi = (): SalesforceAPIClientInterface => React.useContext(API_CLIENT_CTX)!;
