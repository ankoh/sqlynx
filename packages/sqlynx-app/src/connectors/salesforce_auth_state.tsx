import * as React from 'react';
import { VariantKind, Dispatch } from '../utils/variant.js';
import { SalesforceCoreAccessToken, SalesforceDataCloudAccessToken } from './salesforce_api_client.js';
import { PKCEChallenge } from '../utils/pkce.js';

export interface SalesforceAuthTimings {
    /// The time when the auth was requested
    authRequestedAt: Date | null;
    /// The time when the auth failed
    authFailedAt: Date | null;
    /// The time when the PKCE generation started
    pkceGenStartedAt: Date | null;
    /// The time when the PKCE generation finished
    pkceGenFinishedAt: Date | null;
    /// The time when the auth link was opened
    openedAuthLinkAt: Date | null;
    /// The time when the auth window was opened
    openedAuthWindowAt: Date | null;
    /// The time when the auth window was closed
    closedAuthWindowAt: Date | null;
    /// The time when we received the oauth code
    oauthCodeReceivedAt: Date | null;
    /// The time when we started to request the core access token
    coreAccessTokenRequestedAt: Date | null;
    /// The time when we received the core access token
    coreAccessTokenReceivedAt: Date | null;
    /// The time when we started to request the data cloud access token
    dataCloudAccessTokenRequestedAt: Date | null;
    /// The time when we received the data cloud access token
    dataCloudAccessTokenReceievedAt: Date | null;
}

export interface SalesforceAuthState {
    /// The timings
    timings: SalesforceAuthTimings;
    /// The auth params
    authParams: SalesforceAuthParams | null;
    /// The auth started
    authStarted: boolean;
    /// The authentication error
    authError: string | null;
    /// The PKCE challenge
    pkceChallenge: PKCEChallenge | null;
    /// The popup window (if starting the OAuth flow from the browser)
    openAuthWindow: Window | null;
    /// The code
    coreAuthCode: string | null;
    /// The core access token
    coreAccessToken: SalesforceCoreAccessToken | null;
    /// The data cloud access token
    dataCloudAccessToken: SalesforceDataCloudAccessToken | null;
}

export interface SalesforceAuthConfig {
    /// The oauth redirect
    oauthRedirect: string;
}

export interface SalesforceAuthParams {
    /// The base URL
    instanceUrl: string;
    /// The client id
    appConsumerKey: string;
    /// The client secret
    appConsumerSecret: string | null;
}

export const AUTH_FLOW_DEFAULT_STATE: SalesforceAuthState = {
    timings: {
        authRequestedAt: null,
        authFailedAt: null,
        pkceGenStartedAt: null,
        pkceGenFinishedAt: null,
        openedAuthLinkAt: null,
        openedAuthWindowAt: null,
        closedAuthWindowAt: null,
        oauthCodeReceivedAt: null,
        coreAccessTokenRequestedAt: null,
        coreAccessTokenReceivedAt: null,
        dataCloudAccessTokenRequestedAt: null,
        dataCloudAccessTokenReceievedAt: null,
    },
    authParams: null,
    authStarted: false,
    authError: null,
    pkceChallenge: null,
    openAuthWindow: null,
    coreAuthCode: null,
    coreAccessToken: null,
    dataCloudAccessToken: null,
};

