import * as React from 'react';
import { useSalesforceAuthState } from './salesforce_auth_flow';
import { useSalesforceApi } from './salesforce_api_provider';
import { SalesforceMetadata } from './salesforce_api_client';

interface Props {
    children: React.ReactElement;
}

interface State {
    metadata: SalesforceMetadata | null;
}

const metadataCtx = React.createContext<SalesforceMetadata | null>(null);

export function SalesforceMetadataResolver(props: Props) {
    const [state, setState] = React.useState<State>({
        metadata: null,
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
        if (!auth.dataCloudAccessToken) return;
        const dataCloudAccessToken = auth.dataCloudAccessToken;

        // Fetch new user information
        const cancellation = new AbortController();
        (async () => {
            try {
                const result = await api.getMetadata(dataCloudAccessToken, cancellation.signal);
                setState({
                    metadata: result,
                });
            } catch (e: any) {
                if ((e.message = 'AbortError')) {
                    return;
                } else {
                    throw e;
                }
            }
        })();
        return () => cancellation.abort();
    }, [api, auth.dataCloudAccessToken]);

    return <metadataCtx.Provider value={state.metadata}>{props.children}</metadataCtx.Provider>;
}

export const useSalesforceMetadata = (): SalesforceMetadata | null => React.useContext(metadataCtx);
