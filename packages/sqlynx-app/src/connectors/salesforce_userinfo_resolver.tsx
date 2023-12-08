import * as React from 'react';
import { useSalesforceAuthState } from './salesforce_auth_flow';
import { useSalesforceApi } from './salesforce_api_provider';
import { SalesforceUserInformation } from './salesforce_api_client';

interface Props {
    children: React.ReactElement;
}

interface State {
    userInfo: SalesforceUserInformation | null;
}

const userInfoCtx = React.createContext<SalesforceUserInformation | null>(null);

export function SalesforceUserInfoResolver(props: Props) {
    const [state, setState] = React.useState<State>({
        userInfo: null,
    });
    const auth = useSalesforceAuthState();
    const api = useSalesforceApi();
    React.useEffect(() => {
        // Clear old user info whenever the api changes
        setState(s => ({
            ...s,
            profile: null,
        }));
        // Not authenticated?
        if (!auth.coreAccessToken) return;
        const coreAccessToken = auth.coreAccessToken;

        // Fetch new user information
        const cancellation = new AbortController();
        (async () => {
            try {
                const result = await api.getUserInfo(coreAccessToken, cancellation.signal);
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
    }, [api]);

    return <userInfoCtx.Provider value={state.userInfo}>{props.children}</userInfoCtx.Provider>;
}

export const useSalesforceUserInfo = (): SalesforceUserInformation | null => React.useContext(userInfoCtx);
