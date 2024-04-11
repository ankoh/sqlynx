import * as React from 'react';

import * as proto from '@ankoh/sqlynx-pb';

import {
    AUTH_FAILED,
    OAUTH_WINDOW_CLOSED,
    OAUTH_WINDOW_OPENED,
    GENERATED_PKCE_CHALLENGE,
    RECEIVED_CORE_AUTH_CODE,
    RECEIVED_CORE_AUTH_TOKEN,
    RECEIVED_DATA_CLOUD_ACCESS_TOKEN,
    AUTH_FLOW_DISPATCH_CTX,
    AUTH_FLOW_DEFAULT_STATE,
    reduceAuthState,
    OAUTH_LINK_OPENED,
    SalesforceAuthAction,
    REQUESTING_CORE_AUTH_TOKEN,
    REQUESTING_DATA_CLOUD_ACCESS_TOKEN,
    GENERATING_PKCE_CHALLENGE,
    CONNECTION_ID,
} from './salesforce_auth_state.js';
import { useSalesforceAPI } from './salesforce_connector.js';
import { useAppConfig } from '../app_config.js';
import { generatePKCEChallenge } from '../utils/pkce.js';
import { BASE64_CODEC } from '../utils/base64.js';
import { PlatformType, usePlatformType } from '../platform/platform_type.js';
import { createConnectionId, useOrCreateConnectionState } from './connection_manager.js';
import { SALESFORCE_DATA_CLOUD } from './connector_info.js';
import { SalesforceConnectorState, createEmptyTimings } from './connection_state.js';

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
    const appConfig = useAppConfig();
    const connector = useSalesforceAPI();
    const platformType = usePlatformType();
    const connectorConfig = appConfig.value?.connectors?.salesforce ?? null;

    // Pre-allocate a connection id for all Salesforce connections
    // This might change in the future when we start maintaining multiple connections per connector.
    // In that case, someone else would create the connection id, and we would need an "active" connection id provider
    // similar to how we register the active session.
    const connectionId = React.useMemo(() => createConnectionId(), []);
    const [connection, setConnection] = useOrCreateConnectionState<SalesforceConnectorState>(connectionId, () => ({
        type: SALESFORCE_DATA_CLOUD,
        value: {
            timings: createEmptyTimings(),
            auth: AUTH_FLOW_DEFAULT_STATE
        }
    }));
    const dispatch = React.useCallback((action: SalesforceAuthAction) => {
        setConnection((s) => ({
            ...s,
            auth: reduceAuthState(connection.auth, action)
        }));
    }, []);


    // Effect to generate PKCE challenge, regenerate whenever auth params change
    React.useEffect(() => {
        if (connection.auth.pkceChallenge) return;
        const cancellation = { triggered: false };
        (async () => {
            dispatch({
                type: GENERATING_PKCE_CHALLENGE,
                value: null,
            });

            // Generate PKCE challenge
            const pkceChallenge = await generatePKCEChallenge();
            if (cancellation.triggered) return;

            // Set the pending popup URL
            dispatch({
                type: GENERATED_PKCE_CHALLENGE,
                value: pkceChallenge,
            });
        })();

        return () => {
            cancellation.triggered = true;
        };
    }, [connection.auth.authParams, connection.auth.pkceChallenge]);

    // Effect to open the auth window when there is a pending auth
    React.useEffect(() => {
        if (
            !connectorConfig ||
            !connection.auth.authParams ||
            !connection.auth.authParams.instanceUrl ||
            !connection.auth.timings.authRequestedAt ||
            connection.auth.authStarted ||
            connection.auth.authError ||
            !connection.auth.pkceChallenge
        ) {
            return;
        }

        // Select the oauth flow variant.
        // This will instruct the redirect to sqlynx.app/oauth.html about the "actual" target.
        // When initiating the OAuth flow from the native app, the redirect will then open a deep link with the OAuth code.
        // When initiating from the web, the redirect will assume there's an opener that it can post the code to.
        const flowVariant = platformType !== PlatformType.WEB
            ? proto.sqlynx_oauth.pb.OAuthFlowVariant.NATIVE_LINK_FLOW
            : proto.sqlynx_oauth.pb.OAuthFlowVariant.WEB_OPENER_FLOW;

        // Construct the auth state
        const authState = new proto.sqlynx_oauth.pb.OAuthState({
            flowVariant: flowVariant,
            providerOptions: {
                case: "salesforceProvider",
                value: new proto.sqlynx_oauth.pb.SalesforceOAuthOptions({
                    instanceUrl: connection.auth.authParams.instanceUrl,
                    appConsumerKey: connection.auth.authParams.appConsumerKey,
                }),
            }
        });
        const authStateBuffer = authState.toBinary();
        const authStateBase64 = BASE64_CODEC.encode(authStateBuffer.buffer);

        // Construct the URI
        const params = connection.auth.authParams!;
        const paramParts = [
            `client_id=${params.appConsumerKey}`,
            `redirect_uri=${connectorConfig.auth.oauthRedirect}`,
            `code_challenge=${connection.auth.pkceChallenge.value}`,
            `code_challange_method=S256`,
            `response_type=code`,
            `state=${authStateBase64}`
        ].join('&');
        const url = `${params.instanceUrl}/services/oauth2/authorize?${paramParts}`;

        if (flowVariant == proto.sqlynx_oauth.pb.OAuthFlowVariant.WEB_OPENER_FLOW) {
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
        } else {
            // Just open the link with the default browser
            window.open(url);
            dispatch({ type: OAUTH_LINK_OPENED, value: null });
        }

    }, [connection.auth.authStarted, connection.auth.authError, connection.auth.openAuthWindow, connection.auth.pkceChallenge]);

    // Effect to forget about the auth window when it closes
    React.useEffect(() => {
        if (!connection.auth.openAuthWindow) return () => { };
        const loop = setInterval(function () {
            if (connection.auth.openAuthWindow?.closed) {
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
    }, [connection.auth.openAuthWindow]);

    // Register a receiver for the oauth code from the window
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
        if (!connectorConfig || !connection.auth.coreAuthCode || !connection.auth.authParams || !connection.auth.pkceChallenge || connection.auth.authError)
            return;
        const abortController = new AbortController();
        const authParams = connection.auth.authParams;
        const authCode = connection.auth.coreAuthCode;
        const pkceChallenge = connection.auth.pkceChallenge;
        (async () => {
            try {
                dispatch({
                    type: REQUESTING_CORE_AUTH_TOKEN,
                    value: null,
                });
                const token = await connector.getCoreAccessToken(
                    connectorConfig.auth,
                    authParams,
                    authCode,
                    pkceChallenge.verifier,
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
    }, [connectorConfig, connection.auth.coreAuthCode, connection.auth.authParams, connection.auth.pkceChallenge, connection.auth.authError]);

    // Effect to get the data cloud access token
    React.useEffect(() => {
        if (!connection.auth.coreAccessToken?.accessToken || !connection.auth.authParams || connection.auth.authError) return;
        const abortController = new AbortController();
        const coreAccessToken = connection.auth.coreAccessToken;
        (async () => {
            try {
                dispatch({
                    type: REQUESTING_DATA_CLOUD_ACCESS_TOKEN,
                    value: null,
                });
                const token = await connector.getDataCloudAccessToken(coreAccessToken, abortController.signal);
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
    }, [connection?.auth.coreAccessToken]);

    return (
        <AUTH_FLOW_DISPATCH_CTX.Provider value={dispatch}>
            <CONNECTION_ID.Provider value={connectionId}>{props.children}</CONNECTION_ID.Provider>
        </AUTH_FLOW_DISPATCH_CTX.Provider>
    );
};
