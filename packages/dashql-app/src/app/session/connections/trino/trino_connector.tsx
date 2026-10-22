import * as React from 'react';

import { TrinoApiClient, TrinoApiClientInterface } from "./trino_api_client.js";
import { useLogger } from '../../../../platform/logger/logger_provider.js';
import { useAppConfig } from '../../../config/app_config.js';
import { useHttpClient } from '../../../../platform/http/http_client_provider.js';
import { createTrinoSetup, TrinoSetupApi } from './trino_connection_setup.js';
import { usePlatformType } from '../../../../platform/platform_type.js';

const API_CTX = React.createContext<TrinoApiClientInterface | null>(null);
const SETUP_CTX = React.createContext<TrinoSetupApi | null>(null);

interface Props {
    children: React.ReactElement;
}

export const TrinoConnector: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const config = useAppConfig();
    const httpClient = useHttpClient();
    const platformType = usePlatformType();
    const connectorConfig = config?.connectors?.trino;
    const forceReLogin = config?.settings?.forceReLogin ?? false;

    const [api, setup] = React.useMemo(() => {
        if (!connectorConfig) {
            return [null, null];
        } else {
            const api: TrinoApiClientInterface = new TrinoApiClient(logger, httpClient);
            const setup = createTrinoSetup(api!, connectorConfig, logger, httpClient, platformType, forceReLogin);
            return [api, setup];
        }
    }, [connectorConfig, httpClient, platformType, forceReLogin]);

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
