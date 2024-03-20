import * as React from 'react';
import * as LZString from 'lz-string';

import { Location, useLocation, useNavigate } from 'react-router-dom';

import { useThrottledMemo } from '../utils/throttle.js';
import { VariantKind } from '../utils/index.js';
import { ScriptURLSetupPage } from './session_setup_page.js';
import { ScriptData, ScriptKey } from './session_state.js';
import { useActiveSessionState } from './session_state_provider.js';
import { useSalesforceAuthState } from '../connectors/salesforce_auth_state.js';
import { ConnectorType } from '../connectors/connector_info.js';
import { writeBrainstormConnectorParams, writeHyperConnectorParams, writeSalesforceConnectorParams } from '../connectors/connector_url_params.js';

enum SetupVisibility {
    UNDECIDED,
    SKIP,
    SHOW,
}

const UPDATE_LOCATION = Symbol('UPDATE_LOCATION');
const SETUP_COMPLETE = Symbol('SETUP_COMPLETE');

// We use a marker to be able to skip the URL setup when we navigate ourselves.
// We should evaluate if we want to update the search params from time to time (maybe debounced?)
// Then the user wouldn't even need to click the url sharing button when in the browser but could instead just copy from the browser bar.
export const SKIP_URL_SETUP = Symbol('SKIP_URL_SETUP');

type SessionURLSetupAction =
    | VariantKind<typeof UPDATE_LOCATION, Location>
    | VariantKind<typeof SETUP_COMPLETE, null>
    ;

interface SessionURLSetupState {
    visibility: SetupVisibility;
    location: Location;
    searchParams: URLSearchParams;
}


// The reducer for url setup actions
function reducer(state: SessionURLSetupState, action: SessionURLSetupAction): SessionURLSetupState {
    switch (action.type) {
        case SETUP_COMPLETE:
            return {
                ...state,
                visibility: SetupVisibility.SKIP
            };
        case UPDATE_LOCATION: {
            if (action.value.state === SKIP_URL_SETUP) {
                return {
                    ...state,
                    location: action.value,
                };
            }

            // Skip setup if there is nothing to do.
            // Every component will either stay as is or assume the default state
            let newSearchParams = new URLSearchParams(action.value.search);
            if (newSearchParams.size == 0) {
                return {
                    visibility: SetupVisibility.SKIP,
                    location: action.value,
                    searchParams: newSearchParams,
                }
            }

            // Not empty and currently undecided?
            // Always show setup then
            if (state.visibility == SetupVisibility.UNDECIDED) {
                return {
                    visibility: SetupVisibility.SHOW,
                    location: action.value,
                    searchParams: newSearchParams,
                };
            }

            // We rerun the session setup whenever the search parameters change.
            // Figure out if any differs.
            let searchParamsChanged = newSearchParams.entries.length != state.searchParams.entries.length;
            if (!searchParamsChanged) {
                for (const [newKey, newValue] of newSearchParams) {
                    const oldValue = state.searchParams.get(newKey);
                    if (oldValue !== newValue) {
                        searchParamsChanged = true;
                        break;
                    }
                }
            }
            if (searchParamsChanged) {
                return {
                    visibility: SetupVisibility.SHOW,
                    location: action.value,
                    searchParams: newSearchParams,
                }
            } else {
                // Otherwise we just update the location
                return {
                    ...state,
                    location: action.value,
                    searchParams: newSearchParams,
                };
            }
        }
    }
}

/// Helper to subscribe paste events with deep links
function usePastedDeepLinks() {
    const navigate = useNavigate();
    const onWindowPaste = React.useCallback((e: ClipboardEvent) => {
        // Is the pasted text a deeplink?
        const pastedText = e.clipboardData?.getData("text/plain") ?? null;
        if (pastedText != null && pastedText.startsWith("sqlynx://")) {
            try {
                const deepLink = new URL(pastedText);
                const params = deepLink.searchParams;
                params.set("deeplink", "true");
                navigate(`/?${params.toString()}`, { replace: true });
                e.preventDefault();
            } catch (e: any) {
                console.warn(e);
            }
        }
    }, []);
    React.useEffect(() => {
        window.addEventListener("paste", onWindowPaste);
        return () => {
            window.removeEventListener("paste", onWindowPaste);
        };
    }, []);
}

