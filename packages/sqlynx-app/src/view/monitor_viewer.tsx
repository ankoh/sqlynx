import * as React from 'react';
import * as styles from './monitor_viewer.module.css';

import { XIcon } from '@primer/octicons-react';
import { IconButton } from '@primer/react';

import { AnchoredOverlay } from './foundations/anchored_overlay.js';
import { AnchorAlignment, AnchorSide } from './foundations/anchored_position.js';

interface VersionViewerProps {
    onClose: () => void;
}

export const Monitor: React.FC<VersionViewerProps> = (props: VersionViewerProps) => {
    return (
        <div className={styles.overlay}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.title}>Monitor</div>
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
            <div className={styles.monitor_viewer_container}>
            </div>
        </div>
    );
}

type MonitorOverlayProps = {
    isOpen: boolean;
    onClose: () => void;
    renderAnchor: (p: object) => React.ReactElement;
    side?: AnchorSide;
    align?: AnchorAlignment;
    anchorOffset?: number;
}
export function MonitorOverlay(props: MonitorOverlayProps) {
    return (
        <AnchoredOverlay
            open={props.isOpen}
            onClose={props.onClose}
            renderAnchor={props.renderAnchor}
            side={props.side}
            align={props.align}
            anchorOffset={props.anchorOffset}
        >
            <Monitor onClose={props.onClose} />
        </AnchoredOverlay>
    );
}
