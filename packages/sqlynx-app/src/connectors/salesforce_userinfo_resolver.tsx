import * as React from 'react';
import { useSalesforceConnectionId } from './salesforce_auth_state.js';
import { useSalesforceAPI } from './salesforce_connector.js';
import { SalesforceUserInfo } from './salesforce_api_client.js';
import { useConnectionState } from './connection_manager.js';
import { SalesforceConnectorState } from './connection_state.js';

interface Props {
    children: React.ReactElement;
}

interface State {
    userInfo: SalesforceUserInfo | null;
}

const userInfoCtx = React.createContext<SalesforceUserInfo | null>(null);

export function SalesforceUserInfoResolver(props: Props) {
    const [state, setState] = React.useState<State>({
        userInfo: null,
    });
    const connectionId = useSalesforceConnectionId();
    const [connection, _setConnection] = useConnectionState<SalesforceConnectorState>(connectionId);

    const api = useSalesforceAPI();
    React.useEffect(() => {
        // Clear old user info whenever the api changes
        setState(s => ({
            ...s,
            profile: null,
        }));
        // Not authenticated?
        if (!connection?.auth.coreAccessToken) return;
        // Fetch new user information
        const coreAccessToken = connection.auth.coreAccessToken;
        const cancellation = new AbortController();
        (async () => {
            try {
                const result = await api.getCoreUserInfo(coreAccessToken, cancellation.signal);
                setState(s => ({
                    ...s,
                    userInfo: result,
                }));
            } catch (e: any) {
                if ((e.message = 'AbortError')) {
                    return;
                } else {
                    throw e;
                }
            }
        })();
        return () => cancellation.abort();
    }, [api, connection?.auth.coreAccessToken]);

    return <userInfoCtx.Provider value={state.userInfo}>{props.children}</userInfoCtx.Provider>;
}

export const useSalesforceUserInfo = (): SalesforceUserInfo | null => React.useContext(userInfoCtx);
