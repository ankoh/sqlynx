import * as proto from '@ankoh/sqlynx-pb';
import * as React from 'react';

import { SessionSetupPage } from './session_setup_page.js';
import { ConnectorInfo, getConnectorInfoForParams } from '../connectors/connector_info.js';
import { useFilesSessionSetup } from './setup_brainstorm_session.js';
import { useAppEventListener } from '../platform/event_listener_provider.js';
import { useSalesforceSessionSetup } from './setup_salesforce_session.js';
import { useCurrentSessionSelector } from './current_session.js';

enum SessionSetupDecision {
    UNDECIDED,
    SKIP_SETUP_PAGE,
    SHOW_SETUP_PAGE,
}

interface SessionSetupState {
    decision: SessionSetupDecision;
    setupProto: proto.sqlynx_session.pb.SessionSetup | null;
    connectorInfo: ConnectorInfo | null;
}

export const SessionSetup: React.FC<{ children: React.ReactElement }> = (props: { children: React.ReactElement }) => {
    const setupBrainstormSession = useFilesSessionSetup();
    const setupSalesforceSession = useSalesforceSessionSetup();
    const selectCurrentSession = useCurrentSessionSelector();
    const appEvents = useAppEventListener();
    const abortInitialSetup = React.useRef(new AbortController());

    // State to decide about session setup strategy
    const [state, setState] = React.useState<SessionSetupState>(() => ({
        decision: SessionSetupDecision.UNDECIDED,
        setupProto: null,
        connectorInfo: null
    }));

    // Register an event handler for setup events.
    // The user may either paste a deep link through the clipboard, or may run a setup through a deep link.
    React.useEffect(() => {
        const abortSetup = new AbortController();
        // Create a subscriber
        const subscriber = async (data: proto.sqlynx_session.pb.SessionSetup) => {
            abortInitialSetup.current.abort();
            const connectorInfo = data.connectorParams ? getConnectorInfoForParams(data.connectorParams) : null;
            switch (data.connectorParams?.connector.case) {
                case "hyper": {
                    setState({
                        decision: SessionSetupDecision.SHOW_SETUP_PAGE,
                        setupProto: data,
                        connectorInfo
                    });
                    break;
                }
                case "salesforce": {
                    const sessionId = await setupSalesforceSession(abortSetup.signal)
                    if (sessionId != null) {
                        selectCurrentSession(sessionId);
                    }
                    setState({
                        decision: SessionSetupDecision.SHOW_SETUP_PAGE,
                        setupProto: data,
                        connectorInfo
                    });
                    break;
                }
                case "brainstorm": {
                    const sessionId = await setupBrainstormSession(abortSetup.signal);
                    if (sessionId != null) {
                        selectCurrentSession(sessionId);
                    }
                    setState({
                        decision: SessionSetupDecision.SKIP_SETUP_PAGE,
                        setupProto: data,
                        connectorInfo
                    });
                    return;
                }
            }
        };

        // Subscribe to setup events
        appEvents.subscribeSessionSetupEvents(subscriber);
        // Remove listener as soon as this component unmounts
        return () => {
            appEvents.unsubscribeSessionSetupEvents(subscriber);
            abortSetup.abort();
        };
    }, [appEvents]);

    // Effect for initial session setup
    React.useEffect(() => {
        const run = async () => {
            const sessionId = await setupBrainstormSession(abortInitialSetup.current.signal);
            if (sessionId != null) {
                // Only select the brainstorm session if there's no other session set
                selectCurrentSession(s => {
                    if (s == null) {
                        return sessionId;
                    } else {
                        return s;
                    }
                });
                // Skip the setup page
                setState(s => {
                    // Still undecided?
                    if (s.decision == SessionSetupDecision.UNDECIDED) {
                        return {
                            decision: SessionSetupDecision.SKIP_SETUP_PAGE,
                            setupProto: null,
                            connectorInfo: null
                        }
                    } else {
                        return s;
                    }
                })
            }
        };
        run();
    }, []);

    // Determine what we want to render
    let child: React.ReactElement = <div />;
    switch (state.decision) {
        case SessionSetupDecision.UNDECIDED:
            break;
        case SessionSetupDecision.SKIP_SETUP_PAGE:
            child = props.children;
            break;
        case SessionSetupDecision.SHOW_SETUP_PAGE:
            if (state.connectorInfo && state.setupProto) {
                child = <SessionSetupPage
                    connectorInfo={state.connectorInfo}
                    setupProto={state.setupProto}
                    onDone={() => setState(s => ({ ...s, decision: SessionSetupDecision.SKIP_SETUP_PAGE }))}
                />;
            }
            break;
    }
    return child;
};
