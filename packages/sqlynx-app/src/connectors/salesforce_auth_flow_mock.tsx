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
    reduceAuthState,
    GENERATED_PKCE_CHALLENGE,
} from './salesforce_auth_state';
import { useSalesforceConnector } from './salesforce_connector';

interface Props {
    children: React.ReactElement;
}

export const SalesforceAuthFlowMock: React.FC<Props> = (props: Props) => {
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

    const authParams = {
        oauthRedirect: new URL('http://localhost'),
        instanceUrl: new URL('http://localhost'),
        clientId: 'core-client-id',
        clientSecret: null,
    };
    const pkceChallenge = 'pkce-challenge';
    const pkceChallengeVerfifier = 'pkce-challenge-verifier';

    // Effect to get the core access token
    React.useEffect(() => {
        if (!state.authRequested) return;
        const abort = new AbortController();
        (async () => {
            dispatch({
                type: GENERATED_PKCE_CHALLENGE,
                value: [pkceChallenge, pkceChallengeVerfifier],
            });
            await sleep(200);
            dispatch({
                type: RECEIVED_CORE_AUTH_CODE,
                value: 'core-access-auth-code',
            });
            const coreAccess = await api.getCoreAccessToken(
                authParams,
                'core-access-code',
                pkceChallengeVerfifier,
                abort.signal,
            );
            dispatch({
                type: RECEIVED_CORE_AUTH_TOKEN,
                value: coreAccess,
            });
            const dataCloudAccess = await api.getDataCloudAccessToken(coreAccess, abort.signal);
            dispatch({
                type: RECEIVED_DATA_CLOUD_ACCESS_TOKEN,
                value: dataCloudAccess,
            });
        })();
    }, [state.authRequested, state.coreAuthCode]);

    return (
        <AUTH_FLOW_DISPATCH_CTX.Provider value={dispatch}>
            <AUTH_FLOW_STATE_CTX.Provider value={state}>{props.children}</AUTH_FLOW_STATE_CTX.Provider>
        </AUTH_FLOW_DISPATCH_CTX.Provider>
    );
};
