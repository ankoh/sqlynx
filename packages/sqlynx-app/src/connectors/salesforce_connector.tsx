import React from 'react';
import { SalesforceAPIClient, SalesforceConnectorInterface } from './salesforce_api_client';
import { SalesforceAPIClientMock } from './salesforce_api_client_mock';
import { useAppConfig } from '../state/app_config';
import { SalesforceAuthFlow } from './salesforce_auth_flow';
import { SalesforceAuthFlowMock } from './salesforce_auth_flow_mock';
import { SalesforceUserInfoResolver } from './salesforce_userinfo_resolver';
import { SalesforceMetadataResolver } from './salesforce_metadata_resolver';

const CONNECTOR_CTX = React.createContext<SalesforceConnectorInterface | null>(null);

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
            <CONNECTOR_CTX.Provider value={api}>
                <SalesforceAuthFlowMock>
                    <SalesforceUserInfoResolver>
                        <SalesforceMetadataResolver>{props.children}</SalesforceMetadataResolver>
                    </SalesforceUserInfoResolver>
                </SalesforceAuthFlowMock>
            </CONNECTOR_CTX.Provider>
        );
    } else {
        const api = new SalesforceAPIClient();
        return (
            <CONNECTOR_CTX.Provider value={api}>
                <SalesforceAuthFlow>
                    <SalesforceUserInfoResolver>
                        <SalesforceMetadataResolver>{props.children}</SalesforceMetadataResolver>
                    </SalesforceUserInfoResolver>
                </SalesforceAuthFlow>
            </CONNECTOR_CTX.Provider>
        );
    }
};

export const useSalesforceConnector = (): SalesforceConnectorInterface => React.useContext(CONNECTOR_CTX)!;
