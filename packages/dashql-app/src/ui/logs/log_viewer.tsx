import * as React from 'react';
import * as styles from './log_viewer.module.css';

import { List, useListCallbackRef } from 'react-window';
import type { RowComponentProps } from 'react-window';
import { XIcon, DownloadIcon } from '../foundations/symbol_icon.js';

import { getLogLevelName, LogRecord } from '../../platform/logger/log_buffer.js';
import { pollLogVersion, useLogger } from '../../platform/logger/logger_provider.js';
import { observeSize } from '../foundations/size_observer.js';
import { ButtonVariant, IconButton } from '../foundations/button.js';
import { AnchorAlignment, AnchorSide } from '../foundations/anchored_position.js';
import { useKeyEvents } from '../../utils/key_events.js';
import { LogJsonModal } from './log_json_modal.js';
import { useFileDownloader } from '../../platform/file/file_downloader_provider.js';
import { VerticalScrollShadows } from '../foundations/vertical_scroll_shadows.js';

export const ROW_HEIGHT = 32;

/// Formatting a timestamp with toLocaleTimeString creates a new formatter for every row
const TIMESTAMP_FORMAT = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
});

export function formatLogTimestamp(timestamp: number): string {
    return TIMESTAMP_FORMAT.format(timestamp);
}

export interface LogRowProps {
    logger: ReturnType<typeof useLogger>;
    showJsonRecord: (rowIndex: number) => void;
    selectedRecordIndex: number;
    filteredLogs?: LogRecord[];
}

export const LogRow = (props: RowComponentProps<LogRowProps>) => {
    const { logger, showJsonRecord, selectedRecordIndex, filteredLogs } = props;
    const rowIndex = props.index;

    // Use filtered logs if provided, otherwise use the full buffer
    let record: LogRecord | null;
    if (filteredLogs) {
        record = filteredLogs[rowIndex] ?? null;
    } else {
        if (rowIndex >= logger.buffer.length) {
            return <div style={props.style} />;
        }
        record = logger.buffer.at(rowIndex);
    }

    if (!record) {
        return <div style={props.style} />;
    }

    const isSelected = rowIndex === selectedRecordIndex;
    return (
        <div
            className={`${styles.log_row} ${isSelected ? styles.log_row_selected : ''}`}
            style={props.style}
            onClick={() => showJsonRecord(rowIndex)}
        >
            <div className={styles.log_row_main}>
                <div className={styles.log_cell_timestamp}>
                    {formatLogTimestamp(record.timestamp)}
                </div>
                <div className={styles.log_cell_level}>
                    {getLogLevelName(record.level)}
                </div>

                <div className={styles.log_cell_message} title={record.message}>
                    {record.message}
                </div>
            </div>
        </div>
    );
};

interface LogViewerProps {
    onClose: () => void;
    traceId?: number;
}

