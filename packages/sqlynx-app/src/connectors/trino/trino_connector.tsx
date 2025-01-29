import * as React from 'react';

import { TrinoApiClient, TrinoClientInterface } from "./trino_api_client.js";
import { useLogger } from '../../platform/logger_provider.js';
import { useAppConfig } from '../../app_config.js';
import { useHttpClient } from '../../platform/http_client_provider.js';
import { createTrinoSetupFlow, TrinoSetupApi } from './trino_connection_setup.js';

const API_CTX = React.createContext<TrinoClientInterface | null>(null);
const SETUP_CTX = React.createContext<TrinoSetupApi | null>(null);

interface Props {
    children: React.ReactElement;
}

export const TrinoConnector: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const config = useAppConfig();
    const httpClient = useHttpClient();

    const [api, setup] = React.useMemo(() => {
        if (config == null || !config.isResolved() || config.value == null) {
            return [null, null];
        } else {
            const api = new TrinoApiClient(logger, httpClient);
            const setup = createTrinoSetupFlow(api!, config.value, logger);
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
}

export const useTrinoAPI = (): TrinoClientInterface => React.useContext(API_CTX)!;
