import * as React from 'react';

import { Box, IconButton } from '@primer/react';
import { DownloadIcon, FileIcon } from '@primer/octicons-react';

import { AnchoredOverlay } from '../foundations/anchored_overlay.js';
import { AnchorAlignment } from '../foundations/anchored_position.js';
import { classNames } from '../../utils/classnames.js';

import * as styles from './script_filesave_overlay.module.css';

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
            align={AnchorAlignment.End}
            overlayProps={{
                initialFocusRef: buttonRef,
            }}
        >
            <Box className={classNames(styles.filesave_overlay, props.className)}>
                <div className={styles.filesave_file_icon_container}>
                    <FileIcon />
                </div>
                <div className={styles.filesave_file_info}>
                    <div className={styles.filesave_file_name}>query.sql</div>
                    <div className={styles.filesave_file_stats}>~&nbsp;123&nbsp;KB</div>
                </div>
                <div className={styles.filesave_download}>
                    <IconButton
                        ref={buttonRef}
                        icon={DownloadIcon}
                        aria-labelledby="save-file"
                    />
                </div>
            </Box>
        </AnchoredOverlay>
    );
};
