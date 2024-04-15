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
import { useAllocatedConnectionState, useConnectionState } from './connection_registry.js';
import { SALESFORCE_DATA_CLOUD } from './connector_info.js';
import { ConnectionState, createEmptyTimings, unpackSalesforceConnection } from './connection_state.js';

interface Props {
    children: React.ReactElement;
}

export const SalesforceAuthFlowMock: React.FC<Props> = (props: Props) => {
    const config = useAppConfig();
    const connector = useSalesforceAPI();
    const connectorConfig = config.value?.connectors?.salesforce ?? null;

    // Get the connection state
    const connectionId = useAllocatedConnectionState((_) => ({
        type: SALESFORCE_DATA_CLOUD,
        value: {
            timings: createEmptyTimings(),
            auth: AUTH_FLOW_DEFAULT_STATE
        }
    }));
    const [connection, setConnection] = useConnectionState(connectionId);
    const sfConn = unpackSalesforceConnection(connection);
    const sfAuth = (auth: SalesforceAuthAction) => {
        setConnection((c: ConnectionState) => {
            const s = unpackSalesforceConnection(c)!;
            return {
                type: SALESFORCE_DATA_CLOUD,
                value: {
                    ...s,
                    auth: reduceAuthState(s.auth, auth)
                }
            };
        });
    };

    // Effect to get the core access token
    React.useEffect(() => {
        if (!connectorConfig?.auth ||
            !sfConn ||
            !sfConn.auth.authParams ||
            sfConn.auth.authStarted ||
            !sfConn.auth.timings.authRequestedAt)
            return;
        const abort = new AbortController();
        const pkceChallenge = config.value?.connectors?.salesforce?.mock?.pkceChallenge ?? {
            value: 'pkce-challenge',
            verifier: 'pkce-verifier',
        };
        const authParams = sfConn.auth.authParams;
        (async () => {
            sfAuth({
                type: GENERATED_PKCE_CHALLENGE,
                value: pkceChallenge,
            });
            await sleep(200);
            sfAuth({
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
            sfAuth({
                type: RECEIVED_CORE_AUTH_TOKEN,
                value: coreAccess,
            });
            const dataCloudAccess = await connector.getDataCloudAccessToken(coreAccess, abort.signal);
            sfAuth({
                type: RECEIVED_DATA_CLOUD_ACCESS_TOKEN,
                value: dataCloudAccess,
            });
        })();
    }, [sfConn?.auth.authParams, sfConn?.auth.authStarted, sfConn?.auth.timings.authRequestedAt, sfConn?.auth.coreAuthCode]);

    return (
        <AUTH_FLOW_DISPATCH_CTX.Provider value={sfAuth}>
            <CONNECTION_ID.Provider value={connectionId}>{props.children}</CONNECTION_ID.Provider>
        </AUTH_FLOW_DISPATCH_CTX.Provider>
    );
};
