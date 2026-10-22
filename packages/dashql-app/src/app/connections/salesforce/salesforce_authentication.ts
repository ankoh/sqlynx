import * as auth from '@ankoh/dashql-jsonschema/auth.js';
import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import type { OAuthRedirectData, OAuthState } from '../../../oauth_types.js';
import { isDebugBuild } from '../../../globals.js';
import { PlatformEventListener } from '../../../platform/events/event_listener.js';
import { Logger, stringifyError } from '../../../platform/logger/logger.js';
import { PlatformType } from '../../../platform/platform_type.js';
import { BASE64URL_CODEC } from '../../../utils/base64.js';
import { generatePKCEChallenge } from '../../../utils/pkce.js';
import { SalesforceApiClientInterface } from './salesforce_api_client.js';

const LOG_CTX = 'salesforce_authentication';
const DEFAULT_EXPIRATION_TIME_MS = 2 * 60 * 60 * 1000;
const OAUTH_POPUP_NAME = 'DashQL OAuth';
const OAUTH_POPUP_SETTINGS = 'toolbar=no, menubar=no, width=600, height=700, top=100, left=100';

export type SalesforceAuthenticationProgress =
    | { stage: 'GENERATING_PKCE_CHALLENGE' }
    | { stage: 'GENERATED_PKCE_CHALLENGE'; pkceChallenge: auth.OAuthPKCEChallenge }
    | { stage: 'OAUTH_NATIVE_LINK_OPENED' }
    | { stage: 'OAUTH_WEB_WINDOW_OPENED' }
    | { stage: 'OAUTH_WEB_WINDOW_CLOSED' }
    | { stage: 'RECEIVED_CORE_AUTH_CODE'; code: string }
    | { stage: 'REQUESTING_CORE_AUTH_TOKEN' }
    | { stage: 'RECEIVED_CORE_AUTH_TOKEN'; coreAccessToken: connection.SalesforceCoreAccessToken }
    | { stage: 'RECEIVED_CORE_USER_INFO'; coreUserInfo: connection.SalesforceCoreUserInfo }
    | { stage: 'REQUESTING_DATA_CLOUD_ACCESS_TOKEN' }
    | { stage: 'RECEIVED_DATA_CLOUD_ACCESS_TOKEN'; dataCloudAccessToken: connection.SalesforceDataCloudAccessToken };

export interface SalesforceAuthenticationResult {
    coreAccessToken: connection.SalesforceCoreAccessToken;
    dataCloudAccessToken: connection.SalesforceDataCloudAccessToken;
    coreUserInfo?: connection.SalesforceCoreUserInfo;
}

export interface SalesforceAuthenticationOptions {
    logger: Logger;
    params: connection.SalesforceConnectionParams;
    authConfig: connection.SalesforceOAuthConfig;
    platformType: PlatformType;
    apiClient: SalesforceApiClientInterface;
    appEvents: PlatformEventListener;
    forceReLogin: boolean;
    abortSignal: AbortSignal;
    oauthPopup?: Window | null;
    onProgress?: (progress: SalesforceAuthenticationProgress) => void;
}

export function buildSalesforceAuthorizationUrl(
    params: connection.SalesforceConnectionParams,
    authConfig: connection.SalesforceOAuthConfig,
    pkceChallenge: auth.OAuthPKCEChallenge,
    state: OAuthState,
    forceReLogin: boolean,
): URL {
    const url = new URL('/services/oauth2/authorize', params.instanceUrl);
    url.search = new URLSearchParams({
        client_id: params.appConsumerKey,
        redirect_uri: authConfig.oauthRedirect,
        code_challenge: pkceChallenge.value,
        code_challenge_method: 'S256',
        response_type: 'code',
        state: BASE64URL_CODEC.encode(new TextEncoder().encode(JSON.stringify(state)).buffer),
    }).toString();
    if (forceReLogin) {
        url.searchParams.set('prompt', 'login');
    }
    if (params.login) {
        url.searchParams.set('login_hint', params.login);
    }
    return url;
}

export function validateSalesforceOAuthCallbackState(
    callback: OAuthRedirectData,
    expected: OAuthState,
    now = Date.now(),
): void {
    const actual = callback.state;
    const actualProvider = actual?.salesforceProvider;
    const expectedProvider = expected.salesforceProvider;
    if (!actual || !actualProvider || !expectedProvider) {
        throw new Error('OAuth callback state is missing the Salesforce provider');
    }
    if (actual.flowId !== expected.flowId) {
        throw new Error('OAuth callback flow ID does not match');
    }
    if (actual.flowVariant !== expected.flowVariant) {
        throw new Error('OAuth callback flow variant does not match');
    }
    if (actualProvider.instanceUrl !== expectedProvider.instanceUrl
        || actualProvider.appConsumerKey !== expectedProvider.appConsumerKey) {
        throw new Error('OAuth callback Salesforce provider does not match');
    }
    if (actualProvider.expiresAt !== expectedProvider.expiresAt || actualProvider.expiresAt <= now) {
        throw new Error('OAuth callback state has expired');
    }
}

