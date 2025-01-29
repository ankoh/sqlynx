import * as React from 'react';

import { SalesforceAPIClient, SalesforceAPIClientInterface } from './salesforce_api_client.js';
import { SalesforceAPIClientMock } from './salesforce_api_client_mock.js';
import { mockSalesforceAuthFlow } from './salesforce_connection_setup_mock.js';
import { SalesforceSetupApi, createSalesforceAuthFlow } from './salesforce_connection_setup.js';
import { useAppConfig } from '../../app_config.js';
import { useHttpClient } from '../../platform/http_client_provider.js';
import { useLogger } from '../../platform/logger_provider.js';
import { useHyperDatabaseClient } from '../../connectors/hyper/hyperdb_client_provider.js';
import { usePlatformType } from '../../platform/platform_type.js';
import { useAppEventListener } from '../../platform/event_listener_provider.js';

const API_CTX = React.createContext<SalesforceAPIClientInterface | null>(null);
const SETUP_CTX = React.createContext<SalesforceSetupApi | null>(null);


interface Props {
    children: React.ReactElement;
}

export const SalesforceConnector: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const config = useAppConfig();
    const httpClient = useHttpClient();
    const hyperClient = useHyperDatabaseClient();
    const sfApi = useSalesforceAPI();
    const platformType = usePlatformType();
    const appEvents = useAppEventListener();

    const [api, setup] = React.useMemo(() => {
        if (config == null || !config.isResolved() || config.value == null) {
            return [null, null];
        } else if (config.value?.connectors?.salesforce?.mock?.enabled) {
            const api = new SalesforceAPIClientMock(config.value!.connectors?.salesforce?.mock);
            const setup = mockSalesforceAuthFlow(sfApi, config.value!, logger);
            return [api, setup];
        } else {
            const api = new SalesforceAPIClient(logger, httpClient);
            const setup = createSalesforceAuthFlow(hyperClient!, sfApi, platformType, appEvents, config.value, logger);
            return [api, setup];
        }
    }, []);

    return (
        <API_CTX.Provider value={api}>
            <SETUP_CTX.Provider value={setup}>
                {props.children}
            </SETUP_CTX.Provider>
        </API_CTX.Provider>
    );
};

export const useSalesforceAPI = (): SalesforceAPIClientInterface => React.useContext(API_CTX)!;
export const useSalesforceSetup = () => React.useContext(SETUP_CTX!);
