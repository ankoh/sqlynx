import * as React from 'react';
import * as shell from '@tauri-apps/plugin-shell';
import * as proto from '@ankoh/sqlynx-protobuf';

import {
    AUTH_CANCELLED,
    AUTH_FAILED,
    AUTH_STARTED,
    GENERATED_PKCE_CHALLENGE,
    GENERATING_PKCE_CHALLENGE,
    OAUTH_NATIVE_LINK_OPENED,
    OAUTH_WEB_WINDOW_OPENED,
    RECEIVED_CORE_AUTH_CODE,
    RECEIVED_CORE_AUTH_TOKEN,
    RECEIVED_DATA_CLOUD_ACCESS_TOKEN,
    RECEIVED_DATA_CLOUD_METADATA,
    REQUESTING_CORE_AUTH_TOKEN,
    REQUESTING_DATA_CLOUD_ACCESS_TOKEN,
    REQUESTING_DATA_CLOUD_METADATA,
    SalesforceConnectionStateAction,
} from './salesforce_connection_state.js';
import { useSalesforceAPI } from './salesforce_connector.js';
import { useAppConfig } from '../../app_config.js';
import { generatePKCEChallenge } from '../../utils/pkce.js';
import { BASE64_CODEC } from '../../utils/base64.js';
import { PlatformType, usePlatformType } from '../../platform/platform_type.js';
import { SalesforceConnectorConfig } from '../connector_configs.js';
import { SalesforceAuthParams } from './salesforce_connection_params.js';
import { HyperGrpcConnectionParams } from '../hyper/hyper_connection_params.js';
import { SalesforceAPIClientInterface } from './salesforce_api_client.js';
import { Dispatch } from '../../utils/variant.js';
import { Logger } from '../../platform/logger.js';
import { AppEventListener } from '../../platform/event_listener.js';
import { useAppEventListener } from '../../platform/event_listener_provider.js';
import { useLogger } from '../../platform/logger_provider.js';
import { isNativePlatform } from '../../platform/native_globals.js';
import { isDebugBuild } from '../../globals.js';
import { RESET } from './../connection_state.js';
import { AttachedDatabase, HyperDatabaseClient, HyperDatabaseConnectionContext } from '../../platform/hyperdb_client.js';
import { useHyperDatabaseClient } from '../../platform/hyperdb_client_provider.js';
import {
    CHANNEL_READY,
    CHANNEL_SETUP_STARTED,
    HEALTH_CHECK_FAILED,
    HEALTH_CHECK_STARTED,
    HEALTH_CHECK_SUCCEEDED,
} from '../hyper/hyper_connection_state.js';

// By default, a Salesforce OAuth Access Token expires after 2 hours = 7200 seconds
const DEFAULT_EXPIRATION_TIME_MS = 2 * 60 * 60 * 1000;

// We use the web-server OAuth Flow with or without consumer secret.
//
// !! Don't embed a client secret of a connected Salesforce App !!
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

const OAUTH_POPUP_NAME = 'SQLynx OAuth';
const OAUTH_POPUP_SETTINGS = 'toolbar=no, menubar=no, width=600, height=700, top=100, left=100';

