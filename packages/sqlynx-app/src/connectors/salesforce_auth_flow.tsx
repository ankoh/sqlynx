// Copyright (c) 2020 The DashQL Authors

import React from 'react';
import getPkce from 'oauth-pkce';
import { Action, Dispatch } from '../utils/action';
import { SalesforceAccessToken, readAccessToken } from './salesforce_api_client';

import './oauth_callback.html';

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
// What you'll likely need as well:
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

export interface SalesforceAuthState {
    /// The auth params
    authParams: SalesforceAuthParams | null;
    /// The authentication error
    authError: string | null;
    /// The pending auth
    pendingAuth: boolean;
    /// The PKCE challenge
    pkceChallengeValue: string | null;
    /// The PKCE challenge
    pkceChallengeVerifier: string | null;
    /// The popup window
    openAuthWindow: Window | null;
    /// The code
    coreAuthCode: string | null;
    /// The github access token
    coreAccessToken: SalesforceAccessToken | null;
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
const GENERATED_PKCE_CHALLENGE = Symbol('GENERATED_PKCE_CHALLENGE');
const AUTH_WINDOW_CLOSED = Symbol('AUTH_WINDOW_CLOSED');
const AUTH_WINDOW_OPENED = Symbol('AUTH_WINDOW_OPENED');
const AUTH_FAILED = Symbol('AUTH_FAILED');
const RECEIVED_AUTH_CODE = Symbol('RECEIVED_AUTH_CODE');
const RECEIVED_CORE_ACCESS_TOKEN = Symbol('RECEIVED_CORE_ACCESS_TOKEN');

export type SalesforceAuthAction =
    | Action<typeof CONNECT, SalesforceAuthParams>
    | Action<typeof DISCONNECT, null>
    | Action<typeof AUTH_WINDOW_OPENED, Window>
    | Action<typeof AUTH_WINDOW_CLOSED, null>
    | Action<typeof AUTH_FAILED, string>
    | Action<typeof GENERATED_PKCE_CHALLENGE, [string, string]>
    | Action<typeof RECEIVED_AUTH_CODE, string>
    | Action<typeof RECEIVED_CORE_ACCESS_TOKEN, SalesforceAccessToken>;

function reduceAuthState(state: SalesforceAuthState, action: SalesforceAuthAction): SalesforceAuthState {
    switch (action.type) {
        case CONNECT:
            return {
                authParams: action.value,
                authError: null,
                pendingAuth: true,
                pkceChallengeValue: null,
                pkceChallengeVerifier: null,
                openAuthWindow: null,
                coreAuthCode: null,
                coreAccessToken: null,
            };
        case GENERATED_PKCE_CHALLENGE:
            return {
                ...state,
                pkceChallengeValue: action.value[0],
                pkceChallengeVerifier: action.value[1],
            };
        case AUTH_WINDOW_OPENED:
            return {
                ...state,
                pendingAuth: false,
                openAuthWindow: action.value,
            };
        case AUTH_WINDOW_CLOSED:
            if (!state.openAuthWindow) return state;
            return {
                ...state,
                pendingAuth: false,
                openAuthWindow: null,
            };
        case AUTH_FAILED:
            return {
                ...state,
                authError: action.value,
            };
        case RECEIVED_AUTH_CODE:
            return {
                ...state,
                coreAuthCode: action.value,
            };
        case RECEIVED_CORE_ACCESS_TOKEN:
            return {
                ...state,
                coreAccessToken: action.value,
            };
        case DISCONNECT:
            return {
                authParams: state.authParams,
                authError: null,
                pendingAuth: false,
                pkceChallengeValue: null,
                pkceChallengeVerifier: null,
                openAuthWindow: null,
                coreAuthCode: null,
                coreAccessToken: null,
            };
    }
}

const AUTH_STATE = React.createContext<SalesforceAuthState | null>(null);
const AUTH_DISPATCH = React.createContext<Dispatch<SalesforceAuthAction> | null>(null);

interface Props {
    /// The children
    children: React.ReactElement;
}

export const SalesforceAuthFlow: React.FC<Props> = (props: Props) => {
    const [state, dispatch] = React.useReducer(reduceAuthState, null, () => ({
        authParams: null,
        authError: null,
        pendingAuth: false,
        pendingAuthPopup: null,
        pkceChallengeValue: null,
        pkceChallengeVerifier: null,
        openAuthWindow: null,
        coreAuthCode: null,
        coreAccessToken: null,
    }));

    // Register a receive for the oauth code from the window
    React.useEffect(() => {
        const handler = (event: any) => {
            const params = new URLSearchParams(event?.data);
            if (params.has('error')) {
                console.error(params.toString());
                return;
            }
            const code = params.get('code');
            if (!code) return;
            dispatch({
                type: RECEIVED_AUTH_CODE,
                value: code,
            });
        };
        window.addEventListener('message', handler);
        return () => {
            window.removeEventListener('message', handler);
        };
    }, [dispatch]);

    // Effect to forget about the auth window when it closes
    React.useEffect(() => {
        if (!state.openAuthWindow) return () => {};
        const loop = setInterval(function () {
            if (state.openAuthWindow?.closed) {
                clearInterval(loop);
                dispatch({
                    type: AUTH_WINDOW_CLOSED,
                    value: null,
                });
            }
        }, 1000);
        return () => {
            clearInterval(loop);
        };
    }, [state.openAuthWindow]);

    // Effect to generate PKCE challenge
    React.useEffect(() => {
        if (!state.pkceChallengeValue) return;
        const cancellation = { triggered: false };
        (async () => {
            // Generate PKCE challenge
            const pkceChallenge = await new Promise<{ codeVerifier: string; codeChallenge: string }>(
                (resolve, reject) => {
                    getPkce(42, (error, { verifier, challenge }) => {
                        if (error != null) {
                            reject(error);
                        } else {
                            resolve({ codeVerifier: verifier, codeChallenge: challenge });
                        }
                    });
                },
            );
            if (cancellation.triggered) return;

            // Set the pending popup URL
            dispatch({
                type: GENERATED_PKCE_CHALLENGE,
                value: [pkceChallenge.codeChallenge, pkceChallenge.codeVerifier],
            });
        })();

        return () => {
            cancellation.triggered = true;
        };
    }, [state.pkceChallengeValue]);

    // Effect to open the auth window when there is a pending auth
    React.useEffect(() => {
        if (!state.pendingAuth || state.authError || state.openAuthWindow || !state.pkceChallengeValue) return;

        // Construct the URI
        const params = state.authParams!;
        const paramParts = [
            `client_id=${params.clientId}`,
            `redirect_uri=${params.oauthRedirect}`,
            `code_challenge=${state.pkceChallengeValue}`,
            `code_challange_method=S256`,
            `response_type=code`,
        ].join('&');
        const url = `${params.instanceUrl}/services/oauth2/authorize?${paramParts}`;

        // Open popup window
        const popup = window.open(url, OAUTH_POPUP_NAME, OAUTH_POPUP_SETTINGS);
        if (!popup) {
            // Something went wrong, Browser might prevent the popup.
            // (E.g. FF blocks by default)
            dispatch({ type: AUTH_FAILED, value: 'could not open oauth window' });
            return;
        }
        popup.focus();
        dispatch({ type: AUTH_WINDOW_OPENED, value: popup });
    }, [state.pendingAuth, state.authError, state.openAuthWindow, state.pkceChallengeValue]);

    // Effect to get the core access token
    React.useEffect(() => {
        if (!state.coreAuthCode || !state.authParams) return;
        const abortController = new AbortController();
        (async () => {
            try {
                const searchParams: Record<string, string> = {
                    grant_type: 'authorization_code',
                    code: state.coreAuthCode!,
                    redirect_uri: state.authParams!.oauthRedirect.toString(),
                    client_id: state.authParams!.clientId,
                    code_verifier: state.pkceChallengeVerifier!,
                    format: 'json',
                };
                if (state.authParams!.clientSecret !== null) {
                    searchParams.client_secret = state.authParams!.clientSecret;
                }
                // Get the access token
                const response = await fetch(`${state.authParams!.instanceUrl.toString()}services/oauth2/token`, {
                    method: 'POST',
                    headers: new Headers({
                        Accept: 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded',
                    }),
                    body: new URLSearchParams(searchParams),
                    signal: abortController.signal,
                });
                const responseBody = await response.json();
                const accessToken = readAccessToken(responseBody);
                console.log(accessToken);

                // No longer mounted?
                dispatch({
                    type: RECEIVED_CORE_ACCESS_TOKEN,
                    value: accessToken,
                });
            } catch (error: any) {
                if (error.name === 'AbortError') {
                    return;
                } else {
                    throw error;
                }
            }
        })();
        return () => abortController.abort();
    }, [state.coreAuthCode]);

    return (
        <AUTH_DISPATCH.Provider value={dispatch}>
            <AUTH_STATE.Provider value={state}>{props.children}</AUTH_STATE.Provider>
        </AUTH_DISPATCH.Provider>
    );
};

export const useSalesforceAuthState = (): SalesforceAuthState => React.useContext(AUTH_STATE)!;
export const useSalesforceAuthFlow = (): Dispatch<SalesforceAuthAction> => React.useContext(AUTH_DISPATCH)!;
