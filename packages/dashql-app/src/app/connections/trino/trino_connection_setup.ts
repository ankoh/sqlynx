import * as connection from '@ankoh/dashql-jsonschema/connection.js';
import * as auth from '@ankoh/dashql-jsonschema/auth.js';

import {
    TRINO_CHANNEL_READY,
    TRINO_CHANNEL_SETUP_CANCELLED,
    TRINO_CHANNEL_SETUP_FAILED,
    TRINO_CHANNEL_SETUP_STARTED,
    TrinoConnectorAction,
    OAUTH_STARTED,
    OAUTH_CANCELLED,
    OAUTH_FAILED,
    GENERATING_PKCE_CHALLENGE,
    GENERATED_PKCE_CHALLENGE,
    OAUTH_BROWSER_OPENED,
    RECEIVED_OAUTH_CODE,
    REQUESTING_ACCESS_TOKEN,
    RECEIVED_ACCESS_TOKEN,
} from './trino_connection_state.js';
import { Dispatch } from '../../../utils/index.js';
import { LoggableException, Logger, stringifyError } from '../../../platform/logger/logger.js';
import { RESET_ATTACHED_DATABASE } from '../attached_database_state.js';
import { requestTrinoAccessToken, TrinoApiClientInterface, TrinoApiEndpoint } from './trino_api_client.js';
import { TrinoChannel, TrinoChannelInterface } from './trino_channel.js';
import { TrinoConnectorConfig } from '../connector_configs.js';
import { generatePKCEChallenge } from '../../../utils/pkce.js';
import { PlatformType } from '../../../platform/platform_type.js';
import { HttpClient } from '../../../platform/http/http_client.js';
import { dateToTimestamp } from '../proto_helper.js';

const LOG_CTX = "trino_setup";

// Default OAuth callback URL for Trino
const DEFAULT_OAUTH_CALLBACK_URL = "http://localhost:56512/Callback";
// Default OAuth scopes if the connection does not configure any
const DEFAULT_OAUTH_SCOPES = ["openid", "email", "profile", "offline_access"];

/// Setup Trino connection with basic auth (username/password)
async function setupTrinoConnectionBasic(
    modifyState: Dispatch<TrinoConnectorAction>,
    logger: Logger,
    params: connection.TrinoConnectionParams,
    client: TrinoApiClientInterface,
    abortSignal: AbortSignal
): Promise<TrinoChannelInterface> {
    let channel: TrinoChannelInterface;
    try {
        // Start the channel setup
        modifyState({
            type: TRINO_CHANNEL_SETUP_STARTED,
            value: params,
        });
        abortSignal.throwIfAborted();

        // Create the channel
        const auth = params.auth ?? ({
            authType: "AUTH_BASIC",
            basic: ({
                username: "",
                secret: "",
            })
        });
        const endpoint = new TrinoApiEndpoint(params.endpoint, auth);
        channel = new TrinoChannel(logger, client, endpoint, params.catalogName);

        // Mark the channel as ready
        modifyState({
            type: TRINO_CHANNEL_READY,
            value: channel,
        });
        abortSignal.throwIfAborted();

    } catch (error: any) {
        if (error.name === 'AbortError') {
            logger.warn("Cancelled setup", {}, LOG_CTX);
            modifyState({
                type: TRINO_CHANNEL_SETUP_CANCELLED,
                value: error.message,
            });
        } else {
            logger.warn("Setup failed", { "message": error.message, "details": error.data }, LOG_CTX);
            modifyState({
                type: TRINO_CHANNEL_SETUP_FAILED,
                value: error,
            });
        }
        throw error;
    }

    return channel;
}

/// Wait for the OAuth redirect to reach the native loopback server
async function waitForOAuthCallback(bridge: DashQLElectronBridge, loopbackId: number, abortSignal: AbortSignal): Promise<DashQLOAuthLoopbackResult> {
    const onAbort = () => void bridge.oauthLoopback.close(loopbackId);
    abortSignal.addEventListener('abort', onAbort, { once: true });
    try {
        return await bridge.oauthLoopback.wait(loopbackId);
    } catch (e: any) {
        abortSignal.throwIfAborted();
        throw e;
    } finally {
        abortSignal.removeEventListener('abort', onAbort);
    }
}

