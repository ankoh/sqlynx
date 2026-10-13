import * as React from 'react';

import * as styles from './connection_settings_overlay.module.css';
import { AnchoredOverlay } from '../../../../ui/foundations/anchored_overlay.js';
import { AnchorAlignment, AnchorSide } from '../../../../ui/foundations/anchored_position.js';
import { OverlaySize } from '../../../../ui/foundations/overlay.js';
import { ButtonVariant, IconButton } from '../../../../ui/foundations/button.js';
import { SymbolIcon } from '../../../../ui/foundations/symbol_icon.js';
import { ConnectorType } from '../connector_info.js';
import { useAttachedDatabaseById, useConnectionDraft } from '../attached_database_registry.js';
import { ConnectionHealth, type AttachedDatabaseState } from '../attached_database_state.js';
import { HyperConnectorSettings } from './hyper_connection_settings.js';
import { TrinoConnectorSettings } from './trino_connection_settings.js';
import { SalesforceConnectorSettings } from './salesforce_connection_settings.js';

const UndoIcon = SymbolIcon('undo_16');

interface Props {
    databaseId: string | null;
    isOpen: boolean;
    onClose: () => void;
    anchorRef: React.RefObject<HTMLElement | null>;
    headerTitle?: string;
    onConnected?: (database: AttachedDatabaseState) => void;
    side?: AnchorSide;
}

export const ConnectionSettingsOverlay: React.FC<Props> = (props: Props) => {
    const [conn, _modifyConn] = useAttachedDatabaseById(props.databaseId);
    const { paramsDraft, discard } = useConnectionDraft(props.databaseId);

    const currentConnectorType = conn?.connectorInfo.connectorType ?? ConnectorType.HYPER;

    const completedDatabaseId = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!props.isOpen || conn?.connectionHealth !== ConnectionHealth.ONLINE || props.onConnected == null) return;
        if (completedDatabaseId.current === conn.databaseId) return;
        completedDatabaseId.current = conn.databaseId;
        void props.onConnected(conn);
    }, [conn, props.isOpen, props.onConnected]);
    React.useEffect(() => {
        if (!props.isOpen) completedDatabaseId.current = null;
    }, [props.isOpen]);

    const headerActions = <IconButton
        variant={ButtonVariant.Invisible}
        aria-label="Discard Changes"
        title="Discard changes and restore saved connection settings"
        disabled={paramsDraft == null || conn?.connectionHealth === ConnectionHealth.CONNECTING}
        onClick={discard}
    ><UndoIcon /></IconButton>;

    return (
        <AnchoredOverlay
            renderAnchor={null}
            anchorRef={props.anchorRef as React.RefObject<HTMLElement | null>}
            open={props.isOpen}
            onClose={props.onClose}
            side={props.side ?? AnchorSide.OutsideRight}
            align={AnchorAlignment.Start}
            minWidth={OverlaySize.L}
            maxWidth={OverlaySize.XXL}
            height={OverlaySize.XL}
            maxHeight={OverlaySize.XL}
        >
            <div className={styles.overlay_container}>
                <div className={styles.content}>
                    {currentConnectorType === ConnectorType.HYPER && <HyperConnectorSettings databaseId={props.databaseId} headerActions={headerActions} onClose={props.onClose} />}
                    {currentConnectorType === ConnectorType.TRINO && <TrinoConnectorSettings databaseId={props.databaseId} headerActions={headerActions} onClose={props.onClose} />}
                    {currentConnectorType === ConnectorType.SALESFORCE_DATA_CLOUD && <SalesforceConnectorSettings databaseId={props.databaseId} headerActions={headerActions} onClose={props.onClose} />}
                </div>
            </div>
        </AnchoredOverlay>
    );
};
