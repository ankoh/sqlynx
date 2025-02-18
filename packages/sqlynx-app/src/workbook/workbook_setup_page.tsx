import * as proto from '@ankoh/sqlynx-protobuf';
import * as React from 'react';
import * as symbols from '../../static/svg/symbols.generated.svg';
import * as baseStyles from '../view/banner_page.module.css';
import * as connStyles from '../view/connection/connection_settings.module.css';

import { IconButton } from '@primer/react';
import { ChecklistIcon, DesktopDownloadIcon, FileBadgeIcon, KeyIcon, PackageIcon, PlugIcon, XIcon } from '@primer/octicons-react';

import { AnchorAlignment, AnchorSide } from '../view/foundations/anchored_position.js';
import { Button, ButtonSize, ButtonVariant } from '../view/foundations/button.js';
import { ConnectionHealth } from '../connection/connection_state.js';
import { ConnectorInfo, HYPER_GRPC_CONNECTOR, requiresSwitchingToNative, SALESFORCE_DATA_CLOUD_CONNECTOR, TRINO_CONNECTOR } from '../connection/connector_info.js';
import { CopyToClipboardButton } from '../utils/clipboard.js';
import { IndicatorStatus, StatusIndicator } from '../view/foundations/status_indicator.js';
import { KeyValueTextField, TextField } from '../view/foundations/text_field.js';
import { LogViewerOverlay } from '../view/log_viewer.js';
import { OverlaySize } from '../view/foundations/overlay.js';
import { RESTORE_WORKBOOK } from './workbook_state.js';
import { SQLYNX_VERSION } from '../globals.js';
import { VersionInfoOverlay } from '../view/version_viewer.js';
import { encodeWorkbookAsUrl as encodeWorkbookAsUrl, WorkbookLinkTarget as WorkbookLinkTarget } from './workbook_setup_url.js';
import { formatHHMMSS } from '../utils/format.js';
import { getConnectionError, getConnectionHealthIndicator, getConnectionStatusText } from '../view/connection/salesforce_connector_settings.js';
import { useConnectionState } from '../connection/connection_registry.js';
import { useLogger } from '../platform/logger_provider.js';
import { useNavigate } from 'react-router-dom';
import { useSalesforceSetup } from '../connection/salesforce/salesforce_connector.js';
import { useTrinoSetup } from '../connection/trino/trino_connector.js';
import { useWorkbookState } from './workbook_state_registry.js';
import { ErrorDetailsButton } from '../view/error_details.js';
import { DetailedError } from '../utils/error.js';
import { ConnectionParamsVariant, encodeConnectionParams, readConnectionParamsFromProto } from '../connection/connection_params.js';
import { useCatalogLoaderQueueFn } from '../connection/catalog_loader.js';

const LOG_CTX = "workbook_setup";
const AUTO_TRIGGER_DELAY = 2000;
const AUTO_TRIGGER_COUNTER_INTERVAL = 200;

interface ConnectorParamsSectionProps {
    params: ConnectionParamsVariant,
    updateParams: (params: ConnectionParamsVariant) => void
}

