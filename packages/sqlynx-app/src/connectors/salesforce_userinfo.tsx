import * as React from 'react';
import { useSalesforceAPIClient } from './salesforce_auth_client';

interface SalesforceUserInformation {}

interface Props {
    children: React.ReactElement;
}

interface State {
    userInfo: SalesforceUserInformation | null;
}

const userInfoCtx = React.createContext<SalesforceUserInformation | null>(null);

export function SalesforceUserInfoProvider(props: Props) {
    const [state, setState] = React.useState<State>({
        userInfo: null,
    });
    const api = useSalesforceAPIClient();
    React.useEffect(() => {
        // Clear old user info whenever the api changes
        setState(s => ({
            ...s,
            profile: null,
        }));
        // Not authenticated?
        if (!api.isAuthenticated()) return;

        // Fetch new user information
        const cancellation = new AbortController();
        (async () => {
            try {
                const result = await api.getUserInfo(cancellation.signal);
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
