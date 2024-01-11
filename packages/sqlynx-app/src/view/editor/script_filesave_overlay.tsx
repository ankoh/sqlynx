import React from 'react';

import { AnchoredOverlay, Box, IconButton } from '@primer/react';
import { DownloadIcon, FileIcon } from '@primer/octicons-react';

import styles from './script_filesave_overlay.module.css';
import classNames from 'classnames';

interface Props {
    className?: string;
    isOpen: boolean;
    setIsOpen: (v: boolean) => void;
}

export const ScriptFileSaveOverlay: React.FC<Props> = (props: Props) => {
    const anchorRef = React.createRef<HTMLDivElement>();
    const buttonRef = React.createRef<HTMLAnchorElement>();
    return (
        <AnchoredOverlay
            renderAnchor={() => <div ref={anchorRef} />}
            open={props.isOpen}
            onClose={() => props.setIsOpen(false)}
            anchorRef={anchorRef}
            align="end"
            overlayProps={{
                initialFocusRef: buttonRef,
            }}
        >
            <Box className={classNames(styles.filesave_overlay, props.className)}>
                <div className={styles.filesave_file_icon_container}>
                    <FileIcon className={styles.filesave_file_icon} />
                </div>
                <div className={styles.filesave_file_info}>
                    <div className={styles.filesave_file_name}>query.sql</div>
                    <div className={styles.filesave_file_stats}>~&nbsp;123&nbsp;KB</div>
                </div>
                <div className={styles.filesave_download}>
                    <IconButton
                        ref={buttonRef}
                        className={styles.filesave_button}
                        icon={DownloadIcon}
                        aria-labelledby="save-file"
                    />
                </div>
            </Box>
        </AnchoredOverlay>
    );
};
