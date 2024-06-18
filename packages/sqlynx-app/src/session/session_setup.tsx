import * as proto from '@ankoh/sqlynx-pb';
import * as React from 'react';

import { SessionSetupPage } from './session_setup_page.js';
import { ConnectorInfo, getConnectorInfoForParams } from '../connectors/connector_info.js';
import { useServerlessSessionSetup } from './setup_serverless_session.js';
import { useAppEventListener } from '../platform/event_listener_provider.js';
import { useSalesforceSessionSetup } from './setup_salesforce_session.js';
import { useHyperSessionSetup } from './setup_hyper_session.js';
import { useCurrentSessionSelector } from './current_session.js';
import { useLogger } from '../platform/logger_provider.js';
import { useDynamicConnectionDispatch } from '../connectors/connection_registry.js';
import { useSessionRegistry } from './session_state_registry.js';
import { RESET } from '../connectors/connection_state.js';

/// For now, we just set up one session per connector.
/// Our abstractions would allow for a more dynamic session management, but we don't have the UI for that.
interface DefaultSessions {
    salesforce: number;
    hyper: number;
    serverless: number;
}
const DEFAULT_SESSIONS = React.createContext<DefaultSessions | null>(null);
export const useDefaultSessions = () => React.useContext(DEFAULT_SESSIONS);

enum SessionSetupDecision {
    UNDECIDED,
    SKIP_SETUP_PAGE,
    SHOW_SETUP_PAGE,
}

interface SessionSetupArgs {
    sessionId: number;
    connector: ConnectorInfo;
    setupProto: proto.sqlynx_session.pb.SessionSetup;
}

interface SessionSetupState {
    decision: SessionSetupDecision;
    args: SessionSetupArgs | null;
}

export const SessionSetup: React.FC<{ children: React.ReactElement }> = (props: { children: React.ReactElement }) => {
    const logger = useLogger();
    const setupServerlessSession = useServerlessSessionSetup();
    const setupHyperSession = useHyperSessionSetup();
    const setupSalesforceSession = useSalesforceSessionSetup();
    const selectCurrentSession = useCurrentSessionSelector();
    const [defaultSessions, setDefaultSessions] = React.useState<DefaultSessions | null>(null);
    const sessionReg = useSessionRegistry();
    const [connReg, connDispatch] = useDynamicConnectionDispatch();

    const appEvents = useAppEventListener();
    const abortDefaultSessionSwitch = React.useRef(new AbortController());

    const setupDefaultSessions = React.useMemo(async () => {
        const [sf, hyper, serverless] = await Promise.all([
            setupSalesforceSession(),
            setupHyperSession(),
            setupServerlessSession(),
        ]);
        const defaultSessions: DefaultSessions = {
            salesforce: sf,
            hyper: hyper,
            serverless: serverless,
        };
        setDefaultSessions(defaultSessions);
        return defaultSessions;
    }, []);

    // State to decide about session setup strategy
    const [state, setState] = React.useState<SessionSetupState>(() => ({
        decision: SessionSetupDecision.UNDECIDED,
        args: null,
    }));

    // Register an event handler for setup events.
    // The user may either paste a deep link through the clipboard, or may run a setup through a deep link.
    React.useEffect(() => {
        // Create a subscriber
        const subscriber = async (data: proto.sqlynx_session.pb.SessionSetup) => {
            // Stop the default session switch after SQLynx is ready
            abortDefaultSessionSwitch.current.abort("session_setup_event");
            // Await the setup of the static sessions
            const defaultSessions = await setupDefaultSessions;
            // Get the connector info for the session setup protobuf
            const connectorInfo = data.connectorParams ? getConnectorInfoForParams(data.connectorParams) : null;
            if (connectorInfo == null) {
                logger.warn("failed to resolve the connector info from the parameters");
                return;
            }
            switch (data.connectorParams?.connector.case) {
                case "hyper": {
                    const session = sessionReg.sessionMap.get(defaultSessions.hyper)!;
                    connDispatch(session.connectionId, { type: RESET, value: null });
                    selectCurrentSession(defaultSessions.hyper);
                    setState({
                        decision: SessionSetupDecision.SHOW_SETUP_PAGE,
                        args: {
                            sessionId: defaultSessions.hyper,
                            connector: connectorInfo,
                            setupProto: data,
                        },
                    });
                    break;
                }
                case "salesforce": {
                    const session = sessionReg.sessionMap.get(defaultSessions.salesforce)!;
                    connDispatch(session.connectionId, { type: RESET, value: null });
                    selectCurrentSession(defaultSessions.salesforce);
                    setState({
                        decision: SessionSetupDecision.SHOW_SETUP_PAGE,
                        args: {
                            sessionId: defaultSessions.salesforce,
                            connector: connectorInfo,
                            setupProto: data,
                        },
                    });
                    break;
                }
                case "serverless": {
                    const session = sessionReg.sessionMap.get(defaultSessions.serverless)!;
                    connDispatch(session.connectionId, { type: RESET, value: null });
                    selectCurrentSession(defaultSessions.serverless);
                    setState({
                        decision: SessionSetupDecision.SKIP_SETUP_PAGE,
                        args: null,
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
            const defaultSessions = await setupDefaultSessions;
            // We might have received a session setup link in the meantime.
            // In that case, don't default-select the serverless session
            if (abortDefaultSessionSwitch.current.signal.aborted) {
                return;
            }
            // Be extra careful not to override a selected session
            selectCurrentSession(s => (s == null) ? defaultSessions.serverless : s);
            // Skip the setup
            setState({
                decision: SessionSetupDecision.SKIP_SETUP_PAGE,
                args: null,
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
        case SessionSetupDecision.SHOW_SETUP_PAGE: {
            const args = state.args!;
            child = <SessionSetupPage
                sessionId={args.sessionId}
                connector={args.connector}
                setupProto={args.setupProto}
                onDone={() => setState(s => ({ ...s, decision: SessionSetupDecision.SKIP_SETUP_PAGE }))}
            />;
            break;
        }
    }
    return (
        <DEFAULT_SESSIONS.Provider value={defaultSessions}>
            {child}
        </DEFAULT_SESSIONS.Provider>
    );
};
