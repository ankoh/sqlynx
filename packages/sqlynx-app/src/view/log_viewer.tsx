import * as React from 'react';
import { motion } from "framer-motion"

import { createPortal } from 'react-dom';
import { VariableSizeGrid as Grid } from 'react-window';
import { IconButton } from '@primer/react';
import { XIcon } from '@primer/octicons-react';

import { useLogger } from '../platform/logger_provider.js';
import styles from './log_viewer.module.css';
import { observeSize } from './size_observer.js';

interface LogViewerProps {
    onClose: () => void;
}

const COLUMN_0_WIDTH = 100;
const ROW_HEIGHT = 40;

export const LogViewer: React.FC<LogViewerProps> = (props: LogViewerProps) => {
    const logger = useLogger();
    const logRowCount = logger.buffer.length;

    // Determine log container dimensions
    const logContainerRef = React.useRef<HTMLDivElement>(null);
    const logContainerSize = observeSize(logContainerRef);
    const logContainerWidth = logContainerSize?.width ?? 0;
    const logContainerHeight = logContainerSize?.height ?? 0;
    const getColumnWidth = (col: number) => (col == 0) ? COLUMN_0_WIDTH : (Math.max(logContainerWidth, COLUMN_0_WIDTH) - COLUMN_0_WIDTH);
    const getRowHeight = (_row: number) => ROW_HEIGHT;

    // Poll the log version when the viewer is opened
    const [logVersion, setLogVersion] = React.useState<number>(logger.buffer.version);
    React.useEffect(() => {
        let intervalId = setInterval(() => {
            if (logger.buffer.version !== logVersion) {
                setLogVersion(logger.buffer.version);
            }
        }, 100);
        return () => {
            clearInterval(intervalId);
        };
    }, []);

    // Build key for grid refreshes
    const logGridKey = (logContainerWidth & 0xFFFF) | ((logContainerHeight & 0xFFFF) << 16) | ((logVersion & 0xFFFF) << 32);
    console.log(`width=${logContainerWidth}, height=${logContainerHeight}, logGridKey=${logGridKey}`);

    const Cell = ({ columnIndex, rowIndex, style }: any) => {
        const record = logger.buffer.at(rowIndex);
        if (columnIndex == 0) {
            return (
                <div style={style}>
                    {record!.level}
                </div>
            );
        } else {
            return (
                <div style={style}>
                    {record!.message}
                </div>
            );
        }
    };

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
                    <div className={styles.header_right_container}>
                        <IconButton
                            variant="invisible"
                            icon={XIcon}
                            aria-label="close-overlay"
                            onClick={props.onClose}
                        />
                    </div>
                </div>
                <div className={styles.log_grid_container} ref={logContainerRef}>
                    <Grid
                        key={logGridKey}
                        width={logContainerWidth}
                        height={logContainerHeight}
                        columnCount={2}
                        columnWidth={getColumnWidth}
                        rowCount={logRowCount}
                        rowHeight={getRowHeight}
                    >
                        {Cell}
                    </Grid>
                </div>
            </motion.div>
        </div>
    );
}

const element = document.getElementById('root');

export const LogViewerInPortal = (props: LogViewerProps) => createPortal(<LogViewer {...props} />, element!);