export const LogViewer: React.FC<LogViewerProps> = (props: LogViewerProps) => {
    const logger = useLogger();
    const logVersion = pollLogVersion(100);
    const fileDownloader = useFileDownloader();

    // Maintain filtered log records for trace-specific viewing.
    // We append to a mutable array and bump a version, copying the array per record is quadratic.
    const filteredLogsRef = React.useRef<LogRecord[]>([]);
    const [filteredLogsVersion, setFilteredLogsVersion] = React.useState<number>(0);
    const filteredLogs = filteredLogsRef.current;

    // Track which log record to show in JSON modal (record and index as tuple)
    const [jsonModalState, setJsonModalState] = React.useState<[LogRecord | null, number]>([null, -1]);
    const [jsonModalRecord, jsonModalRecordIndex] = jsonModalState;

    // Close the modal
    const closeRef = React.useRef<HTMLButtonElement>(null);
    const closeJsonModal = React.useCallback(() => {
        setJsonModalState([null, -1]);
    }, []);

    // Download logs as JSON
    const downloadLogs = React.useCallback(async () => {
        try {
            // Collect all logs (either filtered by trace or all logs)
            const logsToExport: LogRecord[] = [];

            if (props.traceId !== undefined) {
                // Export filtered logs for the trace
                logsToExport.push(...filteredLogs);
            } else {
                // Export all logs from the buffer
                const totalLogs = logger.buffer.length;
                for (let i = 0; i < totalLogs; i++) {
                    const record = logger.buffer.at(i);
                    if (record) {
                        logsToExport.push(record);
                    }
                }
            }

            // Convert logs to JSON with pretty printing
            const jsonContent = JSON.stringify(logsToExport, null, 2);
            const encoder = new TextEncoder();
            const uint8Array = encoder.encode(jsonContent);

            // Generate filename with timestamp
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = props.traceId !== undefined
                ? `dashql-logs-trace-${props.traceId}-${timestamp}.json`
                : `dashql-logs-${timestamp}.json`;

            // Download the file
            await fileDownloader.downloadBufferAsFile(uint8Array, filename);
        } catch (error) {
            console.error('Failed to download logs:', error);
        }
    }, [logger, fileDownloader, props.traceId, filteredLogs, filteredLogsVersion]);

    // Subscribe to trace-specific logs if traceId is provided
    React.useEffect(() => {
        if (props.traceId === undefined) {
            return;
        }

        // Get initial logs for this trace
        const initialLogs = logger.buffer.collectTraceLogs(props.traceId);
        filteredLogsRef.current = initialLogs;
        setFilteredLogsVersion(v => v + 1);

        // Subscribe to new logs for this trace
        const observer = (record: LogRecord) => {
            initialLogs.push(record);
            setFilteredLogsVersion(v => v + 1);
        };
        logger.buffer.subscribeTrace(props.traceId, observer);

        // Cleanup subscription
        return () => {
            logger.buffer.unsubscribeTrace(props.traceId!, observer);
        };
    }, [props.traceId, logger]);

    // Determine log container dimensions
    const containerRef = React.useRef<HTMLDivElement>(null);
    const containerSize = observeSize(containerRef);
    const containerWidth = containerSize?.width ?? 200;
    const containerHeight = containerSize?.height ?? 100;

    // Track whether the list is scrolled to the bottom
    const [listApi, setListApi] = useListCallbackRef(null);
    const getScrollElement = React.useCallback(() => listApi?.element ?? null, [listApi]);
    const followTail = React.useRef<boolean>(true);
    React.useEffect(() => {
        const element = listApi?.element;
        if (!element) {
            return;
        }
        const onScroll = () => {
            followTail.current = element.scrollTop + element.clientHeight >= element.scrollHeight - ROW_HEIGHT / 2;
        };
        element.addEventListener('scroll', onScroll, { passive: true });
        return () => element.removeEventListener('scroll', onScroll);
    }, [listApi]);

    // Follow new log rows if the list was at the bottom and no record is inspected
    const isInspectingRecord = jsonModalRecord !== null;
    React.useEffect(() => {
        if (listApi && followTail.current && !isInspectingRecord) {
            const rowCount = props.traceId !== undefined ? filteredLogs.length : logger.buffer.length;

            // Scroll to last row
            listApi.scrollToRow({
                index: Math.max(rowCount, 1) - 1,
                align: 'end',
            });
        }
    }, [logVersion, containerHeight, filteredLogs, filteredLogsVersion, props.traceId, logger, listApi, isInspectingRecord]);

    // Helper to show JSON modal for a log record
    const showJsonRecord = React.useCallback((rowIndex: number) => {
        let record: LogRecord | null;
        if (props.traceId !== undefined) {
            record = filteredLogs[rowIndex] ?? null;
        } else {
            record = logger.buffer.at(rowIndex);
        }
        if (record) {
            setJsonModalState([record, rowIndex]);
        }
    }, [props.traceId, filteredLogs, filteredLogsVersion, logger]);

    // Navigate to previous log record
    const showPreviousRecord = React.useCallback(() => {
        if (jsonModalRecordIndex <= 0) return;
        showJsonRecord(jsonModalRecordIndex - 1);
    }, [jsonModalRecordIndex, showJsonRecord]);

    // Navigate to next log record
    const showNextRecord = React.useCallback(() => {
        const maxIndex = props.traceId !== undefined ? filteredLogs.length - 1 : logger.buffer.length - 1;
        if (jsonModalRecordIndex >= maxIndex) return;
        showJsonRecord(jsonModalRecordIndex + 1);
    }, [jsonModalRecordIndex, showJsonRecord, props.traceId, filteredLogs, filteredLogsVersion, logger]);

    // Keyboard navigation when modal is open
    useKeyEvents(
        jsonModalRecord
            ? [
                {
                    key: 'ArrowUp',
                    callback: (e: KeyboardEvent) => {
                        e.preventDefault();
                        e.stopPropagation();
                        showPreviousRecord();
                    },
                    capture: true,
                },
                {
                    key: 'ArrowDown',
                    callback: (e: KeyboardEvent) => {
                        e.preventDefault();
                        e.stopPropagation();
                        showNextRecord();
                    },
                    capture: true,
                },
            ]
            : []
    );

    // Scroll to the selected row when it changes
    React.useEffect(() => {
        if (jsonModalRecordIndex >= 0 && listApi) {
            listApi.scrollToRow({
                index: jsonModalRecordIndex,
                align: 'center',
            });
        }
    }, [jsonModalRecordIndex, listApi]);

    // Row props passed to the row component
    const rowProps = React.useMemo<LogRowProps>(() => ({
        logger,
        showJsonRecord,
        selectedRecordIndex: jsonModalRecordIndex,
        filteredLogs: props.traceId !== undefined ? filteredLogs : undefined,
    }), [logger, showJsonRecord, jsonModalRecordIndex, props.traceId, filteredLogs, filteredLogsVersion]);

    // Determine row count based on whether we're filtering by trace
    const rowCount = props.traceId !== undefined ? filteredLogs.length : logger.buffer.length;

    return (
        <>
            <div className={styles.overlay} data-electron-drag-region="false">
                <div className={styles.header_container}>
                    <div className={styles.header_left_container}>
                        <div className={styles.title}>
                            {props.traceId !== undefined ? `Logs (Trace ${props.traceId})` : 'Logs'}
                        </div>
                    </div>
                    <div className={styles.header_right_container}>
                        <IconButton
                            variant={ButtonVariant.Invisible}
                            aria-label="Download Logs as JSON"
                            onClick={downloadLogs}
                        >
                            <DownloadIcon />
                        </IconButton>
                        <IconButton
                            ref={closeRef}
                            variant={ButtonVariant.Invisible}
                            aria-label="Close"
                            onClick={props.onClose}
                        >
                            <XIcon />
                        </IconButton>
                    </div>
                </div>
                <div className={styles.log_header_row}>
                    <div className={styles.log_header_main}>
                        <div className={styles.log_header_timestamp}>Time</div>
                        <div className={styles.log_header_level}>Level</div>
                        <div className={styles.log_header_message}>Message</div>
                    </div>
                </div>
                <div className={styles.log_grid_container} ref={containerRef}>
                    <List
                        listRef={setListApi}
                        style={{ width: containerWidth, height: containerHeight }}
                        rowCount={rowCount}
                        rowHeight={ROW_HEIGHT}
                        rowComponent={LogRow}
                        rowProps={rowProps}
                    />
                    <VerticalScrollShadows
                        getScrollElement={getScrollElement}
                        refreshKey={rowCount}
                    />
                </div>
            </div>
            <LogJsonModal
                record={jsonModalRecord}
                recordIndex={jsonModalRecordIndex}
                maxIndex={props.traceId !== undefined ? filteredLogs.length - 1 : logger.buffer.length - 1}
                anchorRef={containerRef}
                returnFocusRef={closeRef}
                align={AnchorAlignment.Start}
                side={AnchorSide.OutsideLeft}
                onClose={closeJsonModal}
                onPrevious={showPreviousRecord}
                onNext={showNextRecord}
            />
        </>
    );
}
