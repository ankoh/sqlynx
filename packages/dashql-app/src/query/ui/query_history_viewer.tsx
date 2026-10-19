import * as React from 'react';
import * as styles from './query_history_viewer.module.css';

import { List, useListCallbackRef } from 'react-window';
import type { ListImperativeAPI, RowComponentProps } from 'react-window';
import { XIcon, ChevronUpIcon, ChevronDownIcon } from '../../ui/foundations/symbol_icon.js';

import { ButtonVariant, IconButton } from '../../ui/foundations/button.js';
import { AnchoredOverlay } from '../../ui/foundations/anchored_overlay.js';
import { OverlaySize } from '../../ui/foundations/overlay.js';
import { AnchorAlignment, AnchorSide } from '../../ui/foundations/anchored_position.js';
import { JsonView } from '../../ui/json/json_view.js';
import { QueryExecutionState, QueryExecutionStatus } from '../query_execution_state.js';
import { observeSize } from '../../ui/foundations/size_observer.js';
import { useKeyEvents } from '../../utils/key_events.js';
import { VerticalScrollShadows } from '../../ui/foundations/vertical_scroll_shadows.js';

export const ROW_HEIGHT = 32;

export enum QueryTarget {
    CONNECTION = 'Attached',
    MEMORY = 'Memory',
}

export function getQueryTarget(query: QueryExecutionState): QueryTarget {
    return query.queryMetadata.userProvided ? QueryTarget.CONNECTION : QueryTarget.MEMORY;
}

export interface QueryEntry {
    connectionId: string;
    sourceName: string;
    target: QueryTarget;
    queryId: number;
    query: QueryExecutionState;
}

function getStatusLabel(status: QueryExecutionStatus): string {
    switch (status) {
        case QueryExecutionStatus.REQUESTED: return 'requested';
        case QueryExecutionStatus.PREPARING: return 'preparing';
        case QueryExecutionStatus.SENDING: return 'sending';
        case QueryExecutionStatus.QUEUED: return 'queued';
        case QueryExecutionStatus.RUNNING: return 'running';
        case QueryExecutionStatus.RECEIVED_FIRST_BATCH: return 'receiving';
        case QueryExecutionStatus.RECEIVED_ALL_BATCHES: return 'received';
        case QueryExecutionStatus.PROCESSING_RESULTS: return 'processing';
        case QueryExecutionStatus.PROCESSED_RESULTS: return 'processed';
        case QueryExecutionStatus.SUCCEEDED: return 'succeeded';
        case QueryExecutionStatus.FAILED: return 'failed';
        case QueryExecutionStatus.CANCELLED: return 'cancelled';
        default: return 'unknown';
    }
}

function entryToObject(entry: QueryEntry): object {
    const q = entry.query;
    const m = q.metrics;
    return {
        queryId: q.queryId,
        traceId: q.traceId,
        status: QueryExecutionStatus[q.status],
        source: entry.sourceName,
        target: entry.target,
        queryText: q.queryText,
        metadata: q.queryMetadata,
        metrics: {
            queryRequestedAt: m.queryRequestedAt?.toISOString() ?? null,
            queryPreparingStartedAt: m.queryPreparingStartedAt?.toISOString() ?? null,
            querySendingStartedAt: m.querySendingStartedAt?.toISOString() ?? null,
            queryQueuedStartedAt: m.queryQueuedStartedAt?.toISOString() ?? null,
            queryRunningStartedAt: m.queryRunningStartedAt?.toISOString() ?? null,
            receivedFirstBatchAt: m.receivedFirstBatchAt?.toISOString() ?? null,
            receivedLastBatchAt: m.receivedLastBatchAt?.toISOString() ?? null,
            receivedAllBatchesAt: m.receivedAllBatchesAt?.toISOString() ?? null,
            processingResultsStartedAt: m.processingResultsStartedAt?.toISOString() ?? null,
            processedResultsAt: m.processedResultsAt?.toISOString() ?? null,
            querySucceededAt: m.querySucceededAt?.toISOString() ?? null,
            queryFailedAt: m.queryFailedAt?.toISOString() ?? null,
            queryCancelledAt: m.queryCancelledAt?.toISOString() ?? null,
            durationMs: m.queryDurationMs,
            progressUpdatesReceived: m.progressUpdatesReceived,
        },
        error: q.error?.message ?? null,
    };
}

