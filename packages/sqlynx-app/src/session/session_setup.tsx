import * as proto from '@ankoh/sqlynx-pb';
import * as React from 'react';

import { SessionSetupPage } from './session_setup_page.js';
import { useBrainstormSessionSetup } from './setup_brainstorm_session.js';
import { ConnectorInfo, getConnectorInfoForParams } from 'connectors/connector_info.js';
import { useAppEventListener } from '../platform/event_listener_provider.js';

enum SessionSetupDecision {
    UNDECIDED,
    UNKNOWN,
    SKIP_SETUP_PAGE,
    SHOW_SETUP_PAGE,
}

interface SessionSetupState {
    decision: SessionSetupDecision;
    setupProto: proto.sqlynx_session.pb.SessionSetup | null;
    connectorInfo: ConnectorInfo | null;
}

export const SessionSetup: React.FC<{ children: React.ReactElement }> = (props: { children: React.ReactElement }) => {
    const setupBrainstormSession = useBrainstormSessionSetup();
    const appEvents = useAppEventListener();

    // State to decide about session setup strategy
    const [state, setState] = React.useState<SessionSetupState>(() => ({
        decision: SessionSetupDecision.UNDECIDED,
        setupProto: null,
        connectorInfo: null
    }));

    React.useEffect(() => {
        // Create a subscriber
        const subscriber = (data: proto.sqlynx_session.pb.SessionSetup) => {
            const connectorInfo = data.connectorParams ? getConnectorInfoForParams(data.connectorParams) : null;
            switch (data.connectorParams?.connector.case) {
                case "hyper":
                case "salesforce":
                    setState({
                        decision: SessionSetupDecision.SHOW_SETUP_PAGE,
                        setupProto: data,
                        connectorInfo
                    });
                    break;
                case "brainstorm":
                    setupBrainstormSession();
                    setState({
                        decision: SessionSetupDecision.SKIP_SETUP_PAGE,
                        setupProto: data,
                        connectorInfo
                    });
                    return;
                default:
                    setState({
                        decision: SessionSetupDecision.UNKNOWN,
                        setupProto: data,
                        connectorInfo
                    });
            }
        };

        // Subscribe to setup events
        appEvents.subscribeSessionSetupEvents(subscriber);
        // Remove listener as soon as this component unmounts
        return () => appEvents.unsubscribeSessionSetupEvents(subscriber);
    }, [appEvents]);

    // Determine what we want to render
    let child: React.ReactElement = <div />;
    switch (state.decision) {
        case SessionSetupDecision.UNDECIDED:
        case SessionSetupDecision.UNKNOWN:
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
    return (
        { child }
    );
};
