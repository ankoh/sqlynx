import * as React from 'react';

import { SalesforceApiClient, SalesforceApiClientInterface } from './salesforce_api_client.js';
import { SalesforceAPIClientMock } from './salesforce_api_client_mock.js';
import { mockSalesforceAuthFlow as mockSalesforceSetup } from './salesforce_connection_setup_mock.js';
import { SalesforceSetupApi, createSalesforceSetup } from './salesforce_connection_setup.js';
import { useAppConfig } from '../../app_config.js';
import { useHttpClient } from '../../platform/http_client_provider.js';
import { useLogger } from '../../platform/logger_provider.js';
import { useHyperDatabaseClient } from '../../connection/hyper/hyperdb_client_provider.js';
import { usePlatformType } from '../../platform/platform_type.js';
import { usePlatformEventListener } from '../../platform/event_listener_provider.js';

const API_CTX = React.createContext<SalesforceApiClientInterface | null>(null);
const SETUP_CTX = React.createContext<SalesforceSetupApi | null>(null);


interface Props {
    children: React.ReactElement;
}

export const SalesforceConnector: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const config = useAppConfig();
    const connectorConfig = config?.value?.connectors?.salesforce;
    const httpClient = useHttpClient();
    const hyperClient = useHyperDatabaseClient();
    const platformType = usePlatformType();
    const appEvents = usePlatformEventListener();

    const [api, setup] = React.useMemo(() => {
        if (!connectorConfig) {
            return [null, null];
        } else if (connectorConfig.mock?.enabled) {
            const api = new SalesforceAPIClientMock(connectorConfig.mock);
            const setup = mockSalesforceSetup(api, connectorConfig, logger);
            return [api, setup];
        } else {
            const api = new SalesforceApiClient(logger, httpClient);
            const setup = createSalesforceSetup(hyperClient!, api, platformType, appEvents, connectorConfig, logger);
            return [api, setup];
        }
    }, [connectorConfig]);

    return (
        <API_CTX.Provider value={api}>
            <SETUP_CTX.Provider value={setup}>
                {props.children}
            </SETUP_CTX.Provider>
        </API_CTX.Provider>
    );
};

export const useSalesforceAPI = (): SalesforceApiClientInterface => React.useContext(API_CTX)!;
export const useSalesforceSetup = () => React.useContext(SETUP_CTX!);
