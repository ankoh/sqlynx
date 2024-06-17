import * as React from 'react';

import {
    AUTH_CANCELLED,
    AUTH_FAILED,
    AUTH_STARTED,
    GENERATED_PKCE_CHALLENGE,
    GENERATING_PKCE_CHALLENGE,
    RECEIVED_CORE_AUTH_CODE,
    RECEIVED_CORE_AUTH_TOKEN,
    RECEIVED_DATA_CLOUD_ACCESS_TOKEN,
    REQUESTING_CORE_AUTH_TOKEN,
    REQUESTING_DATA_CLOUD_ACCESS_TOKEN,
    SalesforceConnectionStateAction,
} from './salesforce_connection_state.js';
import { useSalesforceAPI } from './salesforce_connector.js';
import { useAppConfig } from '../app_config.js';
import { useLogger } from '../platform/logger_provider.js';
import { generatePKCEChallenge } from '../utils/pkce.js';
import { sleep } from '../utils/sleep.js';
import { Dispatch } from '../utils/variant.js';
import { Logger } from '../platform/logger.js';
import { SalesforceAPIClientInterface } from './salesforce_api_client.js';
import { SalesforceSetupApi, SETUP_CTX } from './salesforce_setup.js';
import { SalesforceAuthParams } from './connection_params.js';
import { SalesforceConnectorConfig } from './connector_configs.js';
import { RESET } from './connection_state.js';

interface Props {
    children: React.ReactElement;
}

export async function authorizeSalesforceConnection(dispatch: Dispatch<SalesforceConnectionStateAction>, logger: Logger, params: SalesforceAuthParams, config: SalesforceConnectorConfig, apiClient: SalesforceAPIClientInterface, abortSignal: AbortSignal): Promise<void> {
    try {
        // Start the authorization process
        dispatch({
            type: AUTH_STARTED,
            value: params,
        });
        abortSignal.throwIfAborted()

        // Generate new PKCE challenge
        dispatch({
            type: GENERATING_PKCE_CHALLENGE,
            value: null,
        });
        const pkceChallenge = await generatePKCEChallenge();
        abortSignal.throwIfAborted();
        dispatch({
            type: GENERATED_PKCE_CHALLENGE,
            value: pkceChallenge,
        });

        // Wait 200ms before returning the OAuth code
        await sleep(200);
        abortSignal.throwIfAborted();
        const code = 'core-access-auth-code';
        dispatch({
            type: RECEIVED_CORE_AUTH_CODE,
            value: code,
        });

        // Request the core access token
        dispatch({
            type: REQUESTING_CORE_AUTH_TOKEN,
            value: null,
        });
        const coreAccessToken = await apiClient.getCoreAccessToken(
            config.auth,
            params,
            code,
            pkceChallenge.verifier,
            abortSignal,
        );
        console.log(coreAccessToken);
        dispatch({
            type: RECEIVED_CORE_AUTH_TOKEN,
            value: coreAccessToken,
        });
        abortSignal.throwIfAborted();

        // Request the data cloud access token
        dispatch({
            type: REQUESTING_DATA_CLOUD_ACCESS_TOKEN,
            value: null,
        });
        const token = await apiClient.getDataCloudAccessToken(coreAccessToken, abortSignal);
        console.log(token);
        dispatch({
            type: RECEIVED_DATA_CLOUD_ACCESS_TOKEN,
            value: token,
        });
        abortSignal.throwIfAborted();

    } catch (error: any) {
        if (error.name === 'AbortError') {
            logger.warn("oauth flow was aborted");
            dispatch({
                type: AUTH_CANCELLED,
                value: error.message,
            });
        } else if (error instanceof Error) {
            logger.error(`oauth flow failed with error: ${error.toString()}`);
            dispatch({
                type: AUTH_FAILED,
                value: error.message,
            });
        }
    }
}

export const SalesforceAuthFlowMockProvider: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const appConfig = useAppConfig();
    const salesforceApi = useSalesforceAPI();
    const connectorConfig = appConfig.value?.connectors?.salesforce ?? null;

    const api = React.useMemo<SalesforceSetupApi | null>(() => {
        if (!connectorConfig) {
            return null;
        }
        const auth = async (dispatch: Dispatch<SalesforceConnectionStateAction>, params: SalesforceAuthParams, abort: AbortSignal) => {
            return authorizeSalesforceConnection(dispatch, logger, params, connectorConfig, salesforceApi, abort);
        };
        const reset = async (dispatch: Dispatch<SalesforceConnectionStateAction>) => {
            dispatch({
                type: RESET,
                value: null,
            })
        };
        return { authorize: auth, reset: reset };
    }, [connectorConfig]);

    return (
        <SETUP_CTX.Provider value={api}>{props.children}</SETUP_CTX.Provider>
    );
};
