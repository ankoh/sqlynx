import * as proto from '@ankoh/sqlynx-pb';
import * as React from 'react';

import { Button, IconButton } from '@primer/react';

import { formatHHMMSS } from '../utils/format.js';
import { useLogger } from '../platform/logger_provider.js';
import { useSalesforceAuthFlow } from '../connectors/salesforce_auth_flow.js';
import { useSalesforceConnectionId } from '../connectors/salesforce_connector.js';
import { useConnectionState } from '../connectors/connection_registry.js';
import { useCurrentSessionState } from './current_session.js';
import { ConnectorInfo, SALESFORCE_DATA_CLOUD_CONNECTOR, requiresSwitchingToNative } from '../connectors/connector_info.js';
import { ConnectorAuthCheck, checkSalesforceAuth, asSalesforceConnection, ConnectionState } from '../connectors/connection_state.js';
import { SessionLinkTarget, generateSessionSetupUrl } from './session_setup_url.js';
import { SalesforceConnectionStateAction, reduceSalesforceConnectionState } from '../connectors/salesforce_connection_state.js';
import { SalesforceAuthParams } from '../connectors/connection_params.js';
import { SQLYNX_VERSION } from '../globals.js';
import { REPLACE_SCRIPT_CONTENT } from './session_state_reducer.js';
import { TextField } from '../view/base/text_field.js';
import { LogViewerInPortal } from '../view/log_viewer.js';

import * as page_styles from '../view/banner_page.module.css';
import * as symbols from '../../static/svg/symbols.generated.svg';

const LOG_CTX = "session_setup";
const AUTOTRIGGER_DELAY = 2000;

interface Props {
    setupProto: proto.sqlynx_session.pb.SessionSetup;
    connectorInfo: ConnectorInfo;
    onDone: () => void;
}

const ConnectorParamsSection: React.FC<{ params: proto.sqlynx_session.pb.ConnectorParams }> = (props: { params: proto.sqlynx_session.pb.ConnectorParams }) => {
    switch (props.params.connector.case) {
        case "salesforce": {
            return (
                <div className={page_styles.card_section}>
                    <div className={page_styles.section_entries}>
                        <TextField
                            name="Salesforce Instance URL"
                            value={props.params.connector.value.instanceUrl ?? ""}
                            readOnly
                            disabled
                            leadingVisual={() => <div>URL</div>}
                            logContext={LOG_CTX}
                        />
                        <TextField
                            name="Connected App"
                            value={props.params.connector.value.appConsumerKey ?? ""}
                            readOnly
                            disabled
                            leadingVisual={() => <div>ID</div>}
                            logContext={LOG_CTX}
                        />
                    </div>
                </div>
            );
        }
        default: {
            return <div />;
        }
    }
};

