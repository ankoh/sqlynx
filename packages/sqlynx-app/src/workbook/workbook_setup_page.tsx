import * as proto from '@ankoh/sqlynx-protobuf';
import * as React from 'react';
import * as symbols from '../../static/svg/symbols.generated.svg';
import * as icons from '../../static/svg/symbols.generated.svg';
import * as baseStyles from '../view/banner_page.module.css';
import * as connStyles from '../view/connectors/connector_settings.module.css';

import { IconButton } from '@primer/react';
import { ChecklistIcon, DesktopDownloadIcon, FileBadgeIcon, KeyIcon, PackageIcon, PlugIcon, XIcon } from '@primer/octicons-react';

import { formatHHMMSS } from '../utils/format.js';
import { useLogger } from '../platform/logger_provider.js';
import { ConnectorInfo, requiresSwitchingToNative } from '../connectors/connector_info.js';
import { encodeWorkbookSetupUrl as encodeWorkbookSetupUrl, WorkbookLinkTarget as WorkbookLinkTarget } from './workbook_setup_url.js';
import { AnchorAlignment, AnchorSide } from '../view/foundations/anchored_position.js';
import { Button, ButtonSize, ButtonVariant } from '../view/foundations/button.js';
import { KeyValueTextField, TextField } from '../view/foundations/text_field.js';
import { RESTORE_WORKBOOK } from './workbook_state.js';
import { SQLYNX_VERSION } from '../globals.js';
import { SalesforceAuthParams } from '../connectors/salesforce/salesforce_connection_params.js';
import { VersionInfoOverlay } from '../view/version_viewer.js';
import { useConnectionState } from '../connectors/connection_registry.js';
import { useSalesforceSetup } from '../connectors/salesforce/salesforce_connector.js';
import { useWorkbookState } from './workbook_state_registry.js';
import { LogViewerOverlay } from '../view/log_viewer.js';
import { OverlaySize } from '../view/foundations/overlay.js';
import { CopyToClipboardButton } from '../utils/clipboard.js';
import { ConnectionHealth } from '../connectors/connection_state.js';
import { IndicatorStatus, StatusIndicator } from '../view/foundations/status_indicator.js';
import {
    getConnectionHealthIndicator,
    getConnectionStatusText,
} from '../view/connectors/salesforce_connector_settings.js';
import { useNavigate } from 'react-router-dom';

const LOG_CTX = "workbook_setup";
const AUTO_TRIGGER_DELAY = 2000;
const AUTO_TRIGGER_COUNTER_INTERVAL = 200;

