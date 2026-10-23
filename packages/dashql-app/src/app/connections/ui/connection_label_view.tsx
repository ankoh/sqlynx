import * as React from 'react';
import * as styles from './connection_label_view.module.css';

import type { ConnectionLabelParts } from './connection_label.js';
import { Tag } from '../../../ui/foundations/tag.js';

/// The label of a connection, the protocol follows the connector name as a small muted tag
export function ConnectionLabelView(props: { parts: ConnectionLabelParts }): React.ReactElement {
    const { name, detail } = props.parts;
    return (
        <span className={styles.label}>
            <span className={styles.name}>{name}</span> <ConnectionProtocolTag detail={detail} />
        </span>
    );
}

/// The protocol of a connection as a tag, e.g. "wasm"
export function ConnectionProtocolTag(props: { detail: string }): React.ReactElement {
    return <Tag className={styles.detail}>{props.detail}</Tag>;
}