export const CONFIGURE = Symbol('CONFIGURE');
export const AUTHORIZE = Symbol('AUTHORIZE');
export const DISCONNECT = Symbol('DISCONNECT');
export const AUTH_FAILED = Symbol('AUTH_FAILED');
export const AUTH_STARTED = Symbol('AUTH_STARTED');
export const GENERATING_PKCE_CHALLENGE = Symbol('GENERATING_PKCE_CHALLENGE');
export const GENERATED_PKCE_CHALLENGE = Symbol('GENERATED_PKCE_CHALLENGE');
export const OAUTH_LINK_OPENED = Symbol('OAUTH_LINK_OPENED');
export const OAUTH_WINDOW_CLOSED = Symbol('OAUTH_WINDOW_CLOSED');
export const OAUTH_WINDOW_OPENED = Symbol('OAUTH_WINDOW_OPENED');
export const RECEIVED_CORE_AUTH_CODE = Symbol('RECEIVED_AUTH_CODE');
export const REQUESTING_CORE_AUTH_TOKEN = Symbol('REQUESTING_CORE_AUTH_TOKEN');
export const RECEIVED_CORE_AUTH_TOKEN = Symbol('RECEIVED_CORE_ACCESS_TOKEN');
export const REQUESTING_DATA_CLOUD_ACCESS_TOKEN = Symbol('REQUESTING_DATA_CLOUD_ACCESS_TOKEN');
export const RECEIVED_DATA_CLOUD_ACCESS_TOKEN = Symbol('RECEIVED_DATA_CLOUD_ACCESS_TOKEN');

export type SalesforceAuthAction =
    | VariantKind<typeof CONFIGURE, SalesforceAuthParams>
    | VariantKind<typeof AUTHORIZE, SalesforceAuthParams>
    | VariantKind<typeof DISCONNECT, null>
    | VariantKind<typeof AUTH_FAILED, string>
    | VariantKind<typeof AUTH_STARTED, null>
    | VariantKind<typeof GENERATING_PKCE_CHALLENGE, null>
    | VariantKind<typeof GENERATED_PKCE_CHALLENGE, PKCEChallenge>
    | VariantKind<typeof OAUTH_LINK_OPENED, null>
    | VariantKind<typeof OAUTH_WINDOW_OPENED, Window>
    | VariantKind<typeof OAUTH_WINDOW_CLOSED, null>
    | VariantKind<typeof RECEIVED_CORE_AUTH_CODE, string>
    | VariantKind<typeof REQUESTING_CORE_AUTH_TOKEN, null>
    | VariantKind<typeof RECEIVED_CORE_AUTH_TOKEN, SalesforceCoreAccessToken>
    | VariantKind<typeof REQUESTING_DATA_CLOUD_ACCESS_TOKEN, null>
    | VariantKind<typeof RECEIVED_DATA_CLOUD_ACCESS_TOKEN, SalesforceDataCloudAccessToken>;