export const SessionSetupPage: React.FC<Props> = (props: Props) => {
    const now = new Date();
    const logger = useLogger();
    const salesforceConnectionId = useSalesforceConnectionId();
    const salesforceAuthFlow = useSalesforceAuthFlow();
    const [connectionState, setConnectionState] = useConnectionState(salesforceConnectionId);
    const [currentSessionState, modifyCurrentSession] = useCurrentSessionState();
    const [logsAreOpen, setLogsAreOpen] = React.useState<boolean>(false);

    // Resolve the connector info
    let connectorAuthCheck: ConnectorAuthCheck | null = null;
    switch (props.setupProto.connectorParams?.connector.case) {
        case "salesforce":
            connectorAuthCheck = checkSalesforceAuth(asSalesforceConnection(connectionState), props.setupProto.connectorParams.connector.value);
            break;
        default:
            break;
    }

    // Need to switch to native?
    // Some connectors only run in the native app.
    let canExecuteHere = props.connectorInfo ? !requiresSwitchingToNative(props.connectorInfo) : true;
    if (props.setupProto.noPlatformCheck) {
        canExecuteHere = true;
    }

    // Helper to setup the session
    const configure = React.useCallback(async () => {
        // Check which connector configuring
        const connectorParams = props.setupProto.connectorParams?.connector;
        switch (connectorParams?.case) {
            case "salesforce": {
                // Salesforce auth flow not yet ready?
                if (!salesforceAuthFlow) {
                    return;
                }
                // Helper to dispatch auth state actions against the connection state
                const salesforceAuthDispatch = (action: SalesforceConnectionStateAction) => {
                    setConnectionState((c: ConnectionState) => {
                        const s = asSalesforceConnection(c)!;
                        return {
                            type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                            value: reduceSalesforceConnectionState(s, action)
                        }
                    });
                };
                // Authorize the client
                const abortController = new AbortController();
                const authParams: SalesforceAuthParams = {
                    instanceUrl: connectorParams.value.instanceUrl,
                    appConsumerKey: connectorParams.value.appConsumerKey,
                    appConsumerSecret: null,
                };
                await salesforceAuthFlow.authorize(salesforceAuthDispatch, authParams, abortController.signal);

                break;
            }
        }

        // Does the proto specify scripts?
        // Load them asynchronously then after setting up the session.
        //
        // XXX This is the first time we're modifying the attached session....
        //     We should make sure this is sane, ideally we would get the connector info from there.
        const update: any = {};
        for (const script of props.setupProto.scripts) {
            update[script.scriptId] = script.scriptText;
        }
        modifyCurrentSession({ type: REPLACE_SCRIPT_CONTENT, value: update });

        // We're done, return close the session setup page
        props.onDone();

    }, [salesforceAuthFlow]);

    // Setup config auto-trigger
    const autoTriggersAt = React.useMemo(() => new Date(now.getTime() + AUTOTRIGGER_DELAY), []);
    const remainingUntilAutoTrigger = Math.max(autoTriggersAt.getTime(), now.getTime()) - now.getTime();
    React.useEffect(() => {
        // Skip if the connector can't be used here
        if (!canExecuteHere) {
            logger.info("connector cannot be used here, skipping setup trigger", "session_setup");
            return () => { };
        }
        // Otherwise setup an autotrigger for the setup
        logger.info(`setup config auto-trigger in ${formatHHMMSS(remainingUntilAutoTrigger / 1000)}`, "session_setup");
        const timeoutId = setTimeout(() => configure, remainingUntilAutoTrigger);
        return () => clearTimeout(timeoutId);
    }, [props.setupProto]);

    // Collect all sections (after parsing the params)
    const sections: React.ReactElement[] = [];
    if (props.setupProto.scripts.length > 0) {
        const scriptElems: React.ReactElement[] = [];
        for (const script of props.setupProto.scripts) {
            let scriptName = null;
            switch (script.scriptType) {
                case proto.sqlynx_session.pb.ScriptType.Query:
                    scriptName = "Query";
                    break;
                case proto.sqlynx_session.pb.ScriptType.Schema:
                    scriptName = "Schema";
                    break;
            }
            scriptElems.push(
                <TextField
                    key={script.scriptId}
                    name={`Inline ${scriptName != null ? scriptName : script.scriptId}`}
                    value={script.scriptText}
                    readOnly={true}
                    disabled={true}
                    leadingVisual={() => <div>Script text with 0 characters</div>}
                    logContext={LOG_CTX}
                />
            )
        }
        sections.push(
            <div key={sections.length} className={page_styles.card_section}>
                <div className={page_styles.section_entries}>
                    {scriptElems}
                </div>
            </div>
        );
    }
    // Do we have connector params?
    // Then render them in a dedicated section.
    if (props.setupProto?.connectorParams) {
        sections.push(<ConnectorParamsSection key={sections.length} params={props?.setupProto?.connectorParams} />);
    }

    // Generate the session setup url
    const sessionSetupURL = React.useMemo(() => {
        if (canExecuteHere || !currentSessionState || !connectionState) {
            return null;
        } else {
            return generateSessionSetupUrl(currentSessionState, connectionState, SessionLinkTarget.NATIVE);
        }
    }, [
        currentSessionState,
        connectionState
    ]);

    // Do we need to switch to native?
    // Render a warning, information where to get the app and a button to switch.
    if (!canExecuteHere && sessionSetupURL != null) {
        sections.push(
            <div key={sections.length} className={page_styles.card_actions}>
                <Button
                    className={page_styles.card_action_right}
                    variant="primary"
                    onClick={() => {
                        const link = document.createElement('a');
                        link.href = sessionSetupURL.toString();
                        logger.info(`opening deep link: ${link.href}`);
                        link.click();
                    }}>
                    Open App
                </Button>
            </div>
        );

    } else {
        // We can stay here, render normal action bar
        sections.push(
            <div key={sections.length} className={page_styles.card_actions}>
                <Button
                    className={page_styles.card_action_right}
                    variant="primary"
                    onClick={() => props.onDone()}>
                    Continue
                </Button>
            </div>
        );
    }

    // Render the page
    return (
        <div className={page_styles.page}
            data-tauri-drag-region="true">
            <div className={page_styles.banner_container}>
                <div className={page_styles.banner_logo}>
                    <svg width="100%" height="100%">
                        <use xlinkHref={`${symbols}#sqlynx-inverted`} />
                    </svg>
                </div>
                <div className={page_styles.banner_text_container}>
                    <div className={page_styles.banner_title}>sqlynx</div>
                    <div className={page_styles.app_version}>version {SQLYNX_VERSION}</div>
                </div>
            </div>
            <div className={page_styles.card_container}>
                <div className={page_styles.card_header}>
                    <div className={page_styles.card_header_left_container}>
                        Setup
                    </div>
                    <div className={page_styles.card_header_right_container}>
                        <IconButton
                            variant="invisible"
                            icon={() => (
                                <svg width="16px" height="16px">
                                    <use xlinkHref={`${symbols}#log`} />
                                </svg>
                            )}
                            aria-label="close-overlay"
                            onClick={() => setLogsAreOpen(s => !s)}
                        />
                        {logsAreOpen && <LogViewerInPortal onClose={() => setLogsAreOpen(false)} />}
                    </div>
                </div>
                {sections}
            </div>
        </div>
    );
};
