import React from 'react';
import getPkce from 'oauth-pkce';
import { Dispatch } from '../utils/action';

import './oauth_callback.html';
import {
    AUTH_FAILED,
    OAUTH_WINDOW_CLOSED,
    OAUTH_WINDOW_OPENED,
    GENERATED_PKCE_CHALLENGE,
    RECEIVED_CORE_AUTH_CODE,
    RECEIVED_CORE_AUTH_TOKEN,
    RECEIVED_DATA_CLOUD_ACCESS_TOKEN,
    AUTH_FLOW_DISPATCH_CTX,
    AUTH_FLOW_STATE_CTX,
    reduceAuthState,
} from './salesforce_auth_state';
import { useSalesforceConnector } from './salesforce_connector';

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

interface Props {
    /// The children
    children: React.ReactElement;
}

export const SalesforceAuthFlow: React.FC<Props> = (props: Props) => {
    const [state, dispatch] = React.useReducer(reduceAuthState, null, () => ({
        authParams: null,
        authError: null,
        authRequested: false,
        authStarted: false,
        pendingAuthPopup: null,
        pkceChallengeValue: null,
        pkceChallengeVerifier: null,
        openAuthWindow: null,
        coreAuthCode: null,
        coreAccessToken: null,
        dataCloudInstanceUrl: null,
        dataCloudAccessToken: null,
    }));
    const api = useSalesforceConnector();

    // Effect to generate PKCE challenge
    React.useEffect(() => {
        if (state.pkceChallengeValue) return;
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
    }, [state.authParams, state.pkceChallengeValue]);

    // Effect to open the auth window when there is a pending auth
    React.useEffect(() => {
        if (!state.authRequested || state.authStarted || state.authError || !state.pkceChallengeValue) return;

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
        dispatch({ type: OAUTH_WINDOW_OPENED, value: popup });
    }, [state.authRequested, state.authError, state.openAuthWindow, state.pkceChallengeValue]);

    // Effect to forget about the auth window when it closes
    React.useEffect(() => {
        if (!state.openAuthWindow) return () => {};
        const loop = setInterval(function () {
            if (state.openAuthWindow?.closed) {
                clearInterval(loop);
                dispatch({
                    type: OAUTH_WINDOW_CLOSED,
                    value: null,
                });
            }
        }, 1000);
        return () => {
            clearInterval(loop);
        };
    }, [state.openAuthWindow]);

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
                type: RECEIVED_CORE_AUTH_CODE,
                value: code,
            });
        };
        window.addEventListener('message', handler);
        return () => {
            window.removeEventListener('message', handler);
        };
    }, [dispatch]);

    // Effect to get the core access token
    React.useEffect(() => {
        if (!state.coreAuthCode || !state.authParams || !state.pkceChallengeVerifier || state.authError) return;
        const abortController = new AbortController();
        const authParams = state.authParams;
        const authCode = state.coreAuthCode;
        const pkceChallengeVerifier = state.pkceChallengeVerifier;
        (async () => {
            try {
                const token = await api.getCoreAccessToken(
                    authParams,
                    authCode,
                    pkceChallengeVerifier,
                    abortController.signal,
                );
                console.log(token);
                dispatch({
                    type: RECEIVED_CORE_AUTH_TOKEN,
                    value: token,
                });
            } catch (error: any) {
                if (error.name === 'AbortError') {
                    return;
                } else if (error instanceof Error) {
                    dispatch({
                        type: AUTH_FAILED,
                        value: error.message,
                    });
                }
            }
        })();
        return () => abortController.abort();
    }, [state.coreAuthCode, state.pkceChallengeVerifier]);

    // Effect to get the data cloud access token
    React.useEffect(() => {
        if (!state.coreAccessToken?.accessToken || !state.authParams || state.authError) return;
        const abortController = new AbortController();
        const coreAccessToken = state.coreAccessToken;
        (async () => {
            try {
                const token = await api.getDataCloudAccessToken(coreAccessToken, abortController.signal);
                console.log(token);
                dispatch({
                    type: RECEIVED_DATA_CLOUD_ACCESS_TOKEN,
                    value: token,
                });
            } catch (error: any) {
                if (error.name === 'AbortError') {
                    return;
                } else if (error instanceof Error) {
                    dispatch({
                        type: AUTH_FAILED,
                        value: error.message,
                    });
                }
            }
        })();
        return () => abortController.abort();
    }, [state.coreAccessToken]);

    return (
        <AUTH_FLOW_DISPATCH_CTX.Provider value={dispatch}>
            <AUTH_FLOW_STATE_CTX.Provider value={state}>{props.children}</AUTH_FLOW_STATE_CTX.Provider>
        </AUTH_FLOW_DISPATCH_CTX.Provider>
    );
};
