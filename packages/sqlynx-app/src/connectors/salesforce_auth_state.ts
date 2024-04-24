import { PKCEChallenge } from '../utils/pkce.js';
import { VariantKind } from '../utils/variant.js';
import { SalesforceCoreAccessToken, SalesforceDataCloudAccessToken } from './salesforce_api_client.js';
import { SalesforceAuthParams } from './connector_configs.js';

export interface SalesforceAuthTimings {
    /// The time when the auth started
    authStartedAt: Date | null;
    /// The time when the auth got cancelled
    authCancelledAt: Date | null;
    /// The time when the auth failed
    authFailedAt: Date | null;
    /// The time when the PKCE generation started
    pkceGenStartedAt: Date | null;
    /// The time when the PKCE generation finished
    pkceGenFinishedAt: Date | null;
    /// The time when the auth link was opened
    openedNativeAuthLinkAt: Date | null;
    /// The time when the auth window was opened
    openedWebAuthWindowAt: Date | null;
    /// The time when the auth window was closed
    closedWebAuthWindowAt: Date | null;
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

export const AUTH_FLOW_DEFAULT_STATE: SalesforceAuthState = {
    timings: {
        authCancelledAt: null,
        authFailedAt: null,
        authStartedAt: null,
        pkceGenStartedAt: null,
        pkceGenFinishedAt: null,
        openedNativeAuthLinkAt: null,
        openedWebAuthWindowAt: null,
        closedWebAuthWindowAt: null,
        oauthCodeReceivedAt: null,
        coreAccessTokenRequestedAt: null,
        coreAccessTokenReceivedAt: null,
        dataCloudAccessTokenRequestedAt: null,
        dataCloudAccessTokenReceievedAt: null,
    },
    authParams: null,
    authError: null,
    pkceChallenge: null,
    openAuthWindow: null,
    coreAuthCode: null,
    coreAccessToken: null,
    dataCloudAccessToken: null,
};

export const RESET = Symbol('RESET');
export const AUTH_CANCELLED = Symbol('AUTH_CANCELLED');
export const AUTH_FAILED = Symbol('AUTH_FAILED');
export const AUTH_STARTED = Symbol('AUTH_STARTED');
export const GENERATING_PKCE_CHALLENGE = Symbol('GENERATING_PKCE_CHALLENGE');
export const GENERATED_PKCE_CHALLENGE = Symbol('GENERATED_PKCE_CHALLENGE');
export const OAUTH_NATIVE_LINK_OPENED = Symbol('OAUTH_NATIVE_LINK_OPENED');
export const OAUTH_WEB_WINDOW_CLOSED = Symbol('OAUTH_WEB_WINDOW_CLOSED');
export const OAUTH_WEB_WINDOW_OPENED = Symbol('OAUTH_WEB_WINDOW_OPENED');
export const RECEIVED_CORE_AUTH_CODE = Symbol('RECEIVED_AUTH_CODE');
export const REQUESTING_CORE_AUTH_TOKEN = Symbol('REQUESTING_CORE_AUTH_TOKEN');
export const RECEIVED_CORE_AUTH_TOKEN = Symbol('RECEIVED_CORE_ACCESS_TOKEN');
export const REQUESTING_DATA_CLOUD_ACCESS_TOKEN = Symbol('REQUESTING_DATA_CLOUD_ACCESS_TOKEN');
export const RECEIVED_DATA_CLOUD_ACCESS_TOKEN = Symbol('RECEIVED_DATA_CLOUD_ACCESS_TOKEN');

export type SalesforceAuthAction =
    | VariantKind<typeof RESET, null>
    | VariantKind<typeof AUTH_STARTED, SalesforceAuthParams>
    | VariantKind<typeof AUTH_FAILED, string>
    | VariantKind<typeof AUTH_CANCELLED, string>
    | VariantKind<typeof GENERATING_PKCE_CHALLENGE, null>
    | VariantKind<typeof GENERATED_PKCE_CHALLENGE, PKCEChallenge>
    | VariantKind<typeof OAUTH_NATIVE_LINK_OPENED, null>
    | VariantKind<typeof OAUTH_WEB_WINDOW_OPENED, Window>
    | VariantKind<typeof OAUTH_WEB_WINDOW_CLOSED, null>
    | VariantKind<typeof RECEIVED_CORE_AUTH_CODE, string>
    | VariantKind<typeof REQUESTING_CORE_AUTH_TOKEN, null>
    | VariantKind<typeof RECEIVED_CORE_AUTH_TOKEN, SalesforceCoreAccessToken>
    | VariantKind<typeof REQUESTING_DATA_CLOUD_ACCESS_TOKEN, null>
    | VariantKind<typeof RECEIVED_DATA_CLOUD_ACCESS_TOKEN, SalesforceDataCloudAccessToken>;

export function reduceAuthState(state: SalesforceAuthState, action: SalesforceAuthAction): SalesforceAuthState {
    switch (action.type) {
        case AUTH_STARTED:
            return {
                timings: {
                    authStartedAt: new Date(),
                    authCancelledAt: null,
                    authFailedAt: null,
                    pkceGenStartedAt: null,
                    pkceGenFinishedAt: null,
                    openedNativeAuthLinkAt: null,
                    openedWebAuthWindowAt: null,
                    closedWebAuthWindowAt: null,
                    oauthCodeReceivedAt: null,
                    coreAccessTokenRequestedAt: null,
                    coreAccessTokenReceivedAt: null,
                    dataCloudAccessTokenRequestedAt: null,
                    dataCloudAccessTokenReceievedAt: null,
                },
                authParams: action.value,
                authError: null,
                pkceChallenge: null,
                openAuthWindow: null,
                coreAuthCode: null,
                coreAccessToken: null,
                dataCloudAccessToken: null,
            };
        case RESET:
            return {
                timings: {
                    authStartedAt: new Date(),
                    authCancelledAt: null,
                    authFailedAt: null,
                    pkceGenStartedAt: null,
                    pkceGenFinishedAt: null,
                    openedNativeAuthLinkAt: null,
                    openedWebAuthWindowAt: null,
                    closedWebAuthWindowAt: null,
                    oauthCodeReceivedAt: null,
                    coreAccessTokenRequestedAt: null,
                    coreAccessTokenReceivedAt: null,
                    dataCloudAccessTokenRequestedAt: null,
                    dataCloudAccessTokenReceievedAt: null,
                },
                authParams: state.authParams,
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
            };
        case AUTH_CANCELLED:
            return {
                ...state,
                timings: {
                    ...state.timings,
                    authCancelledAt: new Date(),
                },
                authError: action.value
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
        case OAUTH_NATIVE_LINK_OPENED:
            return {
                ...state,
                timings: {
                    ...state.timings,
                    openedNativeAuthLinkAt: new Date(),
                },
                openAuthWindow: null,
            };
        case OAUTH_WEB_WINDOW_OPENED:
            return {
                ...state,
                timings: {
                    ...state.timings,
                    openedWebAuthWindowAt: new Date(),
                },
                openAuthWindow: action.value,
            };
        case OAUTH_WEB_WINDOW_CLOSED:
            if (!state.openAuthWindow) return state;
            return {
                ...state,
                timings: {
                    ...state.timings,
                    closedWebAuthWindowAt: new Date(),
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
