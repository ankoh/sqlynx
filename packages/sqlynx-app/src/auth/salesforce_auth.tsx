// Copyright (c) 2020 The DashQL Authors

import React from 'react';
import './oauth_callback.html';
import * as utils from '../utils';
import getPkce from 'oauth-pkce';

// Docs: https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm&type=5

const OAUTH_POPUP_NAME = 'SQLynx OAuth';
const OAUTH_POPUP_SETTINGS = 'toolbar=no, menubar=no, width=600, height=700, top=100, left=100';

type Props = {
    /// The children
    children: React.ReactElement;
};

type AccessToken = {
    /// The token
    token: string | null;
    /// The token type
    tokenType: string | null;
    /// The scope
    scope: string | null;
};

type State = {
    /// The popup window URL
    pendingAuth: string | null;
    /// The PKCE challenge
    pkceChallengeValue: string | null;
    /// The PKCE challenge
    pkceChallengeVerifier: string | null;
    /// The popup window
    openAuthWindow: Window | null;
    /// The authentication error
    authError: string | null;
    /// The code
    authCode: string | null;
    /// The github access token
    accessToken: AccessToken | null;
};

type AuthParams = {
    /// The oauth redirect
    oauthRedirect: URL;
    /// The base URL
    instanceUrl: URL;
    /// The client id
    clientId: string;
    /// The client secret
    clientSecret: string;
};

export interface SalesforceAccountAuth {
    /// Login into an account
    login: (config: AuthParams) => void;
    /// Logout of an account
    logout: () => void;
}

export interface SalesforceAPIClient {
    /// Is authenticated?
    isAuthenticated: boolean;
}

const accountAuthCtx = React.createContext<SalesforceAccountAuth | null>(null);
const apiClientCtx = React.createContext<SalesforceAPIClient | null>(null);

export const SalesforceAuthProvider: React.FC<Props> = (props: Props) => {
    const [state, setState] = React.useState<State>({
        pendingAuth: null,
        pkceChallengeValue: null,
        pkceChallengeVerifier: null,
        openAuthWindow: null,
        authCode: null,
        authError: null,
        accessToken: null,
    });

    // Maintain mount flag
    const isMountedRef = React.useRef<boolean>(true);
    React.useEffect(() => {
        isMountedRef.current = true;
        return () => void (isMountedRef.current = false);
    }, []);

    // Register a receive for the oauth code from the window
    React.useEffect(() => {
        const handler = (event: any) => {
            const params = new URLSearchParams(event?.data);
            const code = params.get('code');
            if (!code) return;
            if (!isMountedRef.current) return;
            setState(s => {
                console.log(`oauth code=${code}`);
                return {
                    ...s,
                    authCode: code,
                };
            });
        };
        window.addEventListener('message', handler);
        return () => {
            window.removeEventListener('message', handler);
        };
    }, [setState]);

    // Effect to forget about the auth window when it closes
    React.useEffect(() => {
        if (!state.openAuthWindow) return () => {};
        const loop = setInterval(function () {
            if (state.openAuthWindow?.closed) {
                clearInterval(loop);
                setState(s => {
                    if (!s.openAuthWindow) return s;
                    return {
                        ...s,
                        pendingAuth: null,
                        openAuthWindow: null,
                    };
                });
            }
        }, 1000);
        return () => {
            clearInterval(loop);
        };
    }, [state.openAuthWindow]);

    // Effect to open the auth window when there is a pending auth
    React.useEffect(() => {
        // Already done?
        if (!state.pendingAuth || state.openAuthWindow) return;
        // Open popup window
        const popup = window.open(state.pendingAuth, OAUTH_POPUP_NAME, OAUTH_POPUP_SETTINGS);
        if (!popup) {
            // Something went wrong, Browser might prevent the popup.
            // (E.g. FF blocks by default)
            setState(s => ({
                ...s,
                pendingAuth: null,
                openAuthWindow: null,
                error: 'could not open oauth window',
            }));
            return;
        }
        popup.focus();
        setState(s => ({
            ...s,
            openAuthWindow: popup,
        }));
    }, [state.pendingAuth, state.openAuthWindow]);

    // Login function initiated the OAuth login
    const login = React.useCallback(
        async (params: AuthParams) => {
            if (!isMountedRef.current) return;

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

            // Construct the URI
            const p = [
                `client_id=${params.clientId}`,
                `redirect_uri=${params.oauthRedirect}`,
                `code_challenge=${pkceChallenge.codeChallenge}`,
                `code_challange_method=S256`,
                `response_type=code`,
            ].join('&');
            const url = `${params.instanceUrl}/services/oauth2/authorize?${p}`;

            // Set the pending popup URL
            setState(s => {
                if (s.pendingAuth || s.openAuthWindow) return s;
                return {
                    pendingAuth: url,
                    openAuthWindow: null,
                    pkceChallengeValue: pkceChallenge.codeChallenge,
                    pkceChallengeVerifier: pkceChallenge.codeVerifier,
                    authError: null,
                    authCode: null,
                    accessToken: null,
                };
            });
        },
        [setState],
    );

    // Logout function that clears any pending login
    const logout = React.useCallback(() => {
        if (!isMountedRef.current) return;
        setState(s => {
            if (s.openAuthWindow) s.openAuthWindow.close();
            return {
                pendingAuth: null,
                pkceChallengeValue: null,
                pkceChallengeVerifier: null,
                openAuthWindow: null,
                authError: null,
                authCode: null,
                accessToken: null,
            };
        });
    }, [setState]);

    // Build the account login methods
    const auth = React.useMemo(
        (): SalesforceAccountAuth => ({
            login,
            logout,
        }),
        [login, logout],
    );

    // Build the graphql client
    const apiClient = React.useMemo<SalesforceAPIClient>(() => {
        if (state.accessToken) {
            return {
                isAuthenticated: true,
            };
        } else {
            return {
                isAuthenticated: false,
            };
        }
    }, [state.accessToken]);

    return (
        <accountAuthCtx.Provider value={auth}>
            <apiClientCtx.Provider value={apiClient}>{props.children}</apiClientCtx.Provider>
        </accountAuthCtx.Provider>
    );
};

export const useSalesforceAuth = (): SalesforceAccountAuth => React.useContext(accountAuthCtx)!;
export const useSalesforceAPI = (): SalesforceAPIClient => React.useContext(apiClientCtx)!;
