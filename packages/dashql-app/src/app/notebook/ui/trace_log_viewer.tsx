import * as React from 'react';
import * as styles from '../../../ui/logs/log_viewer.module.css';

import { List, useListRef } from 'react-window';

import { LogRecord } from '../../../platform/logger/log_buffer.js';
import { pollLogVersion, useLogger } from '../../../platform/logger/logger_provider.js';
import { observeSize } from '../../../ui/foundations/size_observer.js';
import { AnchorAlignment, AnchorSide } from '../../../ui/foundations/anchored_position.js';
import { useKeyEvents } from '../../../utils/key_events.js';
import { LogJsonModal } from '../../../ui/logs/log_json_modal.js';
import {
    LogRow,
    LogRowProps,
    ROW_HEIGHT,
} from '../../../ui/logs/log_viewer.js';

interface TraceLogViewerProps {
    traceId?: number;
    /// Fixed pixel height of the log viewport. Ignored when `maxRows` or `fill` is set.
    height?: number;
    /// Scrollless preview mode: the viewport auto-expands to fit the current row count and caps at
    /// this many rows. Beyond the cap the inner scrollbar is suppressed and only the last `maxRows`
    /// rows are shown (no nested scroller). Takes precedence over `height`.
    maxRows?: number;
    /// Fill mode: the viewport fills its parent's height (which must be constrained) and scrolls
    /// normally. Used by the Details Status tab, where the log should occupy the full card. Takes
    /// precedence over `height` (but not `maxRows`).
    fill?: boolean;
}

export const TraceLogViewer: React.FC<TraceLogViewerProps> = (props: TraceLogViewerProps) => {
    const logger = useLogger();
    const logVersion = pollLogVersion(100);

    // Maintain filtered log records for trace-specific viewing
    const [filteredLogs, setFilteredLogs] = React.useState<LogRecord[]>([]);

    // Track which log record to show in JSON modal (record and index as tuple)
    const [jsonModalState, setJsonModalState] = React.useState<[LogRecord | null, number]>([null, -1]);
    const [jsonModalRecord, jsonModalRecordIndex] = jsonModalState;

    // Close the modal
    const closeJsonModal = React.useCallback(() => {
        setJsonModalState([null, -1]);
    }, []);

    // Subscribe to trace-specific logs if traceId is provided
    React.useEffect(() => {
        if (props.traceId === undefined) {
            return;
        }

        // Get initial logs for this trace
        const initialLogs = logger.buffer.collectTraceLogs(props.traceId);
        setFilteredLogs(initialLogs);

        // Subscribe to new logs for this trace
        const observer = (record: LogRecord) => {
            setFilteredLogs(prev => [...prev, record]);
        };
        logger.buffer.subscribeTrace(props.traceId, observer);

        // Cleanup subscription
        return () => {
            logger.buffer.unsubscribeTrace(props.traceId!, observer);
        };
    }, [props.traceId, logger]);

    // The number of rows currently displayed.
    const rowCount = props.traceId !== undefined ? filteredLogs.length : logger.buffer.length;

    // Determine log container dimensions. When `maxRows` is set (scrollless preview mode), the
    // viewport auto-expands to fit the current rows (so it grows as logs stream in) and caps at
    // `maxRows` rows; beyond the cap the inner scrollbar is suppressed and the list stays pinned to
    // the last `maxRows` rows (see the scroll-to-last effect below), so the feed's own scroller
    // stays the only one. Otherwise it falls back to the fixed `height` prop and scrolls normally.
    const containerRef = React.useRef<HTMLDivElement>(null);
    const containerSize = observeSize(containerRef);
    const containerWidth = containerSize?.width ?? 200;
    // In fill mode the container stretches to its parent (height: 100%) and the inner list is sized
    // to the measured height so react-window has an explicit pixel viewport to scroll within.
    const containerHeight = props.maxRows != null
        ? Math.min(rowCount, props.maxRows) * ROW_HEIGHT
        : props.fill
            ? (containerSize?.height ?? 0)
            : (props.height ?? 200);

    // Redraw whenever the log version changes or filtered logs change
    const seenLogRows = React.useRef<number>(0);
    const listRef = useListRef(null);
    React.useEffect(() => {
        if (!listRef.current) return;
        seenLogRows.current = rowCount;
        if (rowCount === 0) return;

        // Scroll to the last row. Unlike the modal log viewer, our container height is a fixed
        // prop rather than a measured size, so the effect never re-fires after layout settles.
        // We scroll synchronously and again on the next frame, once react-window has committed the
        // freshly-appended rows, so the view reliably sticks to the bottom as new logs stream in.
        const scrollToLast = () => listRef.current?.scrollToRow({ index: rowCount - 1, align: 'end' });
        scrollToLast();
        const raf = requestAnimationFrame(scrollToLast);
        return () => cancelAnimationFrame(raf);
    }, [logVersion, containerHeight, filteredLogs, props.traceId, logger]);

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
    }, [props.traceId, filteredLogs, logger]);

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
    }, [jsonModalRecordIndex, showJsonRecord, props.traceId, filteredLogs, logger]);

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
                },
                {
                    key: 'ArrowDown',
                    callback: (e: KeyboardEvent) => {
                        e.preventDefault();
                        e.stopPropagation();
                        showNextRecord();
                    },
                },
            ]
            : []
    );

    // Scroll to the selected row when it changes
    React.useEffect(() => {
        if (jsonModalRecordIndex >= 0 && listRef.current) {
            listRef.current.scrollToRow({
                index: jsonModalRecordIndex,
                align: 'center',
            });
        }
    }, [jsonModalRecordIndex]);

    // Row props
    const rowProps = React.useMemo<LogRowProps>(() => ({
        logger,
        showJsonRecord,
        selectedRecordIndex: jsonModalRecordIndex,
        filteredLogs: props.traceId !== undefined ? filteredLogs : undefined,
    }), [logger, showJsonRecord, jsonModalRecordIndex, props.traceId, filteredLogs]);

    return (
        <>
            <div className={styles.log_grid_container} ref={containerRef} style={{ height: props.fill ? '100%' : containerHeight, position: 'relative' }}>
                <List
                    listRef={listRef}
                    // In scrollless preview mode (`maxRows`) the viewport is pinned to the last rows
                    // and the feed's own scroller is the only one, so suppress the inner scrollbar.
                    // Otherwise scroll normally — pass 'auto' explicitly rather than `undefined`, which
                    // would override react-window's default `overflowY: 'auto'` and disable scrolling.
                    style={{ width: containerWidth, height: containerHeight, overflowY: props.maxRows != null ? 'hidden' : 'auto' }}
                    rowCount={rowCount}
                    rowHeight={ROW_HEIGHT}
                    rowComponent={LogRow}
                    rowProps={rowProps}
                />
            </div>
            <LogJsonModal
                record={jsonModalRecord}
                recordIndex={jsonModalRecordIndex}
                maxIndex={props.traceId !== undefined ? filteredLogs.length - 1 : logger.buffer.length - 1}
                anchorRef={containerRef}
                align={AnchorAlignment.Start}
                side={AnchorSide.OutsideLeft}
                onClose={closeJsonModal}
                onPrevious={showPreviousRecord}
                onNext={showNextRecord}
            />
        </>
    );
}
