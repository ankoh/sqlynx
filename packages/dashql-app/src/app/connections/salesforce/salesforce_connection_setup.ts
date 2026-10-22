import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import { dateToTimestamp } from '../proto_helper.js';

import {
    SETUP_CANCELLED,
    SETUP_FAILED,
    SETUP_STARTED,
    GENERATED_PKCE_CHALLENGE,
    GENERATING_PKCE_CHALLENGE,
    OAUTH_NATIVE_LINK_OPENED,
    OAUTH_WEB_WINDOW_CLOSED,
    OAUTH_WEB_WINDOW_OPENED,
    RECEIVED_CORE_AUTH_CODE,
    RECEIVED_CORE_AUTH_TOKEN,
    RECEIVED_CORE_USER_INFO,
    RECEIVED_DATA_CLOUD_ACCESS_TOKEN,
    REQUESTING_CORE_AUTH_TOKEN,
    REQUESTING_DATA_CLOUD_ACCESS_TOKEN,
    SalesforceConnectionStateAction,
    SF_CHANNEL_READY,
    SF_CHANNEL_SETUP_STARTED,
} from './salesforce_connection_state.js';
import { PlatformType } from '../../../platform/platform_type.js';
import { SalesforceConnectorConfig } from '../connector_configs.js';
import { collectSalesforceAuthInfo, getSalesforceLakehousePath, SalesforceApiClientInterface, SalesforceDatabaseChannel } from './salesforce_api_client.js';
import { Dispatch } from '../../../utils/variant.js';
import { Logger, stringifyError } from '../../../platform/logger/logger.js';
import { PlatformEventListener } from '../../../platform/events/event_listener.js';
import { RESET_ATTACHED_DATABASE } from '../attached_database_state.js';
import { AttachedDatabase, HyperDatabaseChannel, HyperDatabaseClient, HyperDatabaseConnectionContext } from '../hyper/hyperdb_grpc_client.js';
import { authenticateSalesforce, SalesforceAuthenticationProgress } from './salesforce_authentication.js';

const LOG_CTX = "salesforce_setup";

// We use the web-server OAuth Flow with or without consumer secret.
//
// !! Don't embed an External Client App secret !!
//
// For untrusted clients, like this SPA, the web server OAuth flow can be configure to NOT require a consumer secret but
// still use PKCE. PKCE makes this more preferrable than the alternative user-agent flow for untrusted clients since it
// ensures that the application that starts the authentication flow is the same one that finishes it.
// (Salesforce discourages using the user-agent flow, see https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_user_agent_flow.htm&type=5)
//
// Make sure this is checked (should be by default):
//      Setup > App Manager > Your App > "Require Proof Key for Code Exchange (PKCE)"
// Uncheck this:
//      Setup > App Manager > Your App > "Require Secret for Web Server Flow"
// What you'll eventually need as well (not, if you only use the native apps):
//      Setup > CORS > Enable CORS for OAuth endpoints
//      Setup > CORS > Allowed Origins List > Add your Origin
//
// Docs:
//  - Web Server Flow: https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm&type=5
//  - User Agent Flow: https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_user_agent_flow.htm&type=5
//  - PKCE: https://oauth.net/2/pkce/
//
// PKCE flow:
//  1. Client creates the code_verifier. (RFC 7636, Section 4.1)
//  2. Client creates the code_challenge by transforming the code_verifier using S256 encryption. (RFC 7636, Section 4.2)
//  3. Client sends the code_challenge and code_challenge_method with the initial authorization request. (RFC 7636, Section 4.3)
//  4. Server responds with an authorization_code. (RFC 7636, Section 4.4)
//  5. Client sends authorization_code and code_verifier to the token endpoint. (RFC 7636, Section 4.5)
//  6. Server transforms the code_verifier using the code_challenge_method from the initial authorization request and checks the result against the code_challenge. If the value of both strings match, then the server has verified that the requests came from the same client and will issue an access_token. (RFC 7636, Section 4.6)

