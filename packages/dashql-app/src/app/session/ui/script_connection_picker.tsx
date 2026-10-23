import * as React from 'react';
import * as styles from './script_connection_picker.module.css';
import symbols from '@ankoh/dashql-svg-symbols';

import { Button, ButtonSize, ButtonVariant } from '../../../ui/foundations/button.js';
import * as ActionList from '../../../ui/foundations/action_list.js';
import { AnchorAlignment, AnchorSide } from '../../../ui/foundations/anchored_position.js';
import { AnchoredOverlay } from '../../../ui/foundations/anchored_overlay.js';
import { DatabaseIcon } from '../../../ui/foundations/symbol_icon.js';
import { ConnectionHealth, type ConnectionState } from '../../connections/connection_state.js';
import type { ConnectorInfo } from '../../connections/connector_info.js';
import {
    resolveSessionConnections,
    useConnectionReferences,
    useConnectionRegistry,
    useConnectionRegistryStore,
} from '../../connections/connection_registry.js';
import { scriptConnectionOf, SET_SCRIPT_CONNECTION } from '../scripts/session_scripts.js';
import type { ModifySessionScripts } from '../scripts/session_scripts_registry.js';
import { CONNECTION_HEALTH_COLORS } from '../../connections/ui/connection_status.js';
import { connectionLabelParts, connectionLabelText, connectionOrdinals, type ConnectionLabelParts } from '../../connections/ui/connection_label.js';
import { ConnectionLabelView, ConnectionProtocolTag } from '../../connections/ui/connection_label_view.js';
import { useSessionScriptsRegistry } from '../scripts/session_scripts_registry.js';
import { listedConnections } from './session_workbench_sidebar.js';

/// The fields of a connection that a script shows
export interface ScriptConnectionView {
    /// The connection id
    connectionId: string;
    /// The health of the connection
    connectionHealth: ConnectionHealth;
    /// The connection details
    details: ConnectionState['details'];
    /// The connector info
    connectorInfo: ConnectorInfo;
    /// The label of the connection as plain text
    label: string;
    /// The parts of the label of the connection
    labelParts: ConnectionLabelParts;
}

/// The view of a connection
export function scriptConnectionView(connection: ConnectionState, labelParts: ConnectionLabelParts = connectionLabelParts(connection)): ScriptConnectionView {
    return {
        connectionId: connection.connectionId,
        connectionHealth: connection.connectionHealth,
        details: connection.details,
        connectorInfo: connection.connectorInfo,
        label: connectionLabelText(labelParts),
        labelParts,
    };
}

/// Run a script of a session on a connection.
/// The session uses the connections of its scripts, the session file and the connection registry
/// follow the script.
export function usePickScriptConnection(_sessionId: string, modifySessionScripts: ModifySessionScripts): (fileName: string, connectionId: string) => void {
    const registryStore = useConnectionRegistryStore();
    return React.useCallback((fileName: string, connectionId: string) => {
        const connection = registryStore.current.connections.get(connectionId);
        if (connection == null) return;
        modifySessionScripts({ type: SET_SCRIPT_CONNECTION, value: { fileName, connection: scriptConnectionOf(connection) } });
    }, [modifySessionScripts, registryStore]);
}

/// A dot in the color of the connection health
function HealthDot(props: { health: ConnectionHealth | null }) {
    return (
        <svg className={styles.health} width="16px" height="16px" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="4" fill={CONNECTION_HEALTH_COLORS[props.health ?? ConnectionHealth.NOT_STARTED]} />
        </svg>
    );
}

interface Props {
    /// The session of the script
    sessionId: string;
    /// The display name of the script
    scriptName: string;
    /// The connection the script runs on, null while it is not registered
    connection: ScriptConnectionView | null;
    /// Picking is disabled, e.g. while the script runs
    disabled: boolean;
    /// Run the script on another connection
    onPick: (connectionId: string) => void;
}

