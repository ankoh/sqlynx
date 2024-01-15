import React from 'react';
import { VariantKind, Dispatch } from '../utils/variant';
import { SalesforceCoreAccessToken, SalesforceDataCloudAccessToken } from './salesforce_api_client';
import { PKCEChallenge } from '../utils/pkce';

export interface SalesforceAuthState {
    /// The auth params
    authParams: SalesforceAuthParams | null;
    /// The auth is requested?
    authRequested: boolean;
    /// The auth has been started?
    authStarted: boolean;
    /// The authentication error
    authError: string | null;
    /// The PKCE challenge
    pkceChallenge: PKCEChallenge | null;
    /// The popup window
    openAuthWindow: Window | null;
    /// The code
    coreAuthCode: string | null;
    /// The github access token
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
    authParams: null,
    authError: null,
    authRequested: false,
    authStarted: false,
    pkceChallenge: null,
    openAuthWindow: null,
    coreAuthCode: null,
    coreAccessToken: null,
    dataCloudAccessToken: null,
};

export const CONFIGURE = Symbol('CONFIGURE');
export const CONNECT = Symbol('CONNECT');
export const DISCONNECT = Symbol('DISCONNECT');
export const AUTH_FAILED = Symbol('AUTH_FAILED');
export const GENERATED_PKCE_CHALLENGE = Symbol('GENERATED_PKCE_CHALLENGE');
export const OAUTH_WINDOW_CLOSED = Symbol('OAUTH_WINDOW_CLOSED');
export const OAUTH_WINDOW_OPENED = Symbol('OAUTH_WINDOW_OPENED');
export const RECEIVED_CORE_AUTH_CODE = Symbol('RECEIVED_AUTH_CODE');
export const RECEIVED_CORE_AUTH_TOKEN = Symbol('RECEIVED_CORE_ACCESS_TOKEN');
export const RECEIVED_DATA_CLOUD_ACCESS_TOKEN = Symbol('RECEIVED_DATA_CLOUD_ACCESS_TOKEN');

export type SalesforceAuthAction =
    | VariantKind<typeof CONFIGURE, SalesforceAuthParams>
    | VariantKind<typeof CONNECT, SalesforceAuthParams>
    | VariantKind<typeof DISCONNECT, null>
    | VariantKind<typeof OAUTH_WINDOW_OPENED, Window>
    | VariantKind<typeof OAUTH_WINDOW_CLOSED, null>
    | VariantKind<typeof AUTH_FAILED, string>
    | VariantKind<typeof GENERATED_PKCE_CHALLENGE, PKCEChallenge>
    | VariantKind<typeof RECEIVED_CORE_AUTH_CODE, string>
    | VariantKind<typeof RECEIVED_CORE_AUTH_TOKEN, SalesforceCoreAccessToken>
    | VariantKind<typeof RECEIVED_DATA_CLOUD_ACCESS_TOKEN, SalesforceDataCloudAccessToken>;

export function reduceAuthState(state: SalesforceAuthState, action: SalesforceAuthAction): SalesforceAuthState {
    switch (action.type) {
        case CONFIGURE:
            return {
                authParams: action.value,
                authError: null,
                authRequested: false,
                authStarted: false,
                pkceChallenge: null,
                openAuthWindow: null,
                coreAuthCode: null,
                coreAccessToken: null,
                dataCloudAccessToken: null,
            };
        case CONNECT:
            return {
                authParams: action.value,
                authError: null,
                authRequested: true,
                authStarted: false,
                pkceChallenge: null,
                openAuthWindow: null,
                coreAuthCode: null,
                coreAccessToken: null,
                dataCloudAccessToken: null,
            };
        case GENERATED_PKCE_CHALLENGE:
            return {
                ...state,
                pkceChallenge: action.value,
            };
        case OAUTH_WINDOW_OPENED:
            return {
                ...state,
                authStarted: true,
                openAuthWindow: action.value,
            };
        case OAUTH_WINDOW_CLOSED:
            if (!state.openAuthWindow) return state;
            return {
                ...state,
                authStarted: true,
                openAuthWindow: null,
            };
        case AUTH_FAILED:
            return {
                ...state,
                authStarted: true,
                authError: action.value,
            };
        case RECEIVED_CORE_AUTH_CODE:
            return {
                ...state,
                authStarted: true,
                coreAuthCode: action.value,
            };
        case RECEIVED_CORE_AUTH_TOKEN:
            return {
                ...state,
                coreAccessToken: action.value,
            };
        case RECEIVED_DATA_CLOUD_ACCESS_TOKEN:
            return {
                ...state,
                dataCloudAccessToken: action.value,
            };
        case DISCONNECT:
            return {
                authParams: state.authParams,
                authRequested: false,
                authStarted: false,
                authError: null,
                pkceChallenge: null,
                openAuthWindow: null,
                coreAuthCode: null,
                coreAccessToken: null,
                dataCloudAccessToken: null,
            };
    }
}

export const AUTH_FLOW_STATE_CTX = React.createContext<SalesforceAuthState | null>(null);
export const AUTH_FLOW_DISPATCH_CTX = React.createContext<Dispatch<SalesforceAuthAction> | null>(null);

export const useSalesforceAuthState = (): SalesforceAuthState => React.useContext(AUTH_FLOW_STATE_CTX)!;
export const useSalesforceAuthFlow = (): Dispatch<SalesforceAuthAction> => React.useContext(AUTH_FLOW_DISPATCH_CTX)!;