export function reduceAuthState(state: SalesforceAuthState, action: SalesforceAuthAction): SalesforceAuthState {
    switch (action.type) {
        case CONFIGURE:
            return {
                timings: {
                    authRequestedAt: null,
                    authFailedAt: null,
                    pkceGenStartedAt: null,
                    pkceGenFinishedAt: null,
                    openedAuthLinkAt: null,
                    openedAuthWindowAt: null,
                    closedAuthWindowAt: null,
                    oauthCodeReceivedAt: null,
                    coreAccessTokenRequestedAt: null,
                    coreAccessTokenReceivedAt: null,
                    dataCloudAccessTokenRequestedAt: null,
                    dataCloudAccessTokenReceievedAt: null,
                },
                authParams: action.value,
                authStarted: false,
                authError: null,
                pkceChallenge: null,
                openAuthWindow: null,
                coreAuthCode: null,
                coreAccessToken: null,
                dataCloudAccessToken: null,
            };
        case AUTHORIZE:
            return {
                timings: {
                    authRequestedAt: new Date(),
                    authFailedAt: null,
                    pkceGenStartedAt: null,
                    pkceGenFinishedAt: null,
                    openedAuthLinkAt: null,
                    openedAuthWindowAt: null,
                    closedAuthWindowAt: null,
                    oauthCodeReceivedAt: null,
                    coreAccessTokenRequestedAt: null,
                    coreAccessTokenReceivedAt: null,
                    dataCloudAccessTokenRequestedAt: null,
                    dataCloudAccessTokenReceievedAt: null,
                },
                authParams: action.value,
                authStarted: false,
                authError: null,
                pkceChallenge: null,
                openAuthWindow: null,
                coreAuthCode: null,
                coreAccessToken: null,
                dataCloudAccessToken: null,
            };
        case DISCONNECT:
            return {
                timings: {
                    authRequestedAt: new Date(),
                    authFailedAt: null,
                    pkceGenStartedAt: null,
                    pkceGenFinishedAt: null,
                    openedAuthLinkAt: null,
                    openedAuthWindowAt: null,
                    closedAuthWindowAt: null,
                    oauthCodeReceivedAt: null,
                    coreAccessTokenRequestedAt: null,
                    coreAccessTokenReceivedAt: null,
                    dataCloudAccessTokenRequestedAt: null,
                    dataCloudAccessTokenReceievedAt: null,
                },
                authParams: state.authParams,
                authStarted: false,
                authError: null,
                pkceChallenge: null,
                openAuthWindow: null,
                coreAuthCode: null,
                coreAccessToken: null,
                dataCloudAccessToken: null,
            };
        case AUTH_STARTED:
            return {
                ...state,
                authStarted: true,
            };
        case AUTH_FAILED:
            return {
                ...state,
                timings: {
                    ...state.timings,
                    authFailedAt: new Date(),
                },
                authError: action.value,
            };
        case GENERATING_PKCE_CHALLENGE:
            return {
                ...state,
                timings: {
                    ...state.timings,
                    pkceGenStartedAt: new Date(),
                },
            };
        case GENERATED_PKCE_CHALLENGE:
            return {
                ...state,
                timings: {
                    ...state.timings,
                    pkceGenFinishedAt: new Date(),
                },
                pkceChallenge: action.value,
            };
        case OAUTH_LINK_OPENED:
            return {
                ...state,
                timings: {
                    ...state.timings,
                    openedAuthLinkAt: new Date(),
                },
                openAuthWindow: null,
            };
        case OAUTH_WINDOW_OPENED:
            return {
                ...state,
                timings: {
                    ...state.timings,
                    openedAuthWindowAt: new Date(),
                },
                openAuthWindow: action.value,
            };
        case OAUTH_WINDOW_CLOSED:
            if (!state.openAuthWindow) return state;
            return {
                ...state,
                timings: {
                    ...state.timings,
                    closedAuthWindowAt: new Date(),
                },
                openAuthWindow: null,
            };
        case RECEIVED_CORE_AUTH_CODE:
            return {
                ...state,
                timings: {
                    ...state.timings,
                    oauthCodeReceivedAt: new Date(),
                },
                coreAuthCode: action.value,
            };
        case REQUESTING_CORE_AUTH_TOKEN:
            return {
                ...state,
                timings: {
                    ...state.timings,
                    coreAccessTokenRequestedAt: new Date(),
                },
            };
        case RECEIVED_CORE_AUTH_TOKEN:
            return {
                ...state,
                timings: {
                    ...state.timings,
                    coreAccessTokenReceivedAt: new Date(),
                },
                coreAccessToken: action.value,
            };
        case REQUESTING_DATA_CLOUD_ACCESS_TOKEN:
            return {
                ...state,
                timings: {
                    ...state.timings,
                    dataCloudAccessTokenRequestedAt: new Date(),
                },
            };
        case RECEIVED_DATA_CLOUD_ACCESS_TOKEN:
            return {
                ...state,
                timings: {
                    ...state.timings,
                    dataCloudAccessTokenReceievedAt: new Date(),
                },
                dataCloudAccessToken: action.value,
            };
    }
}

export const AUTH_FLOW_STATE_CTX = React.createContext<SalesforceAuthState | null>(null);
export const AUTH_FLOW_DISPATCH_CTX = React.createContext<Dispatch<SalesforceAuthAction> | null>(null);

export const useSalesforceAuthState = (): SalesforceAuthState => React.useContext(AUTH_FLOW_STATE_CTX)!;
export const useSalesforceAuthFlow = (): Dispatch<SalesforceAuthAction> => React.useContext(AUTH_FLOW_DISPATCH_CTX)!;