const ConnectionParamsSection: React.FC<ConnectorParamsSectionProps> = (props: ConnectorParamsSectionProps) => {
    switch (props.params.type) {
        case SALESFORCE_DATA_CLOUD_CONNECTOR: {
            return (
                <div className={baseStyles.card_section}>
                    <div className={baseStyles.section_entries}>
                        <TextField
                            name="Salesforce Instance URL"
                            value={props.params.value.instanceUrl ?? ""}
                            readOnly
                            disabled
                            leadingVisual={() => <div>URL</div>}
                            logContext={LOG_CTX}
                        />
                        <TextField
                            name="Connected App"
                            value={props.params.value.appConsumerKey ?? ""}
                            readOnly
                            disabled
                            leadingVisual={() => <div>ID</div>}
                            logContext={LOG_CTX}
                        />
                    </div>
                </div>
            );
        }
        case HYPER_GRPC_CONNECTOR: {
            return (
                <div className={baseStyles.card_section}>
                    <div className={baseStyles.section_entries}>
                        <TextField
                            name="gRPC Endpoint"
                            value={props.params.value.channelArgs.endpoint ?? ""}
                            leadingVisual={() => <div>URL</div>}
                            logContext={LOG_CTX}
                            readOnly
                            disabled
                        />
                        <KeyValueTextField
                            className={connStyles.grid_column_1}
                            name="mTLS Client Key"
                            k={props.params.value.channelArgs.tls?.keyPath ?? ""}
                            v={props.params.value.channelArgs.tls?.pubPath ?? ""}
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
                            value={props.params.value.channelArgs.tls?.caPath ?? ""}
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
        case TRINO_CONNECTOR: {
            const p = props.params.value;
            return (
                <div className={baseStyles.card_section}>
                    <div className={baseStyles.section_entries}>
                        <TextField
                            name="Endpoint"
                            value={props.params.value.channelArgs.endpoint ?? ""}
                            leadingVisual={() => <div>URL</div>}
                            logContext={LOG_CTX}
                            onChange={(e) => props.updateParams({
                                type: TRINO_CONNECTOR,
                                value: {
                                    ...p,
                                    channelArgs: {
                                        ...p.channelArgs,
                                        endpoint: e.target.value
                                    }
                                }
                            })}
                        />
                        <TextField
                            name="Username"
                            value={props.params.value.authParams?.username ?? ""}
                            leadingVisual={() => <div>ID</div>}
                            logContext={LOG_CTX}
                            onChange={(e) => props.updateParams({
                                type: TRINO_CONNECTOR,
                                value: {
                                    ...p,
                                    authParams: {
                                        ...p.authParams,
                                        username: e.target.value
                                    }
                                }
                            })}
                        />
                        <TextField
                            name="Secret"
                            value={props.params.value.authParams?.secret ?? ""}
                            concealed={true}
                            leadingVisual={KeyIcon}
                            logContext={LOG_CTX}
                            onChange={(e) => props.updateParams({
                                type: TRINO_CONNECTOR,
                                value: {
                                    ...p,
                                    authParams: {
                                        ...p.authParams,
                                        secret: e.target.value
                                    }
                                }
                            })}
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
    setupProto: proto.sqlynx_workbook.pb.Workbook;
    onDone: () => void;
}

export const WorkbookSetupPage: React.FC<Props> = (props: Props) => {
    const now = new Date();
    const navigate = useNavigate();
    const logger = useLogger();
    const salesforceSetup = useSalesforceSetup();
    const trinoSetup = useTrinoSetup();
    const loadCatalog = useCatalogLoaderQueueFn();

    const [showLogs, setShowLogs] = React.useState<boolean>(false);
    const [showVersionOverlay, setShowVersionOverlay] = React.useState<boolean>(false);

    // Resolve a connection id for the workbook
    const [maybeWorkbook, dispatchWorkbook] = useWorkbookState(props.workbookId);
    const [maybeConnection, dispatchConnection] = useConnectionState(maybeWorkbook!.connectionId);
    const connection = maybeConnection!;

    // Maintain setup override settings
    const [connectionParams, setConnectionParams] = React.useState<ConnectionParamsVariant | null>(() => props.setupProto.connectorParams ? readConnectionParamsFromProto(props.setupProto.connectorParams) : null);

    // Need to switch to native?
    // Some connectors only run in the native app.
    let canExecuteHere = props.connector ? !requiresSwitchingToNative(props.connector) : true;
    if (props.setupProto.noPlatformCheck) {
        canExecuteHere = true;
    }

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

        // Bake the workbook proto, we'll need this in any case
        const workbookProto = new proto.sqlynx_workbook.pb.Workbook({
            ...props.setupProto,
            connectorParams: connectionParams == null ? undefined : encodeConnectionParams(connectionParams)
        });

        // Cannot execute here? Then redirect the user
        if (!canExecuteHere) {
            const link = document.createElement('a');
            link.href = encodeWorkbookAsUrl(workbookProto, WorkbookLinkTarget.NATIVE).toString();
            logger.info(`opening deep link`, { "href": link.href });
            link.click();
        }

        // Otherwise configure the workbook
        try {
            // Check which connector configuring
            switch (connectionParams?.type) {
                case SALESFORCE_DATA_CLOUD_CONNECTOR: {
                    // Salesforce auth flow not yet ready?
                    if (!salesforceSetup) {
                        return;
                    }
                    // Setup the connection
                    setupAbortController.current = new AbortController();
                    await salesforceSetup.setup(dispatchConnection, connectionParams.value, setupAbortController.current.signal);
                    setupAbortController.current.signal.throwIfAborted();
                    setupAbortController.current = null;
                    break;
                }
                case TRINO_CONNECTOR: {
                    if (!trinoSetup) {
                        return;
                    }
                    setupAbortController.current = new AbortController();
                    await trinoSetup.setup(dispatchConnection, connectionParams.value, setupAbortController.current.signal);
                    setupAbortController.current.signal.throwIfAborted();
                    setupAbortController.current = null;
                    break;
                }
            }

            // Restore the workbook scripts
            //
            // XXX This is the first time we're modifying the attached workbook....
            //     We should make sure this is sane, ideally we would get the connector info from there.
            dispatchWorkbook({ type: RESTORE_WORKBOOK, value: workbookProto });

            // Load the catalog
            loadCatalog(connection.connectionId);

            // Navigate to the app root
            navigate("/");

            // We're done, return close the workbook setup page
            props.onDone();
        } catch (e: any) {
            setupInProgressOrDone.current = false;
        }
    }, [salesforceSetup, connectionParams]);

    // Helper to cancel the setup
    const cancelSetup = () => {
        if (setupAbortController.current) {
            setupAbortController.current.abort("abort the connection setup");
            setupAbortController.current = null;
        }
    };

    // Setup config auto-trigger.
    // We only auto-trigger if we need a platform switch
    const autoTriggersAt = React.useMemo<Date | null>(() => {
        if (canExecuteHere) {
            return null;
        } else {
            return new Date(now.getTime() + AUTO_TRIGGER_DELAY);
        }
    }, []);
    const [remainingUntilAutoTrigger, setRemainingUntilAutoTrigger] = React.useState<number | null>(() => {
        if (autoTriggersAt == null) {
            return null;
        } else {
            return Math.max(autoTriggersAt.getTime(), now.getTime()) - now.getTime();
        }
    });

    // Configure an autotrigger for the setup
    React.useEffect(() => {
        if (autoTriggersAt == null) {
            return;
        }
        logger.info("setup config auto-trigger", { "remaining": formatHHMMSS(remainingUntilAutoTrigger! / 1000) }, LOG_CTX);
        const timeoutId = setTimeout(startSetup, remainingUntilAutoTrigger!);
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

    // Do we have connector params?
    // Then render them in a dedicated section.
    const sections: React.ReactElement[] = [];
    if (connectionParams) {
        sections.push(
            <ConnectionParamsSection
                key={sections.length}
                params={connectionParams}
                updateParams={setConnectionParams}
            />);
    }

    // Do we need to switch to native?
    // Render a warning, information where to get the app and a button to switch.
    if (!canExecuteHere) {
        const workbookProto = new proto.sqlynx_workbook.pb.Workbook({
            ...props.setupProto,
            connectorParams: connectionParams == null ? undefined : encodeConnectionParams(connectionParams)
        });
        const workbookURL = encodeWorkbookAsUrl(workbookProto, WorkbookLinkTarget.NATIVE);

        sections.push(
            <div key={sections.length} className={baseStyles.card_section}>
                <div className={baseStyles.section_entries}>
                    <div className={baseStyles.section_description}>
                        This connector can only be used in the native app
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
                            value={workbookURL.toString()}
                            aria-label="copy-deeplink"
                            aria-labelledby=""
                        />
                        <Button
                            variant={ButtonVariant.Primary}
                            leadingVisual={DesktopDownloadIcon}
                            trailingVisual={remainingUntilAutoTrigger && !setupStarted ? () =>
                                <div>{Math.floor(remainingUntilAutoTrigger / 1000)}</div> : undefined}
                            onClick={() => {
                                const link = document.createElement('a');
                                link.href = workbookURL.toString();
                                logger.info(`opening deep link`, { "href": link.href });
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
        // Get the connection error (if any)
        const connectionError: DetailedError | null = getConnectionError(connection?.details ?? null);
        // Resolve the connect button
        let connectButton: React.ReactElement = <div />;
        switch (connection.connectionHealth) {
            case ConnectionHealth.NOT_STARTED:
                connectButton = (
                    <Button
                        variant={ButtonVariant.Primary}
                        onClick={startSetup}
                        trailingVisual={remainingUntilAutoTrigger && !setupStarted ? () =>
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
                        {connectionError?.message &&
                            <ErrorDetailsButton className={connStyles.status_error} error={connectionError} />
                        }
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

    // Compute the log button only once to prevent svg flickering
    const logButton = React.useMemo(() => {
        return (
            <IconButton
                variant="invisible"
                icon={() => (
                    <svg width="16px" height="16px">
                        <use xlinkHref={`${symbols}#log`} />
                    </svg>
                )}
                aria-label="close-overlay"
                onClick={() => setShowLogs(s => !s)}
            />
        );
    }, []);

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
                                Setup {connection.connectorInfo.displayName.long}
                            </div>
                            <div className={baseStyles.card_header_right_container}>
                                <LogViewerOverlay
                                    isOpen={showLogs}
                                    onClose={() => setShowLogs(false)}
                                    renderAnchor={(p: object) => <div {...p}>{logButton}</div>}
                                    side={AnchorSide.OutsideBottom}
                                    align={AnchorAlignment.End}
                                    anchorOffset={16}
                                    overlayProps={{
                                        width: OverlaySize.L,
                                        height: OverlaySize.M
                                    }}
                                />
                                <IconButton
                                    variant="invisible"
                                    icon={XIcon}
                                    aria-label="close-setup"
                                    onClick={() => props.onDone()}
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