interface QueryRowProps {
    entries: QueryEntry[];
    showDetail: (index: number) => void;
    selectedIndex: number;
}

export const QueryRow = (props: RowComponentProps<QueryRowProps>) => {
    const { entries, showDetail, selectedIndex } = props;
    const rowIndex = props.index;
    const entry = entries[rowIndex];

    if (!entry) {
        return <div style={props.style} />;
    }

    const isSelected = rowIndex === selectedIndex;
    const lastUpdatedAt = entry.query.metrics.lastUpdatedAt;
    const time = lastUpdatedAt ? lastUpdatedAt.toLocaleTimeString('en-GB', { hour12: false }) : '—';

    return (
        <div
            className={`${styles.query_row} ${isSelected ? styles.query_row_selected : ''}`}
            style={props.style}
            onClick={() => showDetail(rowIndex)}
        >
            <div className={styles.query_row_main}>
                <div className={styles.query_cell_time}>{time}</div>
                <div className={styles.query_cell_source}>{entry.sourceName}</div>
                <div className={styles.query_cell_target}>{entry.target}</div>
                <div className={styles.query_cell_status}>{getStatusLabel(entry.query.status)}</div>
                <div className={styles.query_cell_title} title={entry.query.queryMetadata.title ?? ''}>
                    {entry.query.queryMetadata.title ?? '—'}
                </div>
            </div>
        </div>
    );
};

export interface QueryHistoryViewerDependencies {
    List: React.ComponentType<any>;
    useListCallbackRef(initialValue: ListImperativeAPI | null): [ListImperativeAPI | null, React.Dispatch<React.SetStateAction<ListImperativeAPI | null>>];
}

const DEFAULT_DEPENDENCIES: QueryHistoryViewerDependencies = {
    List,
    useListCallbackRef,
};

