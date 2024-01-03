import React from 'react';
import { sleep } from '../utils/sleep';

import {
    RECEIVED_CORE_AUTH_CODE,
    RECEIVED_CORE_AUTH_TOKEN,
    RECEIVED_DATA_CLOUD_ACCESS_TOKEN,
    AUTH_FLOW_DISPATCH_CTX,
    AUTH_FLOW_STATE_CTX,
    reduceAuthState,
    GENERATED_PKCE_CHALLENGE,
    AUTH_FLOW_DEFAULT_STATE,
} from './salesforce_auth_state';
import { useSalesforceConnector } from './salesforce_connector';
import { useAppConfig } from '../app_config';

interface Props {
    children: React.ReactElement;
}

export const SalesforceAuthFlowMock: React.FC<Props> = (props: Props) => {
    const config = useAppConfig();
    const connector = useSalesforceConnector();
    const connectorConfig = config.value?.connectors?.salesforce ?? null;
    const [state, dispatch] = React.useReducer(reduceAuthState, AUTH_FLOW_DEFAULT_STATE);

    // Effect to get the core access token
    React.useEffect(() => {
        if (!connectorConfig?.auth || !state.authParams || !state.authRequested) return;
        const abort = new AbortController();
        const pkceChallenge = config.value?.connectors?.salesforce?.mock?.pkceChallenge ?? {
            value: 'pkce-challenge',
            verifier: 'pkce-verifier',
        };
        const authParams = state.authParams;
        (async () => {
            dispatch({
                type: GENERATED_PKCE_CHALLENGE,
                value: pkceChallenge,
            });
            await sleep(200);
            dispatch({
                type: RECEIVED_CORE_AUTH_CODE,
                value: 'core-access-auth-code',
            });
            const coreAccess = await connector.getCoreAccessToken(
                connectorConfig.auth,
                authParams,
                'core-access-code',
                pkceChallenge.verifier,
                abort.signal,
            );
            dispatch({
                type: RECEIVED_CORE_AUTH_TOKEN,
                value: coreAccess,
            });
            const dataCloudAccess = await connector.getDataCloudAccessToken(coreAccess, abort.signal);
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
