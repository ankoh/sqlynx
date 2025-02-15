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
import { generatePKCEChallenge } from '../../utils/pkce.js';
import { sleep } from '../../utils/sleep.js';
import { Dispatch } from '../../utils/variant.js';
import { Logger } from '../../platform/logger.js';
import { SalesforceApiClientInterface, SalesforceDatabaseChannel } from './salesforce_api_client.js';
import { SalesforceSetupApi } from './salesforce_connection_setup.js';
import { SalesforceConnectionParams } from './salesforce_connection_params.js';
import { SalesforceConnectorConfig } from '../connector_configs.js';
import { RESET } from '../connection_state.js';
import { HyperDatabaseChannelMock } from '../hyper/hyperdb_client_mock.js';
import { CHANNEL_READY, CHANNEL_SETUP_STARTED, HEALTH_CHECK_STARTED, HEALTH_CHECK_SUCCEEDED } from '../hyper/hyper_connection_state.js';
import { HyperGrpcConnectionParams } from '../hyper/hyper_connection_params.js';


export async function setupSalesforceConnection(updateState: Dispatch<SalesforceConnectionStateAction>, logger: Logger, params: SalesforceConnectionParams, config: SalesforceConnectorConfig, apiClient: SalesforceApiClientInterface, abortSignal: AbortSignal): Promise<SalesforceDatabaseChannel> {
    try {
        // Start the authorization process
        updateState({
            type: AUTH_STARTED,
            value: params,
        });
        abortSignal.throwIfAborted()

        // Generate new PKCE challenge
        updateState({
            type: GENERATING_PKCE_CHALLENGE,
            value: null,
        });
        const pkceChallenge = await generatePKCEChallenge();
        abortSignal.throwIfAborted();
        updateState({
            type: GENERATED_PKCE_CHALLENGE,
            value: pkceChallenge,
        });

        // Wait 200ms before returning the OAuth code
        await sleep(200);
        abortSignal.throwIfAborted();
        const code = 'core-access-auth-code';
        updateState({
            type: RECEIVED_CORE_AUTH_CODE,
            value: code,
        });

        // Request the core access token
        updateState({
            type: REQUESTING_CORE_AUTH_TOKEN,
            value: null,
        });

        if (!config.auth?.oauthRedirect) {
            throw new Error(`missing oauth redirect url`);
        }
        const coreAccessToken = await apiClient.getCoreAccessToken(
            config.auth,
            params,
            code,
            pkceChallenge.verifier,
            abortSignal,
        );
        console.log(coreAccessToken);
        updateState({
            type: RECEIVED_CORE_AUTH_TOKEN,
            value: coreAccessToken,
        });
        abortSignal.throwIfAborted();

        // Request the data cloud access token
        updateState({
            type: REQUESTING_DATA_CLOUD_ACCESS_TOKEN,
            value: null,
        });
        const token = await apiClient.getDataCloudAccessToken(coreAccessToken, abortSignal);
        console.log(token);
        updateState({
            type: RECEIVED_DATA_CLOUD_ACCESS_TOKEN,
            value: token,
        });
        abortSignal.throwIfAborted();

        // Start the channel setup
        const connParams: HyperGrpcConnectionParams = {
            channelArgs: {
                endpoint: token.instanceUrl.toString(),
                tls: {},
            },
            attachedDatabases: [],
            gRPCMetadata: []
        };
        updateState({
            type: CHANNEL_SETUP_STARTED,
            value: connParams,
        });
        abortSignal.throwIfAborted()

        const hyperChannel = new HyperDatabaseChannelMock();
        const sfChannel = new SalesforceDatabaseChannel(apiClient, coreAccessToken, token, hyperChannel);
        sleep(100);

        // Mark the channel as ready
        updateState({
            type: CHANNEL_READY,
            value: sfChannel,
        });
        abortSignal.throwIfAborted();

        // Simulate Health check
        updateState({
            type: HEALTH_CHECK_STARTED,
            value: null,
        });
        abortSignal.throwIfAborted();

        // Always succeed the health check
        sleep(100);
        updateState({
            type: HEALTH_CHECK_SUCCEEDED,
            value: null,
        });
        abortSignal.throwIfAborted();

        return sfChannel;

    } catch (error: any) {
        if (error.name === 'AbortError') {
            logger.warn("oauth flow was aborted");
            updateState({
                type: AUTH_CANCELLED,
                value: error.message,
            });
        } else if (error instanceof Error) {
            logger.error(`oauth flow failed with error: ${error.toString()}`);
            updateState({
                type: AUTH_FAILED,
                value: error.message,
            });
        }

        // Rethrow the error
        throw error;
    }
}

export function mockSalesforceAuthFlow(api: SalesforceApiClientInterface, config: SalesforceConnectorConfig, logger: Logger): (SalesforceSetupApi | null) {
    const setup = async (dispatch: Dispatch<SalesforceConnectionStateAction>, params: SalesforceConnectionParams, abort: AbortSignal) => {
        return setupSalesforceConnection(dispatch, logger, params, config, api, abort);
    };
    const reset = async (dispatch: Dispatch<SalesforceConnectionStateAction>) => {
        dispatch({
            type: RESET,
            value: null,
        })
    };
    return { setup, reset: reset };
};
