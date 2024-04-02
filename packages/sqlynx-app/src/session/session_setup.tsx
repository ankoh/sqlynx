import * as React from 'react';

import { Location, useLocation, useNavigate } from 'react-router-dom';

import { SessionSetupPage } from './session_setup_page.js';
import { SessionLinkGenerator } from './session_link_generator.js';
import { useBrainstormSessionSetup } from './setup_brainstorm_session.js';
import { useLogger } from '../platform/logger_provider.js';
import { Logger } from 'platform/logger.js';

enum SessionSetupDecision {
    UNDECIDED,
    SKIP_SETUP_PAGE,
    SHOW_SETUP_PAGE,
}
// We use a marker to be able to skip the URL setup when we navigate ourselves.
// We should evaluate if we want to update the search params from time to time (maybe debounced?)
// Then the user wouldn't even need to click the url sharing button when in the browser but could instead just copy from the browser bar.
export const SKIP_SETUP_MARKER = Symbol('SKIP_SETUP');

interface SessionSetupState {
    decision: SessionSetupDecision;
    pageLocation: Location;
    pageSearchParams: URLSearchParams;
}


/// Helper to subscribe paste events with deep links
function loadDeepLinksFromClipboard(logger: Logger) {
    const navigate = useNavigate();
    const onWindowPaste = React.useCallback((e: ClipboardEvent) => {
        // Is the pasted text of a deeplink?
        const pastedText = e.clipboardData?.getData("text/plain") ?? null;
        if (pastedText != null && pastedText.startsWith("sqlynx://")) {
            try {
                const deepLink = new URL(pastedText);
                logger.info(`received deep link: ${deepLink.toString()}`, "session_setup");
                const params = deepLink.searchParams;
                params.set("deeplink", "true");
                navigate(`/?${params.toString()}`, { replace: true });
                e.preventDefault();
            } catch (e: any) {
                console.warn(e);
                logger.warn(`parsing deep link failed with error: ${e.toString()}`, "session_setup");
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

export const SessionSetup: React.FC<{ children: React.ReactElement }> = (props: { children: React.ReactElement }) => {
    // Resolve the logger
    const logger = useLogger();
    // Subscribe to paste events of deep links
    loadDeepLinksFromClipboard(logger);
    // Prepare the specific setup functions
    const setupBrainstormSession = useBrainstormSessionSetup();

    // State to decide about session setup strategy
    const location = useLocation();
    const [state, setState] = React.useState<SessionSetupState>(() => ({
        decision: SessionSetupDecision.UNDECIDED,
        pageLocation: location,
        pageSearchParams: new URLSearchParams(location.search),
    }));
    // Re-evaluate session setup strategy whenever our location changes
    React.useEffect(() => {
        // Navigation marker to differentiate user-induced navigation from ours
        if (location.state === SKIP_SETUP_MARKER) {
            setState({
                ...state,
                pageLocation: location,
            });
            return;
        }
        let newSearchParams = new URLSearchParams(location.search);

        // UNDECIDED? That means we're arriving here for the first time.
        // Either we directly set up an empty brainstorming session or we show the session setup page.
        if (state.decision == SessionSetupDecision.UNDECIDED) {

            // No search parameters?
            // In that case we just bypass the setup.
            // XXX In the future, we might want to check if the parameters are actually referring to a setup.
            if (newSearchParams.size == 0) {
                // Setup an empty brainstorm session asynchronously
                setupBrainstormSession();
                // Skip the setup page
                setState({
                    decision: SessionSetupDecision.SKIP_SETUP_PAGE,
                    pageLocation: location,
                    pageSearchParams: newSearchParams,
                });
                return;
            }

            // In all other cases, we show a setup page
            setState({
                decision: SessionSetupDecision.SHOW_SETUP_PAGE,
                pageLocation: location,
                pageSearchParams: newSearchParams,
            });
            return;
        }

        // We rerun the session setup whenever the search parameters change.
        // Figure out if any differs.
        let searchParamsChanged = newSearchParams.entries.length != state.pageSearchParams.entries.length;
        if (!searchParamsChanged) {
            for (const [newKey, newValue] of newSearchParams) {
                const oldValue = state.pageSearchParams.get(newKey);
                if (oldValue !== newValue) {
                    searchParamsChanged = true;
                    break;
                }
            }
        }
        if (searchParamsChanged) {
            setState({
                decision: SessionSetupDecision.SHOW_SETUP_PAGE,
                pageLocation: location,
                pageSearchParams: newSearchParams,
            });
            return;
        } else {
            // Otherwise we just update the location
            setState({
                ...state,
                pageLocation: location,
                pageSearchParams: newSearchParams,
            });
            return;
        }
    }, [location]);

    // Determine what we want to render
    let child: React.ReactElement;
    switch (state.decision) {
        case SessionSetupDecision.UNDECIDED:
            child = <div />;
            break;
        case SessionSetupDecision.SKIP_SETUP_PAGE:
            child = props.children;
            break;
        case SessionSetupDecision.SHOW_SETUP_PAGE:
            child = <SessionSetupPage
                searchParams={state.pageSearchParams}
                onDone={() => setState(s => ({ ...s, decision: SessionSetupDecision.SKIP_SETUP_PAGE }))}
            />;
            break;
    }
    return (
        <SessionLinkGenerator>
            {child}
        </SessionLinkGenerator>
    );
};
