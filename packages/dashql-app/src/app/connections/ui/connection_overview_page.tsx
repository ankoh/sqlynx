import * as React from 'react';
import symbols from '@ankoh/dashql-svg-symbols';

import { ButtonSize, ButtonVariant, IconButton } from '../../../ui/foundations/button.js';
import { SymbolIcon } from '../../../ui/foundations/symbol_icon.js';
import { useConnectionReferences, useConnectionRegistry } from '../connection_registry.js';
import { connectionLabelParts, connectionLabelText, connectionOrdinals } from './connection_label.js';
import { ConnectionLabelView } from './connection_label_view.js';
import * as styles from './connection_overview_page.module.css';

const CloseIcon = SymbolIcon('x_16');

interface Props {
    /// The id of the connection
    connectionId: string;
    /// Close the overview
    onClose: () => void;
}

/// The operational overview of a connection.
/// Closes itself once the connection is deleted.
export const ConnectionOverviewPage: React.FC<Props> = ({ connectionId, onClose }) => {
    const [registry] = useConnectionRegistry();
    const references = useConnectionReferences();
    const connection = registry.connections.get(connectionId) ?? null;
    React.useEffect(() => {
        if (connection == null) onClose();
    }, [connection == null, onClose]);
    if (connection == null) return null;
    const label = connectionLabelParts(connection, connectionOrdinals(registry, references).get(connectionId) ?? null);
    const labelText = connectionLabelText(label);
    return (
        <div className={styles.container}>
            <section className={styles.card} aria-label={`Overview of ${labelText}`}>
                <header className={styles.header}>
                    <svg width="16" height="16" aria-hidden="true">
                        <use xlinkHref={`${symbols}#${connection.connectorInfo.icons.colored}`} />
                    </svg>
                    <h2 className={styles.title}>
                        <ConnectionLabelView parts={label} />
                        <span className={styles.title_separator}>/</span>
                        <span>Overview</span>
                    </h2>
                    <IconButton
                        size={ButtonSize.Small}
                        variant={ButtonVariant.Invisible}
                        aria-label={`Close overview of ${labelText}`}
                        onClick={onClose}
                    >
                        <CloseIcon size={16} />
                    </IconButton>
                </header>
                <div className={styles.body} />
            </section>
        </div>
    );
};
