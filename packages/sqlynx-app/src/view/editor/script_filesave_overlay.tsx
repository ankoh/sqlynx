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
    return (
        <AnchoredOverlay
            renderAnchor={() => <div ref={anchorRef} />}
            open={props.isOpen}
            onClose={() => props.setIsOpen(false)}
            anchorRef={anchorRef}
            align="end"
        >
            <Box className={classNames(styles.filesave_overlay, props.className)}>
                <div className={styles.filesave_title}>Save Query as .sql</div>
                <div className={styles.filesave_file_icon}>
                    <FileIcon />
                </div>
                <div className={styles.filesave_file_info}>
                    <div className={styles.filesave_file_name}></div>
                    <div className={styles.filesave_file_stats}></div>
                </div>
                <div className={styles.filesave_download}>
                    <IconButton className={styles.filesave_button} icon={DownloadIcon} aria-labelledby="save-file" />
                </div>
            </Box>
        </AnchoredOverlay>
    );
};
