import React from 'react';
import { Dispatch } from '../utils/action';
import { sleep } from '../utils/sleep';
import { SalesforceCoreAccessToken, SalesforceDataCloudAccessToken } from './salesforce_api_client';

import {
    RECEIVED_CORE_AUTH_CODE,
    RECEIVED_CORE_AUTH_TOKEN,
    RECEIVED_DATA_CLOUD_ACCESS_TOKEN,
    AUTH_FLOW_DISPATCH_CTX,
    AUTH_FLOW_STATE_CTX,
    SalesforceAuthAction,
    SalesforceAuthState,
    reduceAuthState,
    GENERATED_PKCE_CHALLENGE,
} from './salesforce_auth_state';

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

    const coreAccessToken: SalesforceCoreAccessToken = {
        accessToken: '',
        apiInstanceUrl: '',
        id: '',
        idToken: '',
        instanceUrl: '',
        issuedAt: '',
        refreshToken: '',
        scope: '',
        signature: '',
        tokenType: '',
    };
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + 7200);
    const dataCloudAccessToken: SalesforceDataCloudAccessToken = {
        accessToken: '',
        expiresAt: expiresAt,
        instanceUrl: new URL('https://localhost'),
        issuedTokenType: '',
        tokenType: '',
    };

    // Effect to get the core access token
    React.useEffect(() => {
        if (state.authRequested) return;
        (async () => {
            sleep(200);
            dispatch({
                type: GENERATED_PKCE_CHALLENGE,
                value: ['foo', 'bar'],
            });
            sleep(200);
            dispatch({
                type: RECEIVED_CORE_AUTH_CODE,
                value: '',
            });
            sleep(200);
            dispatch({
                type: RECEIVED_CORE_AUTH_TOKEN,
                value: coreAccessToken,
            });
            sleep(200);
            dispatch({
                type: RECEIVED_DATA_CLOUD_ACCESS_TOKEN,
                value: dataCloudAccessToken,
            });
        })();
    }, [state.coreAuthCode]);

    return (
        <AUTH_FLOW_DISPATCH_CTX.Provider value={dispatch}>
            <AUTH_FLOW_STATE_CTX.Provider value={state}>{props.children}</AUTH_FLOW_STATE_CTX.Provider>
        </AUTH_FLOW_DISPATCH_CTX.Provider>
    );
};

export const useSalesforceAuthState = (): SalesforceAuthState => React.useContext(AUTH_FLOW_STATE_CTX)!;
export const useSalesforceAuthFlow = (): Dispatch<SalesforceAuthAction> => React.useContext(AUTH_FLOW_DISPATCH_CTX)!;