export function QueryHistoryViewer(props: {
    entries: QueryEntry[];
    onClose: () => void;
    dependencies?: QueryHistoryViewerDependencies;
}) {
    const { entries } = props;
    const dependencies = props.dependencies ?? DEFAULT_DEPENDENCIES;
    const ListComponent = dependencies.List;
    // Container dimensions
    const containerRef = React.useRef<HTMLDivElement>(null);
    const containerSize = observeSize(containerRef);
    const containerWidth = containerSize?.width ?? 200;
    const containerHeight = containerSize?.height ?? 100;

    // Detail modal state: [entry | null, index]
    const [modalState, setModalState] = React.useState<[QueryEntry | null, number]>([null, -1]);
    const [modalEntry, modalIndex] = modalState;

    const closeRef = React.useRef<HTMLButtonElement>(null);
    const closeModal = React.useCallback(() => setModalState([null, -1]), []);

    const showDetail = React.useCallback((index: number) => {
        const entry = entries[index] ?? null;
        if (entry) setModalState([entry, index]);
    }, [entries]);

    const showPrevious = React.useCallback(() => {
        if (modalIndex <= 0) return;
        showDetail(modalIndex - 1);
    }, [modalIndex, showDetail]);

    const showNext = React.useCallback(() => {
        if (modalIndex >= entries.length - 1) return;
        showDetail(modalIndex + 1);
    }, [modalIndex, entries.length, showDetail]);

    useKeyEvents(
        modalEntry
            ? [
                {
                    key: 'ArrowUp',
                    callback: (e: KeyboardEvent) => { e.preventDefault(); e.stopPropagation(); showPrevious(); },
                    capture: true,
                },
                {
                    key: 'ArrowDown',
                    callback: (e: KeyboardEvent) => { e.preventDefault(); e.stopPropagation(); showNext(); },
                    capture: true,
                },
            ]
            : []
    );

    // Auto-scroll to bottom when entries change; scroll to selected row when modal opens
    const [listApi, setListApi] = dependencies.useListCallbackRef(null);
    const getScrollElement = React.useCallback(() => listApi?.element ?? null, [listApi]);
    React.useEffect(() => {
        if (modalIndex >= 0 && listApi) {
            listApi.scrollToRow({ index: modalIndex, align: 'center' });
        } else if (listApi && entries.length > 0) {
            listApi.scrollToRow({ index: entries.length - 1, align: 'end' });
        }
    }, [entries, modalIndex, listApi]);

    const rowProps = React.useMemo<QueryRowProps>(() => ({
        entries,
        showDetail,
        selectedIndex: modalIndex,
    }), [entries, showDetail, modalIndex]);

    const modalObject = React.useMemo<object | null>(
        () => modalEntry ? entryToObject(modalEntry) : null,
        [modalEntry]
    );

    return (
        <>
            <div className={styles.overlay}>
                <div className={styles.header_container}>
                    <div className={styles.header_left_container}>
                        <div className={styles.title}>Queries</div>
                    </div>
                    <div className={styles.header_right_container}>
                        <IconButton
                            ref={closeRef}
                            variant={ButtonVariant.Invisible}
                            aria-label="close-overlay"
                            onClick={props.onClose}
                        >
                            <XIcon />
                        </IconButton>
                    </div>
                </div>
                <div className={styles.query_header_row}>
                    <div className={styles.query_header_main}>
                        <div className={styles.query_header_time}>Time</div>
                        <div className={styles.query_header_source}>Source</div>
                        <div className={styles.query_header_target}>Target</div>
                        <div className={styles.query_header_status}>Status</div>
                        <div className={styles.query_header_title}>Title</div>
                    </div>
                </div>
                <div className={styles.query_grid_container} ref={containerRef}>
                    {entries.length === 0 ? (
                        <div className={styles.empty_state}>Nothing to see here</div>
                    ) : (
                        <ListComponent
                            listRef={setListApi}
                            style={{ width: containerWidth, height: containerHeight }}
                            rowCount={entries.length}
                            rowHeight={ROW_HEIGHT}
                            rowComponent={QueryRow}
                            rowProps={rowProps}
                        />
                    )}
                    <VerticalScrollShadows
                        getScrollElement={getScrollElement}
                        refreshKey={entries.length}
                    />
                </div>
            </div>
            <AnchoredOverlay
                renderAnchor={null}
                anchorRef={containerRef}
                returnFocusRef={closeRef}
                open={modalEntry !== null}
                onClose={closeModal}
                width={OverlaySize.L}
                align={AnchorAlignment.Start}
                side={AnchorSide.OutsideLeft}
            >
                <div className={styles.detail_modal}>
                    <div className={styles.detail_modal_main}>
                        <div className={styles.detail_modal_content}>
                            {modalObject && <JsonView value={modalObject} />}
                        </div>
                    </div>
                    <div className={styles.detail_modal_sidebar}>
                        <div className={styles.detail_modal_sidebar_top}>
                            <IconButton
                                variant={ButtonVariant.Invisible}
                                aria-label="Close"
                                onClick={closeModal}
                            >
                                <XIcon />
                            </IconButton>
                        </div>
                        <div className={styles.detail_modal_sidebar_bottom}>
                            <IconButton
                                variant={ButtonVariant.Invisible}
                                aria-label="Previous entry"
                                onClick={showPrevious}
                                disabled={modalIndex <= 0}
                            >
                                <ChevronUpIcon />
                            </IconButton>
                            <IconButton
                                variant={ButtonVariant.Invisible}
                                aria-label="Next entry"
                                onClick={showNext}
                                disabled={modalIndex >= entries.length - 1}
                            >
                                <ChevronDownIcon />
                            </IconButton>
                        </div>
                    </div>
                </div>
            </AnchoredOverlay>
        </>
    );
}