/// Setup Trino connection with OAuth
async function setupTrinoConnectionOAuth(
    modifyState: Dispatch<TrinoConnectorAction>,
    logger: Logger,
    params: connection.TrinoConnectionParams,
    _config: TrinoConnectorConfig,
    client: TrinoApiClientInterface,
    httpClient: HttpClient,
    forceReLogin: boolean,
    abortSignal: AbortSignal
): Promise<TrinoChannelInterface> {
    let channel: TrinoChannelInterface;

    if (params.auth?.authType != "AUTH_OAUTH" || !params.auth?.oauth) {
        throw new LoggableException("OAuth configuration is required for OAuth authentication", {}, LOG_CTX);
    }
    const oauthConfig = params.auth.oauth;
    let loopbackId: number | null = null;

    try {
        // Start OAuth flow
        logger.debug("Starting Trino OAuth flow", {}, LOG_CTX);
        modifyState({ type: OAUTH_STARTED, value: params });
        abortSignal.throwIfAborted();

        // Generate PKCE challenge
        logger.debug("Generating PKCE challenge", {}, LOG_CTX);
        modifyState({ type: GENERATING_PKCE_CHALLENGE, value: null });
        const pkceChallenge = await generatePKCEChallenge();
        abortSignal.throwIfAborted();
        modifyState({ type: GENERATED_PKCE_CHALLENGE, value: pkceChallenge });

        // The redirect is received by a loopback server of the desktop app
        const bridge = globalThis.dashqlElectron;
        if (!bridge) {
            throw new LoggableException("Trino OAuth requires the DashQL desktop app", {}, LOG_CTX);
        }
        const callbackUrl = oauthConfig.callbackUrl || DEFAULT_OAUTH_CALLBACK_URL;
        loopbackId = await bridge.oauthLoopback.listen(callbackUrl);
        abortSignal.throwIfAborted();

        // Build the authorization URL
        const state = crypto.randomUUID();
        const scopes = oauthConfig.scopes?.length ? oauthConfig.scopes : DEFAULT_OAUTH_SCOPES;
        const authURLParams = new URLSearchParams({
            client_id: oauthConfig.clientId,
            redirect_uri: callbackUrl,
            response_type: 'code',
            code_challenge: pkceChallenge.value,
            code_challenge_method: 'S256',
            scope: scopes.join(' '),
            state,
        });
        if (forceReLogin) {
            // Force the identity provider to re-authenticate instead of silently reusing an
            // existing session cookie in the system browser.
            authURLParams.set('prompt', 'login');
        }
        const authUrl = `${oauthConfig.authorizationUrl}?${authURLParams.toString()}`;

        // Open the browser for OAuth
        logger.debug("Opening OAuth URL", { url: authUrl }, LOG_CTX);
        await bridge.openExternal(authUrl);
        modifyState({
            type: OAUTH_BROWSER_OPENED,
            value: null,
        });
        abortSignal.throwIfAborted();

        // Wait for the OAuth callback
        const callbackData = await waitForOAuthCallback(bridge, loopbackId, abortSignal);
        abortSignal.throwIfAborted();

        // Check for errors
        if (callbackData.error) {
            throw new LoggableException(callbackData.errorDescription || callbackData.error, {}, LOG_CTX);
        }
        if (callbackData.state !== state) {
            throw new LoggableException("OAuth callback state does not match the authorization request", {}, LOG_CTX);
        }
        if (!callbackData.code) {
            throw new LoggableException("No authorization code received", {}, LOG_CTX);
        }
        const authCode = {
            token: callbackData.code,
            createdAt: dateToTimestamp(new Date())!
        };

        logger.debug("Received authorization code", {}, LOG_CTX);
        modifyState({
            type: RECEIVED_OAUTH_CODE,
            value: {
                token: authCode.token,
                createdAt: authCode.createdAt,
            },
        });

        // Exchange the code for an access token
        modifyState({
            type: REQUESTING_ACCESS_TOKEN,
            value: null,
        });
        logger.debug("Exchanging authorization code for token", { tokenEndpoint: oauthConfig.tokenUrl }, LOG_CTX);
        const accessToken = await requestTrinoAccessToken(httpClient, oauthConfig.tokenUrl, new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: oauthConfig.clientId,
            code: callbackData.code,
            redirect_uri: callbackUrl,
            code_verifier: pkceChallenge.verifier,
        }));
        abortSignal.throwIfAborted();

        logger.debug("Received access token", {}, LOG_CTX);
        modifyState({
            type: RECEIVED_ACCESS_TOKEN,
            value: accessToken,
        });

        // Now setup the channel with the access token
        modifyState({
            type: TRINO_CHANNEL_SETUP_STARTED,
            value: params,
        });
        abortSignal.throwIfAborted();

        // Create the channel
        const endpoint = new TrinoApiEndpoint(params.endpoint, params.auth);
        endpoint.oauthState = ({
            oauthPkce: pkceChallenge,
            authCode,
            accessToken
        });
        channel = new TrinoChannel(logger, client, endpoint, params.catalogName);

        // Mark the channel as ready
        modifyState({
            type: TRINO_CHANNEL_READY,
            value: channel,
        });
        abortSignal.throwIfAborted();

    } catch (error: any) {
        if (error.name === 'AbortError') {
            logger.info("Cancelled OAuth flow", {}, LOG_CTX);
            modifyState({
                type: OAUTH_CANCELLED,
                value: {
                    message: error.message || "OAuth flow was aborted",
                },
            });
        } else {
            logger.warn("Failed OAuth flow", { "error": stringifyError(error) }, LOG_CTX);
            modifyState({
                type: OAUTH_FAILED,
                value: {
                    message: error.message || "OAuth flow failed",
                },
            });
        }
        throw error;
    } finally {
        if (loopbackId !== null) {
            void globalThis.dashqlElectron?.oauthLoopback.close(loopbackId).catch(() => { });
        }
    }

    return channel;
}

