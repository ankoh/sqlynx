import * as React from 'react';
import * as connection from '@ankoh/dashql-jsonschema/connection.js';
import symbols from '@ankoh/dashql-svg-symbols';

import * as style from './connection_inline_header.module.css';

import { PlugIcon, XIcon } from '../../../ui/foundations/symbol_icon.js';

import { Button, ButtonVariant, IconButton } from '../../../ui/foundations/button.js';
import { ConnectionHealth, ConnectionState } from '../connection_state.js';
import { ConnectorInfo } from '../connector_info.js';
import { IndicatorStatus, StatusIndicator } from '../../../ui/foundations/status_indicator.js';
import { SegmentedControl } from '../../../ui/foundations/segmented_control.js';
import { getConnectionError, getConnectionHealthIndicator, getConnectionStatusText } from './salesforce_connection_settings.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';

const LOG_CTX = "conn_inline_header";

interface Props {
    connector: ConnectorInfo;
    connection: ConnectionState | null;
    wrongPlatform: boolean;
    setupConnection?: () => void;
    cancelSetup?: () => void;
    resetSetup?: () => void;
    protocol?: connection.HyperProtocol;
    protocols?: connection.HyperProtocol[];
    onProtocolChange?: (protocol: connection.HyperProtocol) => void;
    freezeInput?: boolean;
    embedded?: boolean;
    onClose?: () => void;
    connectorNameAction?: React.ReactNode;
    statusText?: string;
    indicatorStatus?: IndicatorStatus;
    statusError?: string | null;
    connectionHealth?: ConnectionHealth;
}

const PROTOCOL_LABELS: Record<connection.HyperProtocol, string> = {
    WASM: "WASM",
    V3_GRPC: "gRPC",
    V3_HTTP: "HTTP",
};

export function ConnectionInlineHeader(props: Props): React.ReactElement {
    const logger = useLogger();

    // Get the action button.
    // Suppress the header button when no setup/cancel/reset handler is provided.
    const headerActionsProvided = props.setupConnection || props.cancelSetup || props.resetSetup;
    const connectionHealth = props.connectionHealth ?? props.connection?.connectionHealth;
    let connectButton: React.ReactElement = <div />;
    if (headerActionsProvided) {
        switch (connectionHealth) {
            case ConnectionHealth.NOT_STARTED:
            case ConnectionHealth.CANCELLED:
            case ConnectionHealth.FAILED:
                connectButton = (
                    <Button
                        variant={ButtonVariant.Primary}
                        leadingVisual={props.embedded ? undefined : PlugIcon}
                        onClick={props.setupConnection}
                        disabled={props.wrongPlatform || !props.setupConnection}
                    >
                        {props.embedded ? "Select" : "Connect"}
                    </Button>
                );
                break;
            case ConnectionHealth.CONNECTING:
                connectButton = (
                    <Button
                        variant={ButtonVariant.Danger}
                        leadingVisual={XIcon}
                        onClick={props.cancelSetup}
                        disabled={!props.cancelSetup}
                    >
                        Cancel
                    </Button>
                );
                break;
            case ConnectionHealth.ONLINE:
                connectButton = (
                    <Button
                        variant={ButtonVariant.Danger}
                        leadingVisual={XIcon}
                        onClick={props.resetSetup}
                        disabled={!props.resetSetup}
                    >
                        Disconnect
                    </Button>
                );
                break;
        }
    }

    // An open connection keeps its protocol, switching it would replace the settings page underneath it
    const protocolLocked = props.freezeInput
        || connectionHealth === ConnectionHealth.CONNECTING
        || connectionHealth === ConnectionHealth.ONLINE;

    // Get the connection status
    let statusText: string = props.statusText ?? "";
    let indicatorStatus: IndicatorStatus = props.indicatorStatus ?? IndicatorStatus.None;
    if (props.wrongPlatform) {
        statusText = "Connector is unavailable on this platform";
        indicatorStatus = IndicatorStatus.Skip;
    } else if (props.statusText == null && props.indicatorStatus == null) {
        statusText = getConnectionStatusText(props.connection?.connectionStatus, logger);
        indicatorStatus = getConnectionHealthIndicator(props.connection?.connectionHealth ?? null);
    }

    // Get the connection error (if any)
    const connectionError = props.statusError ?? getConnectionError(props.connection?.details ?? null)?.message.toString();

    return (
        <div className={style.container}>
            <div className={style.header_row}>
                <div className={style.connector_info}>
                    <div className={style.connector_icon}>
                        <svg width="20px" height="24px">
                            <use xlinkHref={`${symbols}#${props.connector.icons.colored}`} />
                        </svg>
                    </div>
                    <div className={style.connector_name}>
                        {props.connector.names.displayLong}
                    </div>
                    {props.connectorNameAction}
                </div>
                <div className={style.actions}>
                    {props.protocol !== undefined && props.onProtocolChange && props.protocols && props.protocols.length > 1 && (
                        <div title={protocolLocked ? "Disconnect to switch the protocol" : undefined}>
                            <SegmentedControl
                                aria-label="Attached database protocol"
                                onChange={(index) => {
                                    if (!protocolLocked) props.onProtocolChange!(props.protocols![index]);
                                }}
                            >
                                {props.protocols.map(p => (
                                    <SegmentedControl.Button
                                        key={p}
                                        selected={props.protocol === p}
                                        disabled={protocolLocked}
                                    >
                                        {PROTOCOL_LABELS[p]}
                                    </SegmentedControl.Button>
                                ))}
                            </SegmentedControl>
                        </div>
                    )}
                    {props.onClose && (
                        <IconButton
                            variant={ButtonVariant.Invisible}
                            aria-label="Close"
                            onClick={props.onClose}
                        >
                            <XIcon />
                        </IconButton>
                    )}
                </div>
            </div>
            <div className={style.status_row}>
                {!props.embedded && (
                    <div className={style.status_left}>
                        <div className={style.status_indicator}>
                            <StatusIndicator status={indicatorStatus} />
                        </div>
                        <div className={style.status_text}>
                            {statusText}
                        </div>
                        {connectionError && (
                            <div className={style.status_error}>
                                {connectionError}
                            </div>
                        )}
                    </div>
                )}
                {props.embedded && (
                    <div className={style.embedded_label}>
                        Embedded Engine
                    </div>
                )}
                <div className={style.status_right}>
                    {connectButton}
                </div>
            </div>
        </div>
    );
}
