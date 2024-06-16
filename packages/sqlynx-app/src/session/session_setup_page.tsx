import * as proto from '@ankoh/sqlynx-pb';
import * as React from 'react';
import * as symbols from '../../static/svg/symbols.generated.svg';
import * as icons from '../../static/svg/symbols.generated.svg';
import * as page_styles from '../view/banner_page.module.css';
import * as styles from '../view/connectors/platform_check.module.css';

import { IconButton } from '@primer/react';
import { ChecklistIcon, DesktopDownloadIcon, FileBadgeIcon, KeyIcon, PackageIcon } from '@primer/octicons-react';

import { formatHHMMSS } from '../utils/format.js';
import { useLogger } from '../platform/logger_provider.js';
import { useSalesforceAuthFlow } from '../connectors/salesforce_auth_flow.js';
import { ConnectorInfo, requiresSwitchingToNative } from '../connectors/connector_info.js';
import { generateSessionSetupUrl, SessionLinkTarget } from './session_setup_url.js';
import { SalesforceAuthParams } from '../connectors/connection_params.js';
import { SQLYNX_VERSION } from '../globals.js';
import { REPLACE_SCRIPT_CONTENT } from './session_state.js';
import { KeyValueTextField, TextField } from '../view/foundations/text_field.js';
import { VersionViewerOverlay } from '../view/version_viewer.js';
import { AnchorAlignment, AnchorSide } from '../view/foundations/anchored_position.js';
import { Button, ButtonVariant } from '../view/foundations/button.js';
import {
    checkHyperConnectionSetup,
    checkSalesforceConnectionSetup,
    ConnectionSetupCheck,
} from '../connectors/connector_setup_check.js';
import { useSessionState } from './session_state_registry.js';
import { useConnectionState } from '../connectors/connection_registry.js';
import { LogViewerOverlay } from '../view/log_viewer.js';
import { OverlaySize } from '../view/foundations/overlay.js';
import * as style from '../view/connectors/connector_settings.module.css';

