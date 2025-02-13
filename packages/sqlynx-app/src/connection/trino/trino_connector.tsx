import * as React from 'react';

import { TrinoApiClient, TrinoApiClientInterface } from "./trino_api_client.js";
import { useLogger } from '../../platform/logger_provider.js';
import { useAppConfig } from '../../app_config.js';
import { useHttpClient } from '../../platform/http_client_provider.js';
import { createTrinoSetupFlow, TrinoSetupApi } from './trino_connection_setup.js';

const API_CTX = React.createContext<TrinoApiClientInterface | null>(null);
const SETUP_CTX = React.createContext<TrinoSetupApi | null>(null);

interface Props {
    children: React.ReactElement;
}

export const TrinoConnector: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const config = useAppConfig();
    const connectorConfig = config?.value?.connectors?.trino;
    const httpClient = useHttpClient();

    const [api, setup] = React.useMemo(() => {
        if (!connectorConfig) {
            return [null, null];
        } else {
            const api: TrinoApiClientInterface = new TrinoApiClient(logger, httpClient);
            const setup = createTrinoSetupFlow(api!, connectorConfig, logger);
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
}

export const useTrinoAPI = (): TrinoApiClientInterface => React.useContext(API_CTX)!;
export const useTrinoSetup = (): TrinoSetupApi => React.useContext(SETUP_CTX)!;