/// Pick the connection that a script is analyzed and executed with
export const ScriptConnectionPicker: React.FC<Props> = (props) => {
    const [open, setOpen] = React.useState(false);
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const label = props.connection?.label ?? 'Unknown connection';
    return (
        <AnchoredOverlay
            open={open}
            onOpen={() => setOpen(true)}
            onClose={() => setOpen(false)}
            side={AnchorSide.OutsideBottom}
            align={AnchorAlignment.End}
            anchorOffset={4}
            anchorRef={triggerRef}
            returnFocusRef={triggerRef}
            renderAnchor={(anchorProps) => (
                <Button
                    {...anchorProps}
                    ref={triggerRef}
                    className={styles.trigger}
                    variant={ButtonVariant.Invisible}
                    size={ButtonSize.Small}
                    disabled={props.disabled}
                    leadingVisual={props.connection == null ? undefined : <DatabaseIcon className={styles.connector_icon} size={14} />}
                    trailingVisual={props.connection == null ? undefined : <ConnectionProtocolTag detail={props.connection.labelParts.detail} />}
                    aria-label={`Connection of ${props.scriptName} script: ${label}`}
                    title={label}
                >
                    <span className={styles.trigger_label}>{props.connection?.labelParts.name ?? label}</span>
                </Button>
            )}
        >
            <ScriptConnectionMenu
                sessionId={props.sessionId}
                scriptName={props.scriptName}
                connectionId={props.connection?.connectionId ?? null}
                onPick={connectionId => {
                    setOpen(false);
                    if (connectionId !== props.connection?.connectionId) props.onPick(connectionId);
                }}
            />
        </AnchoredOverlay>
    );
};

interface MenuProps {
    /// The session of the script
    sessionId: string;
    /// The display name of the script
    scriptName: string;
    /// The connection the script runs on
    connectionId: string | null;
    /// Pick a connection
    onPick: (connectionId: string) => void;
}

/// The connections a script can run on, the connections of the session first.
/// Subscribes to the registries only while it is open.
function ScriptConnectionMenu(props: MenuProps) {
    const [connections] = useConnectionRegistry();
    // Re-render when the sessions use other connections
    const [scripts] = useSessionScriptsRegistry();
    const references = useConnectionReferences();
    const { sessionConnections, otherConnections, ordinals } = React.useMemo(() => {
        const session = resolveSessionConnections(connections, references, props.sessionId);
        const sessionConnections = session == null ? [] : [session.main, ...session.attached];
        const listed = listedConnections(connections, references, sessionConnections);
        return {
            sessionConnections,
            otherConnections: listed.slice(sessionConnections.length),
            ordinals: connectionOrdinals(connections, references),
        };
    }, [connections, references, scripts, props.sessionId]);
    const renderItem = (connection: ConnectionState) => (
        <ActionList.ListItem
            key={connection.connectionId}
            aria-current={connection.connectionId === props.connectionId ? 'true' : undefined}
            onClick={() => props.onPick(connection.connectionId)}
        >
            <ActionList.Leading>
                <svg className={styles.connector_icon} width="16px" height="16px" aria-hidden="true">
                    <use xlinkHref={`${symbols}#${connection.connectorInfo.icons.colored}`} />
                </svg>
            </ActionList.Leading>
            <ActionList.ItemText>
                <ActionList.ItemTextTitle>
                    <ConnectionLabelView parts={connectionLabelParts(connection, ordinals.get(connection.connectionId) ?? null)} />
                </ActionList.ItemTextTitle>
            </ActionList.ItemText>
            <ActionList.Trailing><HealthDot health={connection.connectionHealth} /></ActionList.Trailing>
        </ActionList.ListItem>
    );
    return (
        <div className={styles.menu} role="dialog" aria-label={`Connection of ${props.scriptName} script`}>
            <ActionList.List aria-label={`Connections for ${props.scriptName} script`}>
                {/* The list takes elements only, the fragments wrap the optional groups */}
                <>{sessionConnections.length > 0 && (
                    <>
                        <ActionList.GroupHeading>This session</ActionList.GroupHeading>
                        {sessionConnections.map(renderItem)}
                    </>
                )}</>
                <>{otherConnections.length > 0 && (
                    <>
                        <ActionList.GroupHeading>Other connections</ActionList.GroupHeading>
                        {otherConnections.map(renderItem)}
                    </>
                )}</>
            </ActionList.List>
        </div>
    );
}
