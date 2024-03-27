import * as React from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from '@primer/react';
import { XIcon } from '@primer/octicons-react';
import { motion } from "framer-motion"

// import { useLogger } from '../platform/logger_provider';

import styles from './version_viewer.module.css';

interface VersionViewerProps {
    onClose: () => void;
}

export const VersionViewer: React.FC<VersionViewerProps> = (props: VersionViewerProps) => {
    // const logger = useLogger();

    return (
        <div className={styles.overlay}>
            <motion.div
                className={styles.overlay_background}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.4 }}
                onClick={props.onClose}
            />
            <motion.div
                className={styles.overlay_card}
                initial={{ translateY: "20px" }}
                animate={{ translateY: 0 }}
                transition={{ duration: 0.2 }}
            >
                <div className={styles.header_container}>
                    <div className={styles.header_left_container}>
                        <div className={styles.page_title}>Version</div>
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
                <div />
            </motion.div>
        </div>
    );
}

const element = document.getElementById('root');

export const VersionViewerInPortal = (props: VersionViewerProps) => createPortal(<VersionViewer {...props} />, element!);
