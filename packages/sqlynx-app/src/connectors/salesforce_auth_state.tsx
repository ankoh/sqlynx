import React from 'react';
import { Action, Dispatch } from '../utils/action';
import { SalesforceCoreAccessToken, SalesforceDataCloudAccessToken } from './salesforce_api_client';

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
    pkceChallengeValue: string | null;
    /// The PKCE challenge
    pkceChallengeVerifier: string | null;
    /// The popup window
    openAuthWindow: Window | null;
    /// The code
    coreAuthCode: string | null;
    /// The github access token
    coreAccessToken: SalesforceCoreAccessToken | null;
    /// The data cloud access token
    dataCloudAccessToken: SalesforceDataCloudAccessToken | null;
}

export interface SalesforceAuthParams {
    /// The oauth redirect
    oauthRedirect: URL;
    /// The base URL
    instanceUrl: URL;
    /// The client id
    clientId: string;
    /// The client secret.
    /// This is meant for client secrets that the users enters ad-hoc.
    clientSecret: string | null;
}

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
    | Action<typeof CONNECT, SalesforceAuthParams>
    | Action<typeof DISCONNECT, null>
    | Action<typeof OAUTH_WINDOW_OPENED, Window>
    | Action<typeof OAUTH_WINDOW_CLOSED, null>
    | Action<typeof AUTH_FAILED, string>
    | Action<typeof GENERATED_PKCE_CHALLENGE, [string, string]>
    | Action<typeof RECEIVED_CORE_AUTH_CODE, string>
    | Action<typeof RECEIVED_CORE_AUTH_TOKEN, SalesforceCoreAccessToken>
    | Action<typeof RECEIVED_DATA_CLOUD_ACCESS_TOKEN, SalesforceDataCloudAccessToken>;

export function reduceAuthState(state: SalesforceAuthState, action: SalesforceAuthAction): SalesforceAuthState {
    switch (action.type) {
        case CONNECT:
            return {
                authParams: action.value,
                authError: null,
                authRequested: true,
                authStarted: false,
                pkceChallengeValue: null,
                pkceChallengeVerifier: null,
                openAuthWindow: null,
                coreAuthCode: null,
                coreAccessToken: null,
                dataCloudAccessToken: null,
            };
        case GENERATED_PKCE_CHALLENGE:
            return {
                ...state,
                pkceChallengeValue: action.value[0],
                pkceChallengeVerifier: action.value[1],
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
                pkceChallengeValue: null,
                pkceChallengeVerifier: null,
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
