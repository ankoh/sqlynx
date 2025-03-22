import * as pb from '@ankoh/dashql-protobuf';
import * as React from 'react';
import { IconButton } from '@primer/react';
import { BookIcon, ChecklistIcon, DesktopDownloadIcon, FileBadgeIcon, KeyIcon, PackageIcon, PlugIcon, XIcon } from '@primer/octicons-react';

import * as symbols from '../../../static/svg/symbols.generated.svg';
import * as baseStyles from '../banner_page.module.css';
import * as connStyles from './connection_settings.module.css';

import { AnchorAlignment, AnchorSide } from '../foundations/anchored_position.js';
import { Button, ButtonSize, ButtonVariant } from '../foundations/button.js';
import { ConnectionHealth } from '../../connection/connection_state.js';
import { HYPER_GRPC_CONNECTOR, requiresSwitchingToNative, SALESFORCE_DATA_CLOUD_CONNECTOR, TRINO_CONNECTOR } from '../../connection/connector_info.js';
import { CopyToClipboardButton } from '../../utils/clipboard.js';
import { IndicatorStatus, StatusIndicator } from '../foundations/status_indicator.js';
import { KeyValueTextField, TextField, VALIDATION_WARNING } from '../foundations/text_field.js';
import { DASHQL_VERSION } from '../../globals.js';
import { VersionInfoOverlay } from '../version_viewer.js';
import { encodeWorkbookProtoAsUrl, WorkbookLinkTarget } from '../../workbook/workbook_export_url.js';
import { formatHHMMSS } from '../../utils/format.js';
import { getConnectionError, getConnectionHealthIndicator, getConnectionStatusText } from '../../view/connection/salesforce_connector_settings.js';
import { useConnectionState } from '../../connection/connection_registry.js';
import { useLogger } from '../../platform/logger_provider.js';
import { useSalesforceSetup } from '../../connection/salesforce/salesforce_connector.js';
import { useTrinoSetup } from '../../connection/trino/trino_connector.js';
import { ErrorDetailsButton } from '../error_details.js';
import { DetailedError } from '../../utils/error.js';
import { ConnectionParamsVariant, encodeConnectionParamsAsProto, readConnectionParamsFromProto } from '../../connection/connection_params.js';
import { ValueListBuilder } from '../foundations/value_list.js';
import { InternalsViewerOverlay } from '../internals_overlay.js';

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
                <div className={baseStyles.card_body_sections}>
                    <div className={baseStyles.card_section}>
                        <div className={baseStyles.section_entries}>
                            <TextField
                                name="Endpoint"
                                value={props.params.value.channelArgs.endpoint ?? ""}
                                leadingVisual={() => <div>URL</div>}
                                logContext={LOG_CTX}
                                validation={
                                    (props.params.value.authParams.username.length ?? 0) == 0
                                        ? { type: VALIDATION_WARNING, value: "Endpoint is empty" }
                                        : undefined
                                }
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
                                validation={
                                    (props.params.value.authParams.username.length ?? 0) == 0
                                        ? { type: VALIDATION_WARNING, value: "Username is empty" }
                                        : undefined
                                }
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
                                validation={
                                    (props.params.value.authParams.secret.length ?? 0) == 0
                                        ? { type: VALIDATION_WARNING, value: "Secret is empty" }
                                        : undefined
                                }
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
                    <div className={baseStyles.card_section}>
                        <div className={baseStyles.section_entries}>
                            <TextField
                                name="Catalog"
                                value={props.params.value.catalogName ?? ""}
                                leadingVisual={BookIcon}
                                validation={
                                    (props.params.value.catalogName.length ?? 0) == 0
                                        ? { type: VALIDATION_WARNING, value: "Catalog is empty" }
                                        : undefined
                                }
                                logContext={LOG_CTX}
                                onChange={(e) => props.updateParams({
                                    type: TRINO_CONNECTOR,
                                    value: {
                                        ...p,
                                        catalogName: e.target.value
                                    }
                                })}
                            />
                            <ValueListBuilder
                                title="Schemas"
                                valueIcon={() => <BookIcon />}
                                addButtonLabel="Add Header"
                                elements={props.params.value.schemaNames}
                                modifyElements={(action) => props.updateParams({
                                    type: TRINO_CONNECTOR,
                                    value: {
                                        ...p,
                                        schemaNames: action(p.schemaNames)
                                    }
                                })}
                            />
                        </div>
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
    /// The connection id
    connectionId: number;
    /// The connection params
    connectionParams: pb.dashql.connection.ConnectionParams;
    /// The proto of the workbook where this connection is used.
    /// This is necessary to generate links with workbook data when switching platforms.
    workbookProto: pb.dashql.workbook.Workbook;
    /// The done callback
    onDone: () => void;
}

