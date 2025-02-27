import * as React from 'react';
import * as styles from './query_log_viewer.module.css';

import { XIcon } from '@primer/octicons-react';
import { IconButton } from '@primer/react';

import { useConnectionRegistry } from '../../connection/connection_registry.js';

interface Props {
    onClose: () => void;
}


export function QueryLogViewer(props: Props) {
    const connReg = useConnectionRegistry();

    return (
        <div className={styles.overlay}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.title}>Queries</div>
                </div>
                <div className={styles.header_right_container}>
                    <IconButton
                        variant="invisible"
                        icon={XIcon}
                        aria-label="close-overlay"
                        onClick={props.onClose}
                    />
                </div>
            </div>
        </div>
    );
}