/// Encode a script as compressed base64 text
function encodeScript(url: URLSearchParams, key: string, data: ScriptData) {
    if (data.script) {
        const text = data.script.toString();
        const textBase64 = LZString.compressToBase64(text);
        url.set(key, encodeURIComponent(textBase64));
    }
};

export interface SessionLinks {
    privateDeepLink: URL;
    privateWebLink: URL;
    publicWebLink: URL;
};

/// Hook to generate a deep link
function generateSessionLinks(): SessionLinks {
    const scriptState = useActiveSessionState();
    const salesforceAuth = useSalesforceAuthState();

    return useThrottledMemo(() => {
        const appUrl = process.env.SQLYNX_APP_URL!;
        const privateParams = new URLSearchParams();
        const publicParams = new URLSearchParams();
        switch (scriptState?.connectorInfo.connectorType ?? ConnectorType.BRAINSTORM_MODE) {
            case ConnectorType.BRAINSTORM_MODE:
                writeBrainstormConnectorParams(privateParams, publicParams);
                break;
            case ConnectorType.HYPER_DATABASE:
                writeHyperConnectorParams(privateParams, publicParams);
                break;
            case ConnectorType.SALESFORCE_DATA_CLOUD:
                writeSalesforceConnectorParams(privateParams, publicParams, salesforceAuth);
                break;
        }
        const mainScript = scriptState?.scripts[ScriptKey.MAIN_SCRIPT] ?? null;
        const schemaScript = scriptState?.scripts[ScriptKey.SCHEMA_SCRIPT] ?? null;
        if (mainScript?.script) {
            encodeScript(publicParams, 'script', mainScript);
        }
        if (schemaScript?.script) {
            encodeScript(privateParams, 'schema', schemaScript);
        }
        const privateAndPublicParams = new URLSearchParams(publicParams);
        for (const [k, v] of privateParams) {
            privateAndPublicParams.set(k, v);
        }
        return {
            privateDeepLink: new URL(`sqlynx://localhost?${privateAndPublicParams.toString()}`),
            privateWebLink: new URL(`${appUrl}?${privateAndPublicParams.toString()}`),
            publicWebLink: new URL(`${appUrl}?${publicParams.toString()}`)
        };
    }, [
        salesforceAuth,
        scriptState?.scripts[ScriptKey.MAIN_SCRIPT],
        scriptState?.scripts[ScriptKey.SCHEMA_SCRIPT],
    ], 500);
}

const GENERATED_LINKS_CTX = React.createContext<SessionLinks | null>(null);

export const SessionLinkManager: React.FC<{ children: React.ReactElement }> = (props: { children: React.ReactElement }) => {

    // Setup reducer
    const location = useLocation();
    const [state, dispatch] = React.useReducer(reducer, null, () => ({
        visibility: SetupVisibility.UNDECIDED,
        location: location,
        searchParams: new URLSearchParams(location.search),
    }));
    // Update the location whenever it changes
    React.useEffect(() => (dispatch({ type: UPDATE_LOCATION, value: location })), [location]);
    // Subscribe to paste events of deep links
    usePastedDeepLinks();
    // Maintain generated session links
    const urls = generateSessionLinks();

    // Determine child element
    let child: React.ReactElement;
    switch (state.visibility) {
        case SetupVisibility.UNDECIDED:
            child = <div />;
            break;
        case SetupVisibility.SKIP:
            child = props.children;
            break;
        case SetupVisibility.SHOW:
            child = <ScriptURLSetupPage
                searchParams={state.searchParams}
                onDone={() => dispatch({ type: SETUP_COMPLETE, value: null })}
            />;
            break;
    }
    return (
        <GENERATED_LINKS_CTX.Provider value={urls}>
            {child}
        </GENERATED_LINKS_CTX.Provider>
    );
};

/// Use the session urls
export const useSessionLinks = () => React.useContext(GENERATED_LINKS_CTX);
