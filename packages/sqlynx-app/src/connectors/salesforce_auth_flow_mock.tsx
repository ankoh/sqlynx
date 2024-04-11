import * as React from 'react';
import { sleep } from '../utils/sleep.js';

import {
    RECEIVED_CORE_AUTH_CODE,
    RECEIVED_CORE_AUTH_TOKEN,
    RECEIVED_DATA_CLOUD_ACCESS_TOKEN,
    AUTH_FLOW_DISPATCH_CTX,
    reduceAuthState,
    GENERATED_PKCE_CHALLENGE,
    AUTH_FLOW_DEFAULT_STATE,
    CONNECTION_ID,
    SalesforceAuthAction,
} from './salesforce_auth_state.js';
import { useSalesforceAPI } from './salesforce_connector.js';
import { useAppConfig } from '../app_config.js';
import { createConnectionId, useOrCreateConnectionState } from './connection_manager.js';
import { SALESFORCE_DATA_CLOUD } from './connector_info.js';
import { SalesforceConnectorState, createEmptyTimings } from './connection_state.js';

interface Props {
    children: React.ReactElement;
}

export const SalesforceAuthFlowMock: React.FC<Props> = (props: Props) => {
    const config = useAppConfig();
    const connector = useSalesforceAPI();
    const connectorConfig = config.value?.connectors?.salesforce ?? null;

    // Get the connection state
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

    // Effect to get the core access token
    React.useEffect(() => {
        if (!connectorConfig?.auth || !connection.auth.authParams || connection.auth.authStarted || !connection.auth.timings.authRequestedAt) return;
        const abort = new AbortController();
        const pkceChallenge = config.value?.connectors?.salesforce?.mock?.pkceChallenge ?? {
            value: 'pkce-challenge',
            verifier: 'pkce-verifier',
        };
        const authParams = connection.auth.authParams;
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
    }, [connection.auth.authParams, connection.auth.authStarted, connection.auth.timings.authRequestedAt, connection.auth.coreAuthCode]);

    return (
        <AUTH_FLOW_DISPATCH_CTX.Provider value={dispatch}>
            <CONNECTION_ID.Provider value={connectionId}>{props.children}</CONNECTION_ID.Provider>
        </AUTH_FLOW_DISPATCH_CTX.Provider>
    );
};