const LOG_CTX = "session_setup";
const AUTOTRIGGER_DELAY = 2000;

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
        case "hyper": {
            return (
                <div className={page_styles.card_section}>
                    <div className={page_styles.section_entries}>
                        <TextField
                            name="gRPC Endpoint"
                            value={props.params.connector.value.endpoint ?? ""}
                            leadingVisual={() => <div>URL</div>}
                            logContext={LOG_CTX}
                            readOnly
                            disabled
                        />
                        <KeyValueTextField
                            className={style.grid_column_1}
                            name="mTLS Client Key"
                            k={props.params.connector.value.tls?.clientKeyPath ?? ""}
                            v={props.params.connector.value.tls?.clientCertPath ?? ""}
                            keyPlaceholder="client.key"
                            valuePlaceholder="client.pem"
                            keyIcon={KeyIcon}
                            valueIcon={FileBadgeIcon}
                            keyAriaLabel='mTLS Client Key'
                            valueAriaLabel='mTLS Client Certificate'
                            logContext={LOG_CTX}
                            disabled
                            readOnly
                        />
                        <TextField
                            name="mTLS CA certificates"
                            value={props.params.connector.value.tls?.caCertsPath ?? ""}
                            placeholder="cacerts.pem"
                            leadingVisual={ChecklistIcon}
                            logContext={LOG_CTX}
                            disabled
                            readOnly
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

interface Props {
    sessionId: number;
    connector: ConnectorInfo;
    setupProto: proto.sqlynx_session.pb.SessionSetup;
    onDone: () => void;
}

export const SessionSetupPage: React.FC<Props> = (props: Props) => {
    const now = new Date();
    const logger = useLogger();
    const salesforceAuthFlow = useSalesforceAuthFlow();
    const [showLogs, setShowLogs] = React.useState<boolean>(false);
    const [showVersionOverlay, setShowVersionOverlay] = React.useState<boolean>(false);
    const [maybeSession, dispatchSession] = useSessionState(props.sessionId);
    const session = maybeSession!;
    const [maybeConnection,  dispatchConnection]= useConnectionState(session!.connectionId);
    const connection = maybeConnection!;


    // Resolve the connector info
    let connectionSetupCheck: ConnectionSetupCheck | null = null;
    switch (props.setupProto.connectorParams?.connector.case) {
        case "salesforce": {
            connectionSetupCheck = checkSalesforceConnectionSetup(connection, props.setupProto.connectorParams.connector.value);
            break;
        }
        case "hyper": {
            connectionSetupCheck = checkHyperConnectionSetup(connection, props.setupProto.connectorParams.connector.value);
            break;
        }
        default:
            break;
    }

    // Need to switch to native?
    // Some connectors only run in the native app.
    let canExecuteHere = props.connector ? !requiresSwitchingToNative(props.connector) : true;
    if (props.setupProto.noPlatformCheck) {
        canExecuteHere = true;
    }

    // Helper to configure the session
    const configure = React.useCallback(async () => {
        // Check which connector configuring
        const connectorParams = props.setupProto.connectorParams?.connector;
        switch (connectorParams?.case) {
            case "salesforce": {
                // Salesforce auth flow not yet ready?
                if (!salesforceAuthFlow) {
                    return;
                }
                // Authorize the client
                const abortController = new AbortController();
                const authParams: SalesforceAuthParams = {
                    instanceUrl: connectorParams.value.instanceUrl,
                    appConsumerKey: connectorParams.value.appConsumerKey,
                    appConsumerSecret: null,
                };
                await salesforceAuthFlow.authorize(dispatchConnection, authParams, abortController.signal);

                break;
            }
        }

        // Does the proto specify scripts?
        // Load them asynchronously then after setting up the session.
        //
        // XXX This is the first time we're modifying the attached session....
        //     We should make sure this is sane, ideally we would get the connector info from there.
        const update: Record<number, string> = {};
        for (const script of props.setupProto.scripts) {
            update[script.scriptId] = script.scriptText;
        }
        dispatchSession({ type: REPLACE_SCRIPT_CONTENT, value: update });

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
    const sections: React.ReactElement[] = [];

    // Collect all sections (after parsing the params)
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
                    leadingVisual={() => <div>SQL</div>}
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
        if (canExecuteHere) {
            return null;
        } else {
            return generateSessionSetupUrl(session, connection, SessionLinkTarget.NATIVE);
        }
    }, []);

    // Do we need to switch to native?
    // Render a warning, information where to get the app and a button to switch.
    if (!canExecuteHere && sessionSetupURL != null) {
        sections.push(
            <div key={sections.length} className={page_styles.card_section}>
                <div className={page_styles.section_entries}>
                    <div className={page_styles.section_description}>
                        This connector can only be used in the native app.<br />
                        cf.
                        <svg className={styles.github_link_icon} width="20px" height="20px">
                            <use xlinkHref={`${icons}#github`} />
                        </svg>
                        &nbsp;
                        <a className={styles.github_link_text} href="https://github.com/ankoh/sqlynx/issues/738"
                           target="_blank">
                            Web connectors for Hyper and Data Cloud
                        </a>
                    </div>
                </div>
                <div className={page_styles.card_actions}>
                    <div className={page_styles.card_actions_right}>
                        <VersionViewerOverlay
                            isOpen={showVersionOverlay}
                            onClose={() => setShowVersionOverlay(false)}
                            renderAnchor={(p: object) => (
                                <Button
                                    {...p}
                                    variant={ButtonVariant.Default}
                                    onClick={() => setShowVersionOverlay(true)}
                                    leadingVisual={PackageIcon}>
                                    Download App
                                </Button>
                            )}
                            side={AnchorSide.OutsideTop}
                            align={AnchorAlignment.Center}
                            anchorOffset={8}
                        />
                        <Button
                            variant={ButtonVariant.Primary}
                            leadingVisual={DesktopDownloadIcon}
                            onClick={() => {
                                const link = document.createElement('a');
                                link.href = sessionSetupURL.toString();
                                logger.info(`opening deep link: ${link.href}`);
                                link.click();
                            }}>
                            Open in App
                        </Button>
                    </div>
                </div>
            </div>
        );

    } else {
        // We can stay here, render normal action bar
        sections.push(
            <div key={sections.length} className={page_styles.card_actions}>
                <div className={page_styles.card_actions_right}>
                    <Button
                        variant={ButtonVariant.Primary}
                        onClick={() => props.onDone()}>
                        Continue
                    </Button>
                </div>
            </div>,
        );
    }

    // Render the page
    return (
        <div className={page_styles.page}
                 data-tauri-drag-region="true">
            <div className={page_styles.banner_and_content_container}>
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
                <div className={page_styles.content_container}>
                    <div className={page_styles.card}>
                        <div className={page_styles.card_header}>
                            <div className={page_styles.card_header_left_container}>
                                Setup
                            </div>
                            <div className={page_styles.card_header_right_container}>
                                <LogViewerOverlay
                                    isOpen={showLogs}
                                    onClose={() => setShowLogs(false)}
                                    renderAnchor={(p: object) => (
                                        <IconButton
                                            {...p}
                                            variant="invisible"
                                            icon={() => (
                                                <svg width="16px" height="16px">
                                                    <use xlinkHref={`${symbols}#log`} />
                                                </svg>
                                            )}
                                            aria-label="close-overlay"
                                            onClick={() => setShowLogs(s => !s)}
                                        />
                                    )}
                                    side={AnchorSide.OutsideBottom}
                                    align={AnchorAlignment.End}
                                    anchorOffset={16}
                                    overlayProps={{
                                        width: OverlaySize.L,
                                        height: OverlaySize.M
                                    }}
                                />
                            </div>
                        </div>
                        {sections}
                    </div>
                </div>
            </div>
        </div>
    );
};