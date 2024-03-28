import * as React from 'react';
import { motion } from "framer-motion"
import { createPortal } from 'react-dom';
import { VariableSizeGrid as Grid } from 'react-window';
import { IconButton } from '@primer/react';
import { XIcon } from '@primer/octicons-react';

import { LogLevel, getLogLevelName } from '../platform/log_buffer.js';
import { useLogger } from '../platform/logger_provider.js';
import { useScrollbarWidth } from '../utils/scrollbar.js';
import { observeSize } from './size_observer.js';

import styles from './log_viewer.module.css';

interface LevelCellProps {
    level: LogLevel;
    style: React.CSSProperties;
    rowIndex: number;
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
    children: number;
    style: React.CSSProperties;
    rowIndex: number;
}
export const TimestampCell: React.FC<TimestampCellProps> = (props: TimestampCellProps) => {
    return (
        <div className={styles.cell_timestamp} style={props.style}>
            {(new Date(props.children)).toLocaleTimeString()}
        </div>
    );
}

interface TargetCellProps {
    children: string;
    style: React.CSSProperties;
    rowIndex: number;
}
export const TargetCell: React.FC<TargetCellProps> = (props: TargetCellProps) => {
    return (
        <div className={styles.cell_target} style={props.style}>
            {props.children}
        </div>
    );
}

interface MessageCellProps {
    children: string;
    style: React.CSSProperties;
    rowIndex: number;
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

const COLUMN_COUNT = 4;
const COLUMN_TIMESTAMP_WIDTH = 64;
const COLUMN_LEVEL_WIDTH = 48;
const COLUMN_TARGET_WIDTH = 128;
const ROW_HEIGHT = 32;

export const LogViewer: React.FC<LogViewerProps> = (props: LogViewerProps) => {
    const logger = useLogger();

    // Determine log container dimensions
    const containerRef = React.useRef<HTMLDivElement>(null);
    const containerSize = observeSize(containerRef);
    const containerWidth = containerSize?.width ?? 200;
    const containerHeight = containerSize?.height ?? 100;

    // Determine column width
    const scrollBarShown = (logger.buffer.length * ROW_HEIGHT) >= containerHeight;
    const scrollBarWidth = useScrollbarWidth();
    const scrollBarWidthIfShown = scrollBarShown ? scrollBarWidth : 0;
    const columnWidthLeftOfMessage = COLUMN_TIMESTAMP_WIDTH + COLUMN_LEVEL_WIDTH + COLUMN_TARGET_WIDTH;
    const columnWidthMessage = Math.max(containerWidth, columnWidthLeftOfMessage + scrollBarWidth) - columnWidthLeftOfMessage - scrollBarWidthIfShown;
    const columnWidths = React.useMemo(() => ([COLUMN_TIMESTAMP_WIDTH, COLUMN_LEVEL_WIDTH, COLUMN_TARGET_WIDTH, columnWidthMessage]), [containerWidth]);
    const getColumnWidth = (col: number) => columnWidths[col];
    const getRowHeight = (_row: number) => ROW_HEIGHT;

    // Poll the log version when the viewer is opened and translate into React state
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


    // Reset the grid styling when container dimensions change or log gets updated
    const gridRef = React.useRef<Grid>(null);
    React.useEffect(() => {
        if (gridRef.current) {
            gridRef.current.resetAfterIndices({
                rowIndex: 0,
                columnIndex: 0,
                shouldForceUpdate: true
            });
        }
    }, [containerWidth, containerHeight]);

    // Detect whenever the log version changes
    const seenLogRows = React.useRef<number>(0);
    React.useEffect(() => {
        if (gridRef.current) {
            const rowCount = logger.buffer.length;
            seenLogRows.current = rowCount;

            // Only tell the grid about the new rows.
            // Note that this relies on the detail that we're currently not flushing out old records.
            gridRef.current.resetAfterIndices({
                rowIndex: Math.max(seenLogRows.current, 1) - 1,
                columnIndex: 0,
                shouldForceUpdate: true
            });

            // Scroll to last row
            gridRef.current.scrollToItem({
                align: 'end',
                rowIndex: Math.max(rowCount, 1) - 1
            });
        }
    }, [logVersion, scrollBarShown, containerHeight]);

    const Cell = ({ columnIndex, rowIndex, style }: any) => {
        const record = logger.buffer.at(rowIndex)!;
        switch (columnIndex) {
            case 0: return <TimestampCell rowIndex={rowIndex} style={style}>{record.timestamp}</TimestampCell>;
            case 1: return <LevelCell rowIndex={rowIndex} level={record.level} style={style} />;
            case 2: return <TargetCell rowIndex={rowIndex} style={style}>{record.target}</TargetCell>;
            case 3: return <MessageCell rowIndex={rowIndex} style={style}>{record.message}</MessageCell>;
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
                        <div className={styles.title}>Logs</div>
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
                <div className={styles.log_grid_container} ref={containerRef}>
                    <Grid
                        ref={gridRef}
                        width={containerWidth}
                        height={containerHeight}
                        columnCount={COLUMN_COUNT}
                        columnWidth={getColumnWidth}
                        rowCount={logger.buffer.length}
                        rowHeight={getRowHeight}
                        estimatedColumnWidth={containerWidth / COLUMN_COUNT}
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