export async function setupSalesforceConnection(dispatch: Dispatch<SalesforceConnectionStateAction>, logger: Logger, params: SalesforceAuthParams, config: SalesforceConnectorConfig, platformType: PlatformType, apiClient: SalesforceAPIClientInterface, hyperClient: HyperDatabaseClient, appEvents: AppEventListener, abortSignal: AbortSignal): Promise<void> {
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

        // Select the oauth flow variant.
        // This will instruct the redirect to sqlynx.app/oauth.html about the "actual" target.
        // When initiating the OAuth flow from the native app, the redirect will then open a deep link with the OAuth code.
        // When initiating from the web, the redirect will assume there's an opener that it can post the code to.
        const flowVariant = platformType !== PlatformType.WEB
            ? proto.sqlynx_oauth.pb.OAuthFlowVariant.NATIVE_LINK_FLOW
            : proto.sqlynx_oauth.pb.OAuthFlowVariant.WEB_OPENER_FLOW;

        // Construct the auth state
        const authState = new proto.sqlynx_oauth.pb.OAuthState({
            debugMode: isNativePlatform() && isDebugBuild(),
            flowVariant: flowVariant,
            providerOptions: {
                case: "salesforceProvider",
                value: new proto.sqlynx_oauth.pb.SalesforceOAuthOptions({
                    instanceUrl: params.instanceUrl,
                    appConsumerKey: params.appConsumerKey,
                    expiresAt: BigInt(Date.now()) + BigInt(DEFAULT_EXPIRATION_TIME_MS)
                }),
            }
        });
        const authStateBuffer = authState.toBinary();
        const authStateBase64 = BASE64_CODEC.encode(authStateBuffer.buffer);

        // Collect the oauth parameters
        const paramParts = [
            `client_id=${params.appConsumerKey}`,
            `redirect_uri=${config.auth.oauthRedirect}`,
            `code_challenge=${pkceChallenge.value}`,
            `code_challange_method=S256`,
            `response_type=code`,
            `state=${authStateBase64}`
        ];
        if (params.loginHint != null) {
            paramParts.push(`login_hint=${params.loginHint}`);
        }
        const url = `${params.instanceUrl}/services/oauth2/authorize?${paramParts.join('&')}`;

        // Either start request the oauth flow through a browser popup or by opening a url using the shell plugin
        if (flowVariant == proto.sqlynx_oauth.pb.OAuthFlowVariant.WEB_OPENER_FLOW) {
            logger.debug(`opening popup: ${url.toString()}`, "salesforce_auth");
            // Open popup window
            const popup = window.open(url, OAUTH_POPUP_NAME, OAUTH_POPUP_SETTINGS);
            if (!popup) {
                // Something went wrong, Browser might prevent the popup.
                // (E.g. FF blocks by default)
                throw new Error('could not open oauth window');
            }
            popup.focus();
            dispatch({ type: OAUTH_WEB_WINDOW_OPENED, value: popup });
        } else {
            // Just open the link with the default browser
            logger.debug(`opening url: ${url.toString()}`, "salesforce_auth");
            shell.open(url);
            dispatch({ type: OAUTH_NATIVE_LINK_OPENED, value: null });
        }

        // Await the oauth redirect
        const authCode = await appEvents.waitForOAuthRedirect(abortSignal);
        abortSignal.throwIfAborted();
        logger.debug(`received oauth code: ${JSON.stringify(authCode)}`);

        // Received an oauth error?
        if (authCode.error) {
            throw new Error(authCode.error);
        }
        dispatch({
            type: RECEIVED_CORE_AUTH_CODE,
            value: authCode.code,
        });

        // Request the core access token
        dispatch({
            type: REQUESTING_CORE_AUTH_TOKEN,
            value: null,
        });
        const coreAccessToken = await apiClient.getCoreAccessToken(
            config.auth,
            params,
            authCode.code,
            pkceChallenge.verifier,
            abortSignal,
        );
        logger.debug(`received core access token: ${JSON.stringify(coreAccessToken)}`);
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
        const dcToken = await apiClient.getDataCloudAccessToken(coreAccessToken, abortSignal);
        logger.debug(`received data cloud token: ${JSON.stringify(dcToken)}`);
        dispatch({
            type: RECEIVED_DATA_CLOUD_ACCESS_TOKEN,
            value: dcToken,
        });
        abortSignal.throwIfAborted();

        // Request the data cloud metadata
        dispatch({
            type: REQUESTING_DATA_CLOUD_METADATA,
            value: null,
        });
        const metadata = await apiClient.getDataCloudMetadata(dcToken, abortSignal);
        logger.debug(`received data cloud metadata`);
        dispatch({
            type: RECEIVED_DATA_CLOUD_METADATA,
            value: metadata,
        });
        abortSignal.throwIfAborted();

        // Start the channel setup
        const connParams: HyperGrpcConnectionParams = {
            channelArgs: {
                endpoint: dcToken.instanceUrl.toString(),
                tls: {},
            },
            attachedDatabases: [],
            gRPCMetadata: []
        };
        dispatch({
            type: CHANNEL_SETUP_STARTED,
            value: connParams,
        });
        abortSignal.throwIfAborted()

        // Static connection context.
        // Inject the database name, the audience header and the bearer token
        const connectionContext: HyperDatabaseConnectionContext = {
            getAttachedDatabases(): AttachedDatabase[] {
                return [{
                    path: "lakehouse:" + dcToken.dcTenantId + ";default",
                }];
            },
            async getRequestMetadata(): Promise<Record<string, string>> {
                return {
                    audience: dcToken.dcTenantId,
                    authorization: `Bearer ${dcToken.jwt.raw}`,
                };
            }
        };

        // Create the channel
        const channel = await hyperClient.connect(connParams.channelArgs, connectionContext);
        abortSignal.throwIfAborted();

        // Mark the channel as ready
        dispatch({
            type: CHANNEL_READY,
            value: channel,
        });
        abortSignal.throwIfAborted();

        // Start the channel setup
        dispatch({
            type: HEALTH_CHECK_STARTED,
            value: null,
        });
        abortSignal.throwIfAborted();

        // Create the channel
        const health = await channel.checkHealth();
        abortSignal.throwIfAborted();

        if (health.ok) {
            dispatch({
                type: HEALTH_CHECK_SUCCEEDED,
                value: null,
            });
            return;
        } else {
            dispatch({
                type: HEALTH_CHECK_FAILED,
                value: health.errorMessage!,
            });
            return;
        }

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
        throw error;
    }

}

export interface SalesforceSetupApi {
    authorize(dispatch: Dispatch<SalesforceConnectionStateAction>, params: SalesforceAuthParams, abortSignal: AbortSignal): Promise<void>
    reset(dispatch: Dispatch<SalesforceConnectionStateAction>): Promise<void>
}

export const SETUP_CTX = React.createContext<SalesforceSetupApi | null>(null);
export const useSalesforceSetup = () => React.useContext(SETUP_CTX!);

interface Props {
    /// The children
    children: React.ReactElement;
}

export const SalesforceSetupProvider: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const appConfig = useAppConfig();
    const appEvents = useAppEventListener();
    const platformType = usePlatformType();
    const salesforceApi = useSalesforceAPI();
    const hyperClient = useHyperDatabaseClient();
    const connectorConfig = appConfig.value?.connectors?.salesforce ?? null;

    const api = React.useMemo<SalesforceSetupApi | null>(() => {
        if (!connectorConfig || !hyperClient) {
            return null;
        }
        const auth = async (dispatch: Dispatch<SalesforceConnectionStateAction>, params: SalesforceAuthParams, abort: AbortSignal) => {
            return setupSalesforceConnection(dispatch, logger, params, connectorConfig, platformType, salesforceApi, hyperClient, appEvents, abort);
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