export async function setupSalesforceConnection(modifyState: Dispatch<SalesforceConnectionStateAction>, logger: Logger, params: connection.SalesforceConnectionParams, config: SalesforceConnectorConfig, platformType: PlatformType, apiClient: SalesforceApiClientInterface, grpcClient: HyperDatabaseClient | null, httpClient: HyperDatabaseClient | null, appEvents: PlatformEventListener, forceReLogin: boolean, abortSignal: AbortSignal): Promise<SalesforceDatabaseChannel> {
    params = structuredClone(params);
    let hyperChannel: HyperDatabaseChannel;
    let sfChannel: SalesforceDatabaseChannel;
    try {
        // Start the authorization process
        modifyState({
            type: SETUP_STARTED,
            value: params,
        });
        abortSignal.throwIfAborted();
        if (!config.auth?.oauthRedirect) {
            throw new Error(`missing oauth redirect url`);
        }
        const onAuthenticationProgress = (progress: SalesforceAuthenticationProgress) => {
            switch (progress.stage) {
                case 'GENERATING_PKCE_CHALLENGE':
                    modifyState({ type: GENERATING_PKCE_CHALLENGE, value: null });
                    break;
                case 'GENERATED_PKCE_CHALLENGE':
                    modifyState({ type: GENERATED_PKCE_CHALLENGE, value: progress.pkceChallenge });
                    break;
                case 'OAUTH_NATIVE_LINK_OPENED':
                    modifyState({ type: OAUTH_NATIVE_LINK_OPENED, value: null });
                    break;
                case 'OAUTH_WEB_WINDOW_OPENED':
                    modifyState({ type: OAUTH_WEB_WINDOW_OPENED, value: null });
                    break;
                case 'OAUTH_WEB_WINDOW_CLOSED':
                    modifyState({ type: OAUTH_WEB_WINDOW_CLOSED, value: null });
                    break;
                case 'RECEIVED_CORE_AUTH_CODE':
                    modifyState({
                        type: RECEIVED_CORE_AUTH_CODE,
                        value: { token: progress.code, createdAt: dateToTimestamp(new Date())! },
                    });
                    break;
                case 'REQUESTING_CORE_AUTH_TOKEN':
                    modifyState({ type: REQUESTING_CORE_AUTH_TOKEN, value: null });
                    break;
                case 'RECEIVED_CORE_AUTH_TOKEN':
                    modifyState({ type: RECEIVED_CORE_AUTH_TOKEN, value: progress.coreAccessToken });
                    break;
                case 'RECEIVED_CORE_USER_INFO':
                    modifyState({ type: RECEIVED_CORE_USER_INFO, value: progress.coreUserInfo });
                    break;
                case 'REQUESTING_DATA_CLOUD_ACCESS_TOKEN':
                    modifyState({ type: REQUESTING_DATA_CLOUD_ACCESS_TOKEN, value: null });
                    break;
                case 'RECEIVED_DATA_CLOUD_ACCESS_TOKEN':
                    modifyState({ type: RECEIVED_DATA_CLOUD_ACCESS_TOKEN, value: progress.dataCloudAccessToken });
                    break;
            }
        };
        const { coreAccessToken, dataCloudAccessToken: dcToken } = await authenticateSalesforce({
            logger,
            params,
            authConfig: config.auth,
            platformType,
            apiClient,
            appEvents,
            forceReLogin,
            abortSignal,
            onProgress: onAuthenticationProgress,
        });
        abortSignal.throwIfAborted();

        // Start the channel setup
        if (params.hyperProtocol === 'WASM') {
            throw new Error('Salesforce connections do not support Hyper WASM');
        }
        const connParams: connection.HyperConnectionParams = {
            protocol: params.hyperProtocol,
            endpoint: dcToken.instanceUrl ?? "",
            tls: {
                clientKeyPath: "",
                clientCertPath: "",
                caCertsPath: ""
            },
            attachedDatabases: [],
            metadata: {
                message: "",
                details: {}
            } as any,
        };
        modifyState({
            type: SF_CHANNEL_SETUP_STARTED,
            value: connParams,
        });
        abortSignal.throwIfAborted()

        // Static connection context.
        // Inject the database name, the audience header and the bearer token
        const authInfo = collectSalesforceAuthInfo(coreAccessToken, dcToken);
        const connectionContext: HyperDatabaseConnectionContext = {
            getAttachedDatabases(): AttachedDatabase[] {
                if (params.hyperProtocol === 'V3_HTTP') return [];
                return [{
                    path: getSalesforceLakehousePath(authInfo?.offcoreTenantId, authInfo?.dataspace ?? "default"),
                    alias: 'lakehouse',
                }];
            },
            async getRequestMetadata(): Promise<Record<string, string>> {
                return {
                    audience: authInfo?.offcoreTenantId ?? "",
                    authorization: `Bearer ${authInfo?.offcoreRawJwt}`,
                };
            },
            getQueryParameters(): Record<string, string> {
                return {};
            }
        };

        // Create the channel
        const client = connParams.protocol === 'V3_HTTP' ? httpClient : grpcClient;
        if (!client) throw new Error(`No client available for protocol ${connParams.protocol}`);
        hyperChannel = await client.connect(connParams, connectionContext);
        sfChannel = new SalesforceDatabaseChannel(apiClient, coreAccessToken, dcToken, hyperChannel);
        abortSignal.throwIfAborted();

        // Mark the channel as ready
        modifyState({
            type: SF_CHANNEL_READY,
            value: sfChannel,
        });
        abortSignal.throwIfAborted();

    } catch (error: any) {
        if (error.name === 'AbortError') {
            logger.info("Cancelled OAuth flow", {}, LOG_CTX);
            modifyState({
                type: SETUP_CANCELLED,
                value: error,
            });
        } else if (error instanceof Error) {
            logger.warn("Failed OAuth flow", { "error": stringifyError(error) }, LOG_CTX);
            modifyState({
                type: SETUP_FAILED,
                value: {
                    message: error.message,
                },
            });
        }
        // Rethrow the error
        throw error;
    }

    return sfChannel;
}

export interface SalesforceSetupApi {
    setup(dispatch: Dispatch<SalesforceConnectionStateAction>, params: connection.SalesforceConnectionParams, abortSignal: AbortSignal): Promise<SalesforceDatabaseChannel>
    reset(dispatch: Dispatch<SalesforceConnectionStateAction>): Promise<void>
}

export function createSalesforceSetup(grpcClient: HyperDatabaseClient | null, httpClient: HyperDatabaseClient | null, salesforceApi: SalesforceApiClientInterface, platformType: PlatformType, appEvents: PlatformEventListener, config: SalesforceConnectorConfig, forceReLogin: boolean, logger: Logger): (SalesforceSetupApi | null) {
    const setup = async (updateState: Dispatch<SalesforceConnectionStateAction>, params: connection.SalesforceConnectionParams, abort: AbortSignal) => {
        return setupSalesforceConnection(updateState, logger, params, config, platformType, salesforceApi, grpcClient, httpClient, appEvents, forceReLogin, abort);
    };
    const reset = async (updateState: Dispatch<SalesforceConnectionStateAction>) => {
        updateState({
            type: RESET_ATTACHED_DATABASE,
            value: null,
        });
    };
    return { setup, reset };
};