export async function authenticateSalesforce(options: SalesforceAuthenticationOptions): Promise<SalesforceAuthenticationResult> {
    const {
        logger,
        params,
        authConfig,
        platformType,
        apiClient,
        appEvents,
        forceReLogin,
        abortSignal,
        oauthPopup: reservedOAuthPopup,
        onProgress = () => {},
    } = options;
    let oauthPopup: Window | null = reservedOAuthPopup ?? null;
    const closeOAuthPopup = () => {
        if (!oauthPopup) return;
        if (!oauthPopup.closed) {
            oauthPopup.close();
        }
        oauthPopup = null;
        onProgress({ stage: 'OAUTH_WEB_WINDOW_CLOSED' });
    };

    try {
        abortSignal.throwIfAborted();
        onProgress({ stage: 'GENERATING_PKCE_CHALLENGE' });
        const pkceChallenge = await generatePKCEChallenge();
        abortSignal.throwIfAborted();
        onProgress({ stage: 'GENERATED_PKCE_CHALLENGE', pkceChallenge });

        const flowVariant: OAuthState['flowVariant'] = platformType === PlatformType.WEB
            ? 'WEB_OPENER_FLOW'
            : 'NATIVE_LINK_FLOW';
        const requestedAt = Date.now();
        const state: OAuthState = {
            flowId: crypto.randomUUID(),
            flowVariant,
            debugMode: isDebugBuild(),
            ...(flowVariant === 'WEB_OPENER_FLOW'
                ? { callbackUrl: new URL('/oauth.html', window.location.origin).toString() }
                : {}),
            salesforceProvider: {
                instanceUrl: params.instanceUrl,
                appConsumerKey: params.appConsumerKey,
                requestedAt,
                expiresAt: requestedAt + DEFAULT_EXPIRATION_TIME_MS,
            },
        };
        const authorizationUrl = buildSalesforceAuthorizationUrl(
            params,
            authConfig,
            pkceChallenge,
            state,
            forceReLogin,
        );
        const authorizationParameters = Object.fromEntries(authorizationUrl.searchParams.entries());
        authorizationParameters.state = '<redacted>';
        authorizationParameters.code_challenge = '<redacted>';
        if (authorizationParameters.login_hint) authorizationParameters.login_hint = '<redacted>';
        logger.info('Opening Salesforce OAuth authorization URL', {
            endpoint: `${authorizationUrl.origin}${authorizationUrl.pathname}`,
            flowVariant,
            authorizationParameters: JSON.stringify(authorizationParameters),
            oauthState: JSON.stringify({
                flowId: '<redacted>',
                flowVariant: state.flowVariant,
                debugMode: state.debugMode,
                callbackUrl: state.callbackUrl ?? null,
                salesforceProvider: {
                    instanceUrl: state.salesforceProvider?.instanceUrl,
                    appConsumerKey: state.salesforceProvider?.appConsumerKey,
                    requestedAt: state.salesforceProvider?.requestedAt,
                    expiresAt: state.salesforceProvider?.expiresAt,
                },
            }),
        }, LOG_CTX);

        if (flowVariant === 'NATIVE_LINK_FLOW') {
            const bridge = globalThis.dashqlElectron;
            if (!bridge) throw new Error('desktop OAuth bridge is unavailable');
            await bridge.openExternal(authorizationUrl.toString());
            onProgress({ stage: 'OAUTH_NATIVE_LINK_OPENED' });
        } else {
            const popup = oauthPopup ?? window.open(authorizationUrl, OAUTH_POPUP_NAME, OAUTH_POPUP_SETTINGS);
            if (!popup) {
                throw new Error('could not open oauth window');
            }
            oauthPopup = popup;
            if (reservedOAuthPopup) popup.location.replace(authorizationUrl.toString());
            popup.focus();
            onProgress({ stage: 'OAUTH_WEB_WINDOW_OPENED' });
        }

        const callback = await appEvents.waitForOAuthRedirect(
            abortSignal,
            candidate => candidate.state?.flowId === state.flowId,
        ) as OAuthRedirectData;
        abortSignal.throwIfAborted();
        closeOAuthPopup();
        validateSalesforceOAuthCallbackState(callback, state);
        if (callback.error) {
            throw new Error(callback.errorDescription || callback.error);
        }
        if (!callback.code) {
            throw new Error('OAuth callback did not include an authorization code');
        }
        onProgress({ stage: 'RECEIVED_CORE_AUTH_CODE', code: callback.code });

        onProgress({ stage: 'REQUESTING_CORE_AUTH_TOKEN' });
        const coreAccessToken = await apiClient.getCoreAccessToken(
            authConfig,
            params,
            callback.code,
            pkceChallenge.verifier,
            abortSignal,
        );
        abortSignal.throwIfAborted();
        onProgress({ stage: 'RECEIVED_CORE_AUTH_TOKEN', coreAccessToken });

        let coreUserInfo: connection.SalesforceCoreUserInfo | undefined;
        try {
            coreUserInfo = await apiClient.getCoreUserInfo(coreAccessToken, abortSignal);
            abortSignal.throwIfAborted();
            onProgress({ stage: 'RECEIVED_CORE_USER_INFO', coreUserInfo });
        } catch (error: any) {
            if (error?.name === 'AbortError') {
                throw error;
            }
            logger.info('Could not resolve core user info; login hint will be skipped', {
                error: stringifyError(error),
            }, LOG_CTX);
        }

        onProgress({ stage: 'REQUESTING_DATA_CLOUD_ACCESS_TOKEN' });
        const dataCloudAccessToken = await apiClient.getDataCloudAccessToken(coreAccessToken, abortSignal);
        abortSignal.throwIfAborted();
        onProgress({ stage: 'RECEIVED_DATA_CLOUD_ACCESS_TOKEN', dataCloudAccessToken });
        return { coreAccessToken, dataCloudAccessToken, coreUserInfo };
    } finally {
        closeOAuthPopup();
    }
}