export const ConnectionSetupPage: React.FC<Props> = (props: Props) => {
    const now = new Date();
    const logger = useLogger();
    const salesforceSetup = useSalesforceSetup();
    const trinoSetup = useTrinoSetup();

    const [showLogs, setShowLogs] = React.useState<boolean>(false);
    const [showVersionOverlay, setShowVersionOverlay] = React.useState<boolean>(false);

    // Resolve a connection id for the workbook
    const [maybeConn, dispatchConnection] = useConnectionState(props.connectionId);
    const connection = maybeConn!;
    const [connectionParams, setConnectionParams] = React.useState<ConnectionParamsVariant | null>(() => props.connectionParams ? readConnectionParamsFromProto(props.connectionParams) : null);

    // Need to switch to native?
    // Some connectors only run in the native app.
    let canExecuteHere = connection.connectorInfo ? !requiresSwitchingToNative(connection.connectorInfo) : true;

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
        const workbookProto = new pb.dashql.workbook.Workbook({
            ...props.workbookProto,
            connectionParams: connectionParams == null ? undefined : encodeConnectionParamsAsProto(connectionParams)
        });

        // Cannot execute here? Then redirect the user
        if (!canExecuteHere) {
            const link = document.createElement('a');
            link.href = encodeWorkbookProtoAsUrl(workbookProto, WorkbookLinkTarget.NATIVE).toString();
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
    }, [props.connectionParams]);

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

    // Get the workbook url
    const getWorkbookUrl = () => {
        const workbookProto = new pb.dashql.workbook.Workbook({
            ...props.workbookProto,
            connectionParams: connectionParams == null ? undefined : encodeConnectionParamsAsProto(connectionParams)
        });
        const url = encodeWorkbookProtoAsUrl(workbookProto, WorkbookLinkTarget.NATIVE);
        return url.toString();
    }

    // Do we need to switch to native?
    // Render a warning, information where to get the app and a button to switch.
    if (!canExecuteHere) {
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
                            getValue={getWorkbookUrl}
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
                                link.href = getWorkbookUrl();
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

        // Encode the workbook url
        const workbookProto = new pb.dashql.workbook.Workbook({
            ...props.workbookProto,
            connectionParams: connectionParams == null ? undefined : encodeConnectionParamsAsProto(connectionParams)
        });
        const workbookURL = encodeWorkbookProtoAsUrl(workbookProto, WorkbookLinkTarget.NATIVE);

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
                    <CopyToClipboardButton
                        variant={ButtonVariant.Default}
                        size={ButtonSize.Medium}
                        logContext={LOG_CTX}
                        value={workbookURL.toString()}
                        aria-label="copy-deeplink"
                        aria-labelledby=""
                    />
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
                        <use xlinkHref={`${symbols}#processor`} />
                    </svg>
                )}
                aria-label="close-overlay"
                onClick={() => setShowLogs(s => !s)}
            />
        );
    }, []);

    // Render the page
    return (
        <div className={baseStyles.page} data-tauri-drag-region>
            <div className={baseStyles.banner_and_content_container} data-tauri-drag-region>
                <div className={baseStyles.banner_container} data-tauri-drag-region>
                    <div className={baseStyles.banner_logo} data-tauri-drag-region>
                        <svg width="100%" height="100%">
                            <use xlinkHref={`${symbols}#dashql`} />
                        </svg>
                    </div>
                    <div className={baseStyles.banner_text_container} data-tauri-drag-region>
                        <div className={baseStyles.banner_title} data-tauri-drag-region>dashql</div>
                        <div className={baseStyles.app_version} data-tauri-drag-region>version {DASHQL_VERSION}</div>
                    </div>
                </div>
                <div className={baseStyles.content_container} data-tauri-drag-region>
                    <div className={baseStyles.card}>
                        <div className={baseStyles.card_header} data-tauri-drag-region>
                            <div className={baseStyles.card_header_left_container}>
                                {connection.connectorInfo.displayName.long}
                            </div>
                            <div className={baseStyles.card_header_right_container}>
                                <InternalsViewerOverlay
                                    isOpen={showLogs}
                                    onClose={() => setShowLogs(false)}
                                    renderAnchor={(p: object) => <div {...p}>{logButton}</div>}
                                    side={AnchorSide.OutsideBottom}
                                    align={AnchorAlignment.End}
                                    anchorOffset={16}
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
