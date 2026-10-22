import * as React from 'react';

import * as styles from './connection_settings_overlay.module.css';
import { AnchoredOverlay } from '../../../ui/foundations/anchored_overlay.js';
import { AnchorAlignment, AnchorSide } from '../../../ui/foundations/anchored_position.js';
import { OverlaySize } from '../../../ui/foundations/overlay.js';
import { Button, ButtonSize, ButtonVariant, IconButton } from '../../../ui/foundations/button.js';
import { SymbolIcon } from '../../../ui/foundations/symbol_icon.js';
import { ConnectorType } from '../connector_info.js';
import { findSessionsForConnection, useConnectionById, useConnectionRegistrySelector, useConnectionDraft } from '../connection_registry.js';
import { failedSessionCopies, useConnectionSave, type ConnectionSaveResult } from '../connection_persistence.js';
import { stringifyError } from '../../../platform/logger/logger.js';
import { ConnectionHealth, type ConnectionState } from '../connection_state.js';
import { HyperConnectorSettings } from './hyper_connection_settings.js';
import { TrinoConnectorSettings } from './trino_connection_settings.js';
import { SalesforceConnectorSettings } from './salesforce_connection_settings.js';

const UndoIcon = SymbolIcon('undo_16');

interface Props {
    /// The connection to configure
    connectionId: string | null;
    isOpen: boolean;
    onClose: () => void;
    anchorRef: React.RefObject<HTMLElement | null>;
    headerTitle?: string;
    onConnected?: (database: ConnectionState) => void;
    side?: AnchorSide;
    /// Renders the name of a session, the session id if absent
    renderSessionName?: (sessionId: string) => React.ReactNode;
}

export const ConnectionSettingsOverlay: React.FC<Props> = (props: Props) => {
    const [conn, _modifyConn] = useConnectionById(props.connectionId);
    const { paramsDraft, discard } = useConnectionDraft(props.connectionId);
    const { saving, result: saveResult, save, retry } = useConnectionSave(props.connectionId);
    const connecting = conn?.connectionHealth === ConnectionHealth.CONNECTING;

    const currentConnectorType = conn?.connectorInfo.connectorType ?? ConnectorType.HYPER;

    const completedDatabaseId = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!props.isOpen || conn?.connectionHealth !== ConnectionHealth.ONLINE || props.onConnected == null) return;
        if (completedDatabaseId.current === conn.connectionId) return;
        completedDatabaseId.current = conn.connectionId;
        void props.onConnected(conn);
    }, [conn, props.isOpen, props.onConnected]);
    React.useEffect(() => {
        if (!props.isOpen) completedDatabaseId.current = null;
    }, [props.isOpen]);

    // Saving writes every session that references the connection, the overlay stays open until all
    // writes are done.
    const onClose = props.onClose;
    const close = React.useCallback(() => {
        if (!saving) onClose();
    }, [saving, onClose]);

    const headerActions = <>
        <IconButton
            variant={ButtonVariant.Invisible}
            aria-label="Discard Changes"
            title="Discard changes and restore saved connection settings"
            disabled={paramsDraft == null || connecting || saving}
            onClick={discard}
        ><UndoIcon /></IconButton>
        <Button
            variant={ButtonVariant.Primary}
            size={ButtonSize.Small}
            aria-label="Save Connection"
            title="Save the connection settings for every session that uses the connection"
            disabled={paramsDraft == null || connecting || saving}
            onClick={() => { void save(); }}
        >{saving ? 'Saving…' : 'Save'}</Button>
    </>;

    return (
        <AnchoredOverlay
            renderAnchor={null}
            anchorRef={props.anchorRef as React.RefObject<HTMLElement | null>}
            open={props.isOpen}
            onClose={close}
            side={props.side ?? AnchorSide.OutsideRight}
            align={AnchorAlignment.Start}
            minWidth={OverlaySize.L}
            maxWidth={OverlaySize.XXL}
            height={OverlaySize.XL}
            maxHeight={OverlaySize.XL}
        >
            <div className={styles.overlay_container}>
                <div className={styles.content}>
                    {currentConnectorType === ConnectorType.HYPER && <HyperConnectorSettings connectionId={props.connectionId} headerActions={headerActions} onClose={saving ? undefined : props.onClose} />}
                    {currentConnectorType === ConnectorType.TRINO && <TrinoConnectorSettings connectionId={props.connectionId} headerActions={headerActions} onClose={saving ? undefined : props.onClose} />}
                    {currentConnectorType === ConnectorType.SALESFORCE_DATA_CLOUD && <SalesforceConnectorSettings connectionId={props.connectionId} headerActions={headerActions} onClose={saving ? undefined : props.onClose} />}
                </div>
                <ConnectionSaveFooter
                    connectionId={props.connectionId}
                    dirty={paramsDraft != null}
                    saving={saving}
                    result={saveResult}
                    retry={retry}
                    renderSessionName={props.renderSessionName}
                />
            </div>
        </AnchoredOverlay>
    );
};

interface FooterProps {
    /// The connection
    connectionId: string | null;
    /// Are there unsaved edits?
    dirty: boolean;
    /// Is the connection being saved?
    saving: boolean;
    /// The outcome of the last save
    result: ConnectionSaveResult | null;
    /// Write the copies of sessions again
    retry: (sessionIds: string[]) => Promise<ConnectionSaveResult | null>;
    /// Renders the name of a session
    renderSessionName?: (sessionId: string) => React.ReactNode;
}

/// The sessions that use the connection and the outcome of saving it
function ConnectionSaveFooter(props: FooterProps): React.ReactElement | null {
    const connectionId = props.connectionId;
    const sessionIds = useConnectionRegistrySelector(React.useCallback(
        registry => connectionId == null ? '' : findSessionsForConnection(registry, connectionId).join(','),
        [connectionId],
    ));
    const sessionCount = sessionIds === '' ? 0 : sessionIds.split(',').length;
    const label = props.renderSessionName ?? ((sessionId: string) => sessionId);

    if (props.result != null && !props.saving && props.result.manifest.status !== 'written') {
        const reason = props.result.manifest.status === 'failed' ? stringifyError(props.result.manifest.error) : 'storage is busy';
        return (
            <div className={styles.footer} role="alert">
                <div className={styles.footer_error}>The connection could not be saved: {reason}</div>
            </div>
        );
    }
    const failed = props.result == null ? [] : failedSessionCopies(props.result);
    if (failed.length > 0 && !props.saving) {
        return (
            <div className={styles.footer} role="alert">
                <div className={styles.footer_error}>
                    The connection is saved, but {failed.length === 1 ? 'one session' : `${failed.length} sessions`} could not be updated.
                    They are updated when they are loaded next time.
                    <ul className={styles.footer_list}>
                        {failed.map(n => (
                            <li key={n.sessionId}>
                                {label(n.sessionId)}: {n.result.status === 'failed' ? stringifyError(n.result.error) : 'storage is busy'}
                            </li>
                        ))}
                    </ul>
                </div>
                <Button
                    size={ButtonSize.Small}
                    onClick={() => { void props.retry(failed.map(n => n.sessionId)); }}
                >Retry</Button>
            </div>
        );
    }
    if (sessionCount <= 1 && !props.saving) {
        return null;
    }
    return (
        <div className={styles.footer}>
            <div className={styles.footer_notice}>
                {props.saving
                    ? `Saving the connection for ${sessionCount === 1 ? 'one session' : `${sessionCount} sessions`}…`
                    : `Used by ${sessionCount} sessions.${props.dirty ? ' Saving applies the changes to all of them.' : ''}`}
            </div>
        </div>
    );
}
