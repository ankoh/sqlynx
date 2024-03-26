import * as React from 'react';
import { motion } from "framer-motion"

import { createPortal } from 'react-dom';
import { VariableSizeGrid as Grid } from 'react-window';
import { IconButton } from '@primer/react';
import { XIcon } from '@primer/octicons-react';

import { LogLevel, getLogLevelName } from '../platform/log_buffer.js';
import { useLogger } from '../platform/logger_provider.js';
import { observeSize } from './size_observer.js';

import styles from './log_viewer.module.css';

interface LevelCellProps {
    level: LogLevel;
    style?: React.CSSProperties;
}
export const LevelCell: React.FC<LevelCellProps> = (props: LevelCellProps) => {
    const level = getLogLevelName(props.level);
    return (
        <div className={styles.cell_level} style={props.style}>
            {level}
        </div>
    );
}

interface TimestampCellProps {
    style?: React.CSSProperties;
    children: number;
}
export const TimestampCell: React.FC<TimestampCellProps> = (props: TimestampCellProps) => {
    console.log(props);
    return (
        <div className={styles.cell_timestamp} style={props.style}>
            {(new Date(props.children)).toLocaleTimeString()}
        </div>
    );
}

interface TargetCellProps {
    style?: React.CSSProperties;
    children: string;
}
export const TargetCell: React.FC<TargetCellProps> = (props: TargetCellProps) => {
    return (
        <div className={styles.cell_target} style={props.style}>
            {props.children}
        </div>
    );
}

interface MessageCellProps {
    style?: React.CSSProperties;
    children: string;
}
export const MessageCell: React.FC<MessageCellProps> = (props: MessageCellProps) => {
    return (
        <div className={styles.cell_message} style={props.style}>
            {props.children}
        </div>
    );
}

interface LogViewerProps {
    onClose: () => void;
}

const COLUMN_TIMESTAMP_WIDTH = 64;
const COLUMN_LEVEL_WIDTH = 48;
const COLUMN_TARGET_WIDTH = 96;
const ROW_HEIGHT = 28;

export const LogViewer: React.FC<LogViewerProps> = (props: LogViewerProps) => {
    const logger = useLogger();
    const logRowCount = logger.buffer.length;

    // Determine log container dimensions
    const logContainerRef = React.useRef<HTMLDivElement>(null);
    const logContainerSize = observeSize(logContainerRef);
    const logContainerWidth = logContainerSize?.width ?? 0;
    const logContainerHeight = logContainerSize?.height ?? 0;

    const columnWidthLeftOfMessage = Math.max(logContainerWidth, COLUMN_TIMESTAMP_WIDTH + COLUMN_LEVEL_WIDTH + COLUMN_TARGET_WIDTH + 3);
    const columnWidths = React.useMemo(() => ([COLUMN_TIMESTAMP_WIDTH, COLUMN_LEVEL_WIDTH, COLUMN_TARGET_WIDTH, columnWidthLeftOfMessage - COLUMN_TIMESTAMP_WIDTH - COLUMN_LEVEL_WIDTH - COLUMN_TARGET_WIDTH]), [logContainerWidth]);
    const getColumnWidth = (col: number) => columnWidths[col];
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

    const gridRef = React.useRef<Grid>(null);
    const scrollToBottom = () =>
        gridRef?.current?.scrollToItem({ rowIndex: logRowCount });
    React.useEffect(() => {
        scrollToBottom();
    }, [logRowCount]);

    const Cell = ({ columnIndex, rowIndex, style }: any) => {
        const record = logger.buffer.at(rowIndex)!;
        switch (columnIndex) {
            case 0: return <TimestampCell style={style}>{record.timestamp}</TimestampCell>;
            case 1: return <LevelCell level={record.level} style={style} />;
            case 2: return <TargetCell style={style}>{record.target}</TargetCell>;
            case 3: return <MessageCell style={style}>{record.message}</MessageCell>;
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
                className={styles.overlay_card}
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
                        columnCount={4}
                        columnWidth={getColumnWidth}
                        rowCount={logRowCount}
                        rowHeight={getRowHeight}
                        estimatedColumnWidth={logContainerWidth / 4}
                        estimatedRowHeight={ROW_HEIGHT}
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
