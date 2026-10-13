import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import {
    SETUP_CANCELLED,
    SETUP_FAILED,
    SETUP_STARTED,
    GENERATED_PKCE_CHALLENGE,
    GENERATING_PKCE_CHALLENGE,
    RECEIVED_CORE_AUTH_CODE,
    RECEIVED_CORE_AUTH_TOKEN,
    REQUESTING_CORE_AUTH_TOKEN,
    SalesforceConnectionStateAction,
    SF_CHANNEL_READY,
    SF_CHANNEL_SETUP_STARTED,
} from './salesforce_connection_state.js';
import { generatePKCEChallenge } from '../../../../utils/pkce.js';
import { sleep } from '../../../../utils/sleep.js';
import { Dispatch } from '../../../../utils/variant.js';
import { Logger, stringifyError } from '../../../../platform/logger/logger.js';
import { getSalesforceDataCloudUrl, SalesforceApiClientInterface, SalesforceDatabaseChannel } from './salesforce_api_client.js';
import { SalesforceSetupApi } from './salesforce_connection_setup.js';
import { SalesforceConnectorConfig } from '../connector_configs.js';
import { HEALTH_CHECK_STARTED, HEALTH_CHECK_SUCCEEDED, RESET_ATTACHED_DATABASE } from '../attached_database_state.js';
import { HyperDatabaseChannelMock } from '../hyper/hyperdb_grpc_client_mock.js';


export async function setupSalesforceConnection(updateState: Dispatch<SalesforceConnectionStateAction>, logger: Logger, params: connection.SalesforceConnectionParams, config: SalesforceConnectorConfig, apiClient: SalesforceApiClientInterface, abortSignal: AbortSignal): Promise<SalesforceDatabaseChannel> {
    try {
        // Start the authorization process
        updateState({
            type: SETUP_STARTED,
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
            value: {
                token: code,
                createdAt: new Date().toISOString()
            },
        });

        // Request the core access token
        updateState({
            type: REQUESTING_CORE_AUTH_TOKEN,
            value: null,
        });

        if (!config.auth?.oauthRedirect) {
            throw new Error(`Missing oauth redirect url`);
        }
        const coreAccessToken = await apiClient.getCoreAccessToken(
            config.auth,
            params,
            code,
            pkceChallenge.verifier,
            abortSignal,
        );
        updateState({
            type: RECEIVED_CORE_AUTH_TOKEN,
            value: coreAccessToken,
        });
        abortSignal.throwIfAborted();

        // Start the channel setup
        const connParams: connection.HyperConnectionParams = {
            protocol: params.hyperProtocol,
            endpoint: getSalesforceDataCloudUrl(params.dataCloudInstanceUrl),
            tls: {
                clientKeyPath: "",
                clientCertPath: "",
                caCertsPath: ""
            }
        };
        updateState({
            type: SF_CHANNEL_SETUP_STARTED,
            value: connParams,
        });
        abortSignal.throwIfAborted()

        const hyperChannel = new HyperDatabaseChannelMock();
        const sfChannel = new SalesforceDatabaseChannel(apiClient, coreAccessToken, hyperChannel);
        sleep(100);

        // Mark the channel as ready
        updateState({
            type: SF_CHANNEL_READY,
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
            logger.warn("Oauth flow was aborted", {});
            updateState({
                type: SETUP_CANCELLED,
                value: error.message,
            });
        } else if (error instanceof Error) {
            logger.warn("Oauth flow failed", { "error": stringifyError(error) });
            updateState({
                type: SETUP_FAILED,
                value: {
                    message: error.message
                },
            });
        }

        // Rethrow the error
        throw error;
    }
}

export function mockSalesforceAuthFlow(api: SalesforceApiClientInterface, config: SalesforceConnectorConfig, logger: Logger): (SalesforceSetupApi | null) {
    const setup = async (dispatch: Dispatch<SalesforceConnectionStateAction>, params: connection.SalesforceConnectionParams, abort: AbortSignal) => {
        return setupSalesforceConnection(dispatch, logger, params, config, api, abort);
    };
    const reset = async (dispatch: Dispatch<SalesforceConnectionStateAction>) => {
        dispatch({
            type: RESET_ATTACHED_DATABASE,
            value: null,
        })
    };
    return { setup, reset: reset };
};
