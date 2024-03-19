import * as React from 'react';

import { Location, useLocation, useNavigate } from 'react-router-dom';

import { VariantKind } from '../utils/index.js';
import { ScriptURLSetupPage } from './session_setup_page.js';

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

const reducer = (state: SessionURLSetupState, action: SessionURLSetupAction): SessionURLSetupState => {
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

export const SessionURLManager: React.FC<{ children: React.ReactElement }> = (props: { children: React.ReactElement }) => {
    const location = useLocation();
    const [state, dispatch] = React.useReducer(reducer, null, () => ({
        visibility: SetupVisibility.UNDECIDED,
        location: location,
        searchParams: new URLSearchParams(location.search),
    }));
    React.useEffect(() => (dispatch({ type: UPDATE_LOCATION, value: location })), [location]);
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

    switch (state.visibility) {
        case SetupVisibility.UNDECIDED:
            return <div />;
        case SetupVisibility.SKIP:
            return props.children;
        case SetupVisibility.SHOW:
            return <ScriptURLSetupPage
                searchParams={state.searchParams}
                onDone={() => dispatch({ type: SETUP_COMPLETE, value: null })}
            />;
    }
};
