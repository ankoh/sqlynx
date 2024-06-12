import * as proto from '@ankoh/sqlynx-pb';
import * as React from 'react';

import { SessionSetupPage } from './session_setup_page.js';
import {
    CONNECTOR_INFOS,
    ConnectorInfo,
    ConnectorType,
    getConnectorInfoForParams,
} from '../connectors/connector_info.js';
import { useServerlessSessionSetup } from './setup_serverless_session.js';
import { useAppEventListener } from '../platform/event_listener_provider.js';
import { useSalesforceSessionSetup } from './setup_salesforce_session.js';
import { useHyperSessionSetup } from './setup_hyper_session.js';
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
    const setupServerlessSession = useServerlessSessionSetup();
    const setupHyperSession = useHyperSessionSetup();
    const setupSalesforceSession = useSalesforceSessionSetup();
    const selectCurrentSession = useCurrentSessionSelector();

    const appEvents = useAppEventListener();
    const abortDefaultSessionSwitch = React.useRef(new AbortController());

    // XXX For now, we set up one session per connector.
    //     Our current abstractions would allow for a more dynamic session management, but we don't have the UI for that.
    const staticSessionSetup = React.useMemo(async () => {
        const [sf, hyper, serverless] = await Promise.all([
            setupSalesforceSession(),
            setupHyperSession(),
            setupServerlessSession(),
        ]);
        console.log([sf, hyper, serverless]);
        return {
            salesforce: sf,
            hyper: hyper,
            serverless: serverless,
        };
    }, []);

    // State to decide about session setup strategy
    const [state, setState] = React.useState<SessionSetupState>(() => ({
        decision: SessionSetupDecision.UNDECIDED,
        setupProto: null,
        connectorInfo: null
    }));

    // Register an event handler for setup events.
    // The user may either paste a deep link through the clipboard, or may run a setup through a deep link.
    React.useEffect(() => {
        // Create a subscriber
        const subscriber = async (data: proto.sqlynx_session.pb.SessionSetup) => {
            // Stop the default session switch after SQLynx is ready
            abortDefaultSessionSwitch.current.abort("session_setup_event");
            // Await the setup of the static sessions
            const staticSessions = await staticSessionSetup;
            // Get the connector info for the session setup protobuf
            const connectorInfo = data.connectorParams ? getConnectorInfoForParams(data.connectorParams) : null;
            switch (data.connectorParams?.connector.case) {
                case "hyper": {
                    selectCurrentSession(staticSessions.hyper);
                    setState({
                        decision: SessionSetupDecision.SHOW_SETUP_PAGE,
                        setupProto: data,
                        connectorInfo
                    });
                    break;
                }
                case "salesforce": {
                    selectCurrentSession(staticSessions.salesforce);
                    setState({
                        decision: SessionSetupDecision.SHOW_SETUP_PAGE,
                        setupProto: data,
                        connectorInfo
                    });
                    break;
                }
                case "serverless": {
                    selectCurrentSession(staticSessions.serverless);
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
        };
    }, [appEvents]);

    // Effect to switch to default serverless session after setup
    React.useEffect(() => {
        const selectDefaultSession = async () => {
            // Await the setup of the static sessions
            const staticSessions = await staticSessionSetup;
            // We might have received a session setup link in the meantime.
            // In that case, don't default-select the serverless session
            if (abortDefaultSessionSwitch.current.signal.aborted) {
                return;
            }
            // Be extra careful not to override a selected session
            selectCurrentSession(s => (s == null) ? staticSessions.serverless : s);
            // Skip the setup
            setState({
                decision: SessionSetupDecision.SKIP_SETUP_PAGE,
                setupProto: null,
                connectorInfo: CONNECTOR_INFOS[ConnectorType.SERVERLESS]
            });
        };
        selectDefaultSession();
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
