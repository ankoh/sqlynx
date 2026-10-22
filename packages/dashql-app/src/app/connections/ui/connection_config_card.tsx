import * as React from 'react';

import * as baseStyles from '../../../ui/banner/banner_page.module.css';
import * as styles from './connection_config_card.module.css';

import { ChevronLeftIcon } from '../../../ui/foundations/symbol_icon.js';
import { Button, IconButton, ButtonVariant } from '../../../ui/foundations/button.js';
import { ConnectorConfigTabs } from './connector_config_tabs.js';
import { ConnectorType } from '../connector_info.js';
import { useAttachedDatabaseById, useAttachedDatabaseRegistry } from '../attached_database_registry.js';
import { ConnectionHealth } from '../attached_database_state.js';

interface Props {
    sessionId: string;
    onBack: () => void;
    onConnected: (sessionId: string) => void;
    onSkip?: () => void;
    headerTitle?: string;
}

export const ConnectionConfigCard: React.FC<Props> = (props: Props) => {
    const [registry] = useAttachedDatabaseRegistry();
    const databaseId = registry.attachedDatabasesBySession.get(props.sessionId)?.mainDatabaseId ?? null;
    const [conn, _modifyConn] = useAttachedDatabaseById(databaseId);

    // Default to TRINO or first available connector
    const defaultConnectorType = conn?.connectorInfo.connectorType ?? ConnectorType.TRINO;
    const [selectedConnectorType, setSelectedConnectorType] = React.useState<ConnectorType>(defaultConnectorType);

    // Update selected connector when connection changes
    React.useEffect(() => {
        if (conn) {
            setSelectedConnectorType(conn.connectorInfo.connectorType);
        }
    }, [conn?.connectorInfo.connectorType]);

    // Monitor connection health and auto-navigate when ONLINE
    React.useEffect(() => {
        if (conn?.connectionHealth === ConnectionHealth.ONLINE) {
            props.onConnected(props.sessionId);
        }
    }, [conn?.connectionHealth, props.sessionId, props.onConnected]);

    return (
        <div className={`${baseStyles.card} ${styles.card_wrapper}`}>
            <div className={baseStyles.card_header}>
                <div className={baseStyles.card_header_left_container}>
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        aria-label="Back to session list"
                        onClick={props.onBack}
                    >
                        <ChevronLeftIcon size={16} />
                    </IconButton>
                    {props.headerTitle ?? "Configure Attached Database"}
                </div>
                <div className={baseStyles.card_header_right_container}>
                    {props.onSkip && (
                        <Button variant={ButtonVariant.Invisible} onClick={props.onSkip}>
                            Skip
                        </Button>
                    )}
                </div>
            </div>
            <div className={`${baseStyles.card_section} ${styles.card_body}`}>
                <ConnectorConfigTabs
                    className={styles.content_sized_tabs}
                     databaseId={databaseId}
                    selectedConnectorType={selectedConnectorType}
                    setSelectedConnectorType={setSelectedConnectorType}
                    lockConnectorType={!!props.onSkip}
                />
            </div>
        </div>
    );
};
