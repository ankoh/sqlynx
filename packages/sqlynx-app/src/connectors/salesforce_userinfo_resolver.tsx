import * as React from 'react';
import { useSalesforceAuthState } from './salesforce_auth_state';
import { useSalesforceAPI } from './salesforce_connector';
import { SalesforceUserInfo } from './salesforce_api_client';

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
    const auth = useSalesforceAuthState();
    const api = useSalesforceAPI();
    React.useEffect(() => {
        // Clear old user info whenever the api changes
        setState(s => ({
            ...s,
            profile: null,
        }));
        // Not authenticated?
        if (!auth.coreAccessToken) return;
        // Fetch new user information
        const coreAccessToken = auth.coreAccessToken;
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
    }, [api, auth.coreAccessToken]);

    return <userInfoCtx.Provider value={state.userInfo}>{props.children}</userInfoCtx.Provider>;
}

export const useSalesforceUserInfo = (): SalesforceUserInfo | null => React.useContext(userInfoCtx);
