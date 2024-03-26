import * as React from 'react';
import { motion } from "framer-motion"

import { createPortal } from 'react-dom';

import styles from './log_viewer.module.css';

interface LogViewerProps {
    onClose: () => void;
}

export const LogViewer: React.FC<LogViewerProps> = (props: LogViewerProps) => {
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
                className={styles.overlay_body}
                initial={{ translateY: "20px" }}
                animate={{ translateY: 0 }}
                transition={{ duration: 0.2 }}
            >
                <div className={styles.header_container}>
                    <div className={styles.header_left_container}>
                        <div className={styles.page_title}>Logs</div>
                    </div>
                </div>
            </motion.div>
        </div>
    );
}

const element = document.getElementById('root');

export const LogViewerInPortal = (props: LogViewerProps) => createPortal(<LogViewer {...props} />, element!);
