import * as React from 'react';
import * as styles from './internals_viewer.module.css';

import { XIcon } from '@primer/octicons-react';
import { IconButton } from '@primer/react';
import { Button } from '../view/foundations/button.js';

import { AnchoredOverlay } from './foundations/anchored_overlay.js';
import { AnchorAlignment, AnchorSide } from './foundations/anchored_position.js';
import { AppConfig, useAppConfig, useAppReconfigure } from '../app_config.js';

interface VersionViewerProps {
    onClose: () => void;
}

export const InternalsViewer: React.FC<VersionViewerProps> = (props: VersionViewerProps) => {
    const config = useAppConfig();
    const reconfigure = useAppReconfigure();
    const toggleDebugMode = React.useCallback(() => {
        reconfigure({
            map: (value: AppConfig) => ({
                ...value,
                settings: {
                    ...value.settings,
                    interfaceDebugMode: !value.settings?.interfaceDebugMode,
                }
            }),
            reject: (_err: Error) => { }
        });
        props.onClose();
    }, []);
    const interfaceDebugMode = config.value?.settings?.interfaceDebugMode ?? false;

    return (
        <div className={styles.overlay}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.title}>Internals</div>
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
            <div className={styles.internals_container}>
                <div className={styles.settings_container}>
                    <div className={styles.setting_name}>
                        Debug Mode
                    </div>
                    <div className={styles.setting_switch}>
                        <Button onClick={toggleDebugMode}>
                            {interfaceDebugMode ? "Disable" : "Enable"}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}

type InternalsViewerOverlayProps = {
    isOpen: boolean;
    onClose: () => void;
    renderAnchor: (p: object) => React.ReactElement;
    side?: AnchorSide;
    align?: AnchorAlignment;
    anchorOffset?: number;
}
export function InternalsViewerOverlay(props: InternalsViewerOverlayProps) {
    return (
        <AnchoredOverlay
            open={props.isOpen}
            onClose={props.onClose}
            renderAnchor={props.renderAnchor}
            side={props.side}
            align={props.align}
            anchorOffset={props.anchorOffset}
        >
            <InternalsViewer onClose={props.onClose} />
        </AnchoredOverlay>
    );
}