/// Main setup function that routes to the appropriate auth method
export async function setupTrinoConnection(
    modifyState: Dispatch<TrinoConnectorAction>,
    logger: Logger,
    params: connection.TrinoConnectionParams,
    config: TrinoConnectorConfig,
    client: TrinoApiClientInterface,
    httpClient: HttpClient,
    _platformType: PlatformType,
    forceReLogin: boolean,
    abortSignal: AbortSignal
): Promise<TrinoChannelInterface> {
    // Determine auth type
    params = structuredClone(params);
    delete params.draftRows;
    const authType = params.auth?.authType ?? "AUTH_BASIC";
    switch (authType) {
        case "AUTH_OAUTH":
            return await setupTrinoConnectionOAuth(modifyState, logger, params, config, client, httpClient, forceReLogin, abortSignal);
        case "AUTH_BASIC":
        default:
            return await setupTrinoConnectionBasic(modifyState, logger, params, client, abortSignal);
    }
}

export interface TrinoSetupApi {
    setup(dispatch: Dispatch<TrinoConnectorAction>, params: connection.TrinoConnectionParams, abortSignal: AbortSignal): Promise<TrinoChannelInterface | null>
    reset(dispatch: Dispatch<TrinoConnectorAction>): Promise<void>
}

export function createTrinoSetup(
    trinoClient: TrinoApiClientInterface,
    config: TrinoConnectorConfig,
    logger: Logger,
    httpClient: HttpClient,
    platformType: PlatformType,
    forceReLogin: boolean
): (TrinoSetupApi | null) {
    const setup = async (modifyState: Dispatch<TrinoConnectorAction>, params: connection.TrinoConnectionParams, abort: AbortSignal) => {
        return await setupTrinoConnection(modifyState, logger, params, config, trinoClient, httpClient, platformType, forceReLogin, abort);
    };
    const reset = async (updateState: Dispatch<TrinoConnectorAction>) => {
        updateState({
            type: RESET_ATTACHED_DATABASE,
            value: null,
        })
    };
    return { setup, reset };
};
