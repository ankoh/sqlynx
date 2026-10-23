import * as React from 'react';

import * as styles from './connection_settings_overlay.module.css';
import { AnchoredOverlay } from '../../../ui/foundations/anchored_overlay.js';
import { AnchorAlignment, AnchorSide } from '../../../ui/foundations/anchored_position.js';
import { OverlaySize } from '../../../ui/foundations/overlay.js';
import { Button, ButtonSize, ButtonVariant } from '../../../ui/foundations/button.js';
import { SymbolIcon } from '../../../ui/foundations/symbol_icon.js';
import { ConnectorType } from '../connector_info.js';
import { useConnectionById, useConnectionDraft, useConnectionReferencesSelector } from '../connection_registry.js';
import { connectionSaveSucceeded, failedSessionCopies, useConnectionSave, type ConnectionSaveResult } from '../connection_persistence.js';
import { stringifyError } from '../../../platform/logger/logger.js';
import { ConnectionHealth, type ConnectionState } from '../connection_state.js';
import { HyperConnectorSettings } from './hyper_connection_settings.js';
import { TrinoConnectorSettings } from './trino_connection_settings.js';
import { SalesforceConnectorSettings } from './salesforce_connection_settings.js';

const CheckIcon = SymbolIcon('check_16');

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

    const connectionId = props.connectionId;
    const sessionIds = useConnectionReferencesSelector(React.useCallback(
        references => connectionId == null ? '' : references.sessionsOf(connectionId).join(','),
        [connectionId],
    ));
    const sessionCount = sessionIds === '' ? 0 : sessionIds.split(',').length;

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
                    {currentConnectorType === ConnectorType.HYPER && <HyperConnectorSettings connectionId={props.connectionId} onClose={saving ? undefined : props.onClose} />}
                    {currentConnectorType === ConnectorType.TRINO && <TrinoConnectorSettings connectionId={props.connectionId} onClose={saving ? undefined : props.onClose} />}
                    {currentConnectorType === ConnectorType.SALESFORCE_DATA_CLOUD && <SalesforceConnectorSettings connectionId={props.connectionId} onClose={saving ? undefined : props.onClose} />}
                </div>
                <ConnectionSaveBar
                    dirty={paramsDraft != null}
                    saving={saving}
                    connecting={connecting}
                    online={conn?.connectionHealth === ConnectionHealth.ONLINE}
                    sessionCount={sessionCount}
                    result={saveResult}
                    save={() => { void save(); }}
                    discard={discard}
                    retry={retry}
                    renderSessionName={props.renderSessionName}
                />
            </div>
        </AnchoredOverlay>
    );
};

/// How long the bar confirms a save
const SAVED_NOTICE_DURATION = 2500;

/// Phrase a number of sessions
function sessions(count: number): string {
    return count === 1 ? 'one session' : `${count} sessions`;
}

export interface ConnectionSaveBarProps {
    /// Are there unsaved edits?
    dirty: boolean;
    /// Is the connection being saved?
    saving: boolean;
    /// Is the connection being set up?
    connecting: boolean;
    /// Is the connection online?
    online: boolean;
    /// The number of sessions that use the connection
    sessionCount: number;
    /// The outcome of the last save
    result: ConnectionSaveResult | null;
    /// Save the edits
    save: () => void;
    /// Discard the edits
    discard: () => void;
    /// Write the copies of sessions again
    retry: (sessionIds: string[]) => Promise<ConnectionSaveResult | null>;
    /// Renders the name of a session
    renderSessionName?: (sessionId: string) => React.ReactNode;
}

/// The unsaved edits of a connection, the actions to save or discard them and the outcome of saving
export function ConnectionSaveBar(props: ConnectionSaveBarProps): React.ReactElement | null {
    const label = props.renderSessionName ?? ((sessionId: string) => sessionId);
    const { saving, result } = props;

    // Confirm a save that finished while the bar is shown
    const [prevSaving, setPrevSaving] = React.useState(saving);
    const [savedResult, setSavedResult] = React.useState<ConnectionSaveResult | null>(null);
    if (prevSaving !== saving) {
        setPrevSaving(saving);
        setSavedResult(!saving && result != null && connectionSaveSucceeded(result) ? result : null);
    }
    React.useEffect(() => {
        if (savedResult == null) return;
        const timer = setTimeout(() => setSavedResult(null), SAVED_NOTICE_DURATION);
        return () => clearTimeout(timer);
    }, [savedResult]);
    const savedNotice = savedResult != null && savedResult === result;

    const draftActions = props.dirty && (
        <div className={styles.footer_actions}>
            <Button
                variant={ButtonVariant.Invisible}
                size={ButtonSize.Small}
                title="Discard changes and restore saved connection settings"
                disabled={props.connecting || saving}
                onClick={props.discard}
            >Discard</Button>
            <Button
                variant={ButtonVariant.Primary}
                size={ButtonSize.Small}
                title="Save the connection settings for every session that uses the connection"
                disabled={props.connecting || saving}
                onClick={props.save}
            >{saving ? 'Saving…' : 'Save'}</Button>
        </div>
    );

    if (result != null && !saving && result.manifest.status !== 'written') {
        const reason = result.manifest.status === 'failed' ? stringifyError(result.manifest.error) : 'storage is busy';
        return (
            <div className={styles.footer} role="alert">
                <div className={styles.footer_error}>The connection could not be saved: {reason}</div>
                {draftActions}
            </div>
        );
    }
    const failed = result == null ? [] : failedSessionCopies(result);
    if (failed.length > 0 && !saving) {
        return (
            <div className={styles.footer} role="alert">
                <div className={styles.footer_error}>
                    The connection is saved, but {sessions(failed.length)} could not be updated.
                    They are updated when they are loaded next time.
                    <ul className={styles.footer_list}>
                        {failed.map(n => (
                            <li key={n.sessionId}>
                                {label(n.sessionId)}: {n.result.status === 'failed' ? stringifyError(n.result.error) : 'storage is busy'}
                            </li>
                        ))}
                    </ul>
                </div>
                <div className={styles.footer_actions}>
                    <Button
                        size={ButtonSize.Small}
                        onClick={() => { void props.retry(failed.map(n => n.sessionId)); }}
                    >Retry</Button>
                    {draftActions}
                </div>
            </div>
        );
    }
    if (saving) {
        return (
            <div className={styles.footer} role="status">
                <div className={styles.footer_notice}>
                    {props.sessionCount > 1 ? `Saving the connection for ${sessions(props.sessionCount)}…` : 'Saving the connection…'}
                </div>
                {draftActions}
            </div>
        );
    }
    if (props.dirty) {
        let hint: string | null = null;
        if (props.online) {
            hint = 'The open connection keeps the previous settings until you reconnect.';
        } else if (!props.connecting) {
            hint = 'Connecting saves them too.';
        }
        return (
            <div className={styles.footer} role="status">
                <div className={styles.footer_notice}>
                    <span className={styles.footer_dirty}>
                        <span className={styles.footer_dirty_dot} aria-hidden="true" />
                        Unsaved changes
                    </span>
                    {props.sessionCount > 1 && ` · applies to ${sessions(props.sessionCount)}`}
                    {hint != null && <div className={styles.footer_hint}>{hint}</div>}
                </div>
                {draftActions}
            </div>
        );
    }
    if (savedNotice) {
        return (
            <div className={styles.footer} role="status">
                <div className={styles.footer_saved}>
                    <CheckIcon />
                    {props.sessionCount > 1 ? `Saved for ${sessions(props.sessionCount)}` : 'Saved'}
                </div>
            </div>
        );
    }
    return null;
}