const ConnectorParamsSection: React.FC<{ params: proto.sqlynx_session.pb.ConnectorParams }> = (props: { params: proto.sqlynx_session.pb.ConnectorParams }) => {
    switch (props.params.connector.case) {
        case "salesforce": {
            return (
                <div className={baseStyles.card_section}>
                    <div className={baseStyles.section_entries}>
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
                <div className={baseStyles.card_section}>
                    <div className={baseStyles.section_entries}>
                        <TextField
                            name="gRPC Endpoint"
                            value={props.params.connector.value.endpoint ?? ""}
                            leadingVisual={() => <div>URL</div>}
                            logContext={LOG_CTX}
                            readOnly
                            disabled
                        />
                        <KeyValueTextField
                            className={connStyles.grid_column_1}
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
    workbookId: number;
    connector: ConnectorInfo;
    setupProto: proto.sqlynx_session.pb.SessionSetup;
    onDone: () => void;
}

export const WorkbookSetupPage: React.FC<Props> = (props: Props) => {
    const now = new Date();
    const navigate = useNavigate();
    const logger = useLogger();
    const salesforceSetup = useSalesforceSetup();
    const [showLogs, setShowLogs] = React.useState<boolean>(false);
    const [showVersionOverlay, setShowVersionOverlay] = React.useState<boolean>(false);
    const [maybeWorkbook, dispatchWorkbook] = useWorkbookState(props.workbookId);
    const workbook = maybeWorkbook!;
    const [maybeConnection, dispatchConnection] = useConnectionState(workbook!.connectionId);
    const connection = maybeConnection!;

    // // Resolve the connector info
    // let connectionSetupCheck: ConnectionSetupCheck | null = null;
    // switch (props.setupProto.connectorParams?.connector.case) {
    //     case "salesforce": {
    //         connectionSetupCheck = checkSalesforceConnectionSetup(connection, props// .setupProto.connectorParams.connector.value);
    //         break;
    //     }
    //     case "hyper": {
    //         connectionSetupCheck = checkHyperConnectionSetup(connection, props.setupProto// .connectorParams.connector.value);
    //         break;
    //     }
    //     default:
    //         break;
    // }

    // Need to switch to native?
    // Some connectors only run in the native app.
    let canExecuteHere = props.connector ? !requiresSwitchingToNative(props.connector) : true;
    if (props.setupProto.noPlatformCheck) {
        canExecuteHere = true;
    }

    // Generate the workbook setup url
    const workbookSetupURL = React.useMemo(() => {
        if (canExecuteHere) {
            return null;
        } else {
            return encodeWorkbookSetupUrl(props.setupProto, WorkbookLinkTarget.NATIVE);
        }
    }, []);

    // Helper to configure the workbook
    const [setupStarted, setSetupStarted] = React.useState<boolean>(false);
    const setupInProgressOrDone = React.useRef<boolean>(false);
    const setupAbortController = React.useRef<AbortController | null>(null);
    const startSetup = React.useCallback(async () => {
        setSetupStarted(true);
        if (setupInProgressOrDone.current) {
            return;
        }
        setupInProgressOrDone.current = true;

        // Cannot execute here? Then redirect the user
        if (!canExecuteHere) {
            const link = document.createElement('a');
            link.href = workbookSetupURL!.toString();
            logger.info(`opening deep link: ${link.href}`);
            link.click();
        }

        // Otherwise configure the workbook
        try {
            // Check which connector configuring
            const connectorParams = props.setupProto.connectorParams?.connector;
            switch (connectorParams?.case) {
                case "salesforce": {
                    // Salesforce auth flow not yet ready?
                    if (!salesforceSetup) {
                        return;
                    }
                    // Authorize the client
                    setupAbortController.current = new AbortController();
                    const authParams: SalesforceAuthParams = {
                        instanceUrl: connectorParams.value.instanceUrl,
                        appConsumerKey: connectorParams.value.appConsumerKey,
                        appConsumerSecret: null,
                        loginHint: null,
                    };
                    await salesforceSetup.setup(dispatchConnection, authParams, setupAbortController.current.signal);
                    setupAbortController.current.signal.throwIfAborted();
                    setupAbortController.current = null;
                    break;
                }
            }

            // Restore the workbook scripts
            //
            // XXX This is the first time we're modifying the attached workbook....
            //     We should make sure this is sane, ideally we would get the connector info from there.
            dispatchWorkbook({ type: RESTORE_WORKBOOK, value: props.setupProto });

            // Navigate to the app root
            navigate("/");

            // We're done, return close the workbook setup page
            props.onDone();
        } catch (e: any) {
            setupInProgressOrDone.current = false;
        }
    }, [salesforceSetup]);

    // Helper to cancel the setup
    const cancelSetup = () => {
        if (setupAbortController.current) {
            setupAbortController.current.abort("abort the connection setup");
            setupAbortController.current = null;
        }
    };

    // Setup config auto-trigger
    const autoTriggersAt = React.useMemo(() => new Date(now.getTime() + AUTO_TRIGGER_DELAY), []);
    const [remainingUntilAutoTrigger, setRemainingUntilAutoTrigger] = React.useState<number>(() => Math.max(autoTriggersAt.getTime(), now.getTime()) - now.getTime());
    React.useEffect(() => {
        // Otherwise setup an autotrigger for the setup
        logger.info(`setup config auto-trigger in ${formatHHMMSS(remainingUntilAutoTrigger / 1000)}`, LOG_CTX);
        const timeoutId = setTimeout(startSetup, remainingUntilAutoTrigger);
        const updaterId: { current: unknown | null } = { current: null };

        const updateRemaining = () => {
            const now = new Date();
            const remainder = Math.max(autoTriggersAt.getTime(), now.getTime()) - now.getTime();
            setRemainingUntilAutoTrigger(remainder);
            if (remainder > AUTO_TRIGGER_COUNTER_INTERVAL) {
                updaterId.current = setTimeout(updateRemaining, AUTO_TRIGGER_COUNTER_INTERVAL);
            }
        };
        updaterId.current = setTimeout(updateRemaining, AUTO_TRIGGER_COUNTER_INTERVAL);

        return () => {
            clearTimeout(timeoutId);
            if (updaterId.current != null) {
                clearTimeout(updaterId.current as any);
            }
        }
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
            <div key={sections.length} className={baseStyles.card_section}>
                <div className={baseStyles.section_entries}>
                    {scriptElems}
                </div>
            </div>
        );
    }

    // Do we have connector params?
    // Then render them in a dedicated section.
    if (props.setupProto.connectorParams) {
        sections.push(<ConnectorParamsSection key={sections.length} params={props?.setupProto?.connectorParams} />);
    }

    // Do we need to switch to native?
    // Render a warning, information where to get the app and a button to switch.
    if (!canExecuteHere && workbookSetupURL != null) {
        sections.push(
            <div key={sections.length} className={baseStyles.card_section}>
                <div className={baseStyles.section_entries}>
                    <div className={baseStyles.section_description}>
                        This connector can only be used in the native app.<br />
                        cf.
                        <svg className={baseStyles.github_link_icon} width="20px" height="20px">
                            <use xlinkHref={`${icons}#github`} />
                        </svg>
                        &nbsp;
                        <a className={baseStyles.github_link_text} href="https://github.com/ankoh/sqlynx/issues/738"
                            target="_blank">
                            Web connectors for Hyper and Data Cloud
                        </a>
                    </div>
                </div>
                <div className={baseStyles.card_actions}>
                    <div className={baseStyles.card_actions_left}>
                        <VersionInfoOverlay
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
                    </div>
                    <div className={baseStyles.card_actions_right}>
                        <CopyToClipboardButton
                            variant={ButtonVariant.Primary}
                            size={ButtonSize.Medium}
                            logContext={LOG_CTX}
                            value={workbookSetupURL.toString()}
                            aria-label="copy-deeplink"
                            aria-labelledby=""
                        />
                        <Button
                            variant={ButtonVariant.Primary}
                            leadingVisual={DesktopDownloadIcon}
                            trailingVisual={!setupStarted ? () =>
                                <div>{Math.floor(remainingUntilAutoTrigger / 1000)}</div> : undefined}
                            onClick={() => {
                                const link = document.createElement('a');
                                link.href = workbookSetupURL.toString();
                                logger.info(`opening deep link: ${link.href}`);
                                link.click();
                            }}>
                            Open in App
                        </Button>
                    </div>
                </div>
            </div>
        );
    } else if (connection.connectionHealth != ConnectionHealth.ONLINE) {
        // Get the connection status
        const statusText: string = getConnectionStatusText(connection.connectionStatus, logger);
        // Get the indicator status
        const indicatorStatus: IndicatorStatus = getConnectionHealthIndicator(connection.connectionHealth);
        // Resolve the connect button
        let connectButton: React.ReactElement = <div />;
        switch (connection.connectionHealth) {
            case ConnectionHealth.NOT_STARTED:
                connectButton = (
                    <Button
                        variant={ButtonVariant.Primary}
                        onClick={startSetup}
                        trailingVisual={!setupStarted ? () =>
                            <div>{Math.floor(remainingUntilAutoTrigger / 1000)}</div> : undefined}
                    >
                        Connect
                    </Button>
                )
                break;
            case ConnectionHealth.FAILED:
            case ConnectionHealth.CANCELLED:
                connectButton = <Button variant={ButtonVariant.Primary} leadingVisual={PlugIcon} onClick={startSetup}>Connect</Button>;
                break;
            case ConnectionHealth.CONNECTING:
                connectButton = <Button variant={ButtonVariant.Danger} leadingVisual={XIcon} onClick={cancelSetup}>Cancel</Button>;
                break;
        }

        sections.push(
            <div key={sections.length} className={baseStyles.card_actions}>
                <div className={baseStyles.card_actions_left}>
                    <div className={baseStyles.connection_status}>
                        <div className={connStyles.status_indicator}>
                            <StatusIndicator className={connStyles.status_indicator_spinner} status={indicatorStatus}
                                fill="black" />
                        </div>
                        <div className={connStyles.status_text}>
                            {statusText}
                        </div>
                    </div>
                </div>
                <div className={baseStyles.card_actions_right}>
                    {connectButton}
                </div>
            </div>,
        );
    } else {
        // We can stay here, render normal action bar
        sections.push(
            <div key={sections.length} className={baseStyles.card_actions}>
                <div className={baseStyles.card_actions_right}>
                    <Button
                        variant={ButtonVariant.Primary}
                        onClick={() => props.onDone()}
                    >
                        Continue
                    </Button>
                </div>
            </div>,
        );
    }

    // Render the page
    return (
        <div className={baseStyles.page}>
            <div className={baseStyles.banner_and_content_container} data-tauri-drag-region>
                <div className={baseStyles.banner_container} data-tauri-drag-region>
                    <div className={baseStyles.banner_logo} data-tauri-drag-region>
                        <svg width="100%" height="100%">
                            <use xlinkHref={`${symbols}#sqlynx-inverted`} />
                        </svg>
                    </div>
                    <div className={baseStyles.banner_text_container} data-tauri-drag-region>
                        <div className={baseStyles.banner_title} data-tauri-drag-region>sqlynx</div>
                        <div className={baseStyles.app_version} data-tauri-drag-region>version {SQLYNX_VERSION}</div>
                    </div>
                </div>
                <div className={baseStyles.content_container} data-tauri-drag-region>
                    <div className={baseStyles.card}>
                        <div className={baseStyles.card_header} data-tauri-drag-region>
                            <div className={baseStyles.card_header_left_container}>
                                Setup {connection.connectionInfo.displayName.long}
                            </div>
                            <div className={baseStyles.card_header_right_container}>
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
