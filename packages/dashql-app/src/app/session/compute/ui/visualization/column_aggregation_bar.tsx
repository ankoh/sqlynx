import * as React from 'react';

import * as styles from './column_aggregation_bar.module.css';
import { QueryExecutionState } from '../../../../connections/query_execution_state.js';
import { useComputationRegistry } from '../../../../../compute/computation_registry.js';
import { ArrowTableFormatter } from '../../../../../compute/arrow_formatter.js';
import { computeTableLayout, DataTableLayout } from '../query_result/data_table_layout.js';
import { HeaderPlotsCell } from '../query_result/data_table_cell.js';
import { useCrossFilters } from '../query_result/use_cross_filters.js';
import { useAppConfig } from '../../../../config/app_config.js';
import { useLogger } from '../../../../../platform/logger/logger_provider.js';

const COLUMN_HEADER_PLOTS_HEIGHT = 76;
/// Matches COLUMN_HEADER_HEIGHT in data_table.tsx so the name row lines up with the table header.
const COLUMN_NAME_HEIGHT = 32;
/// The aggregation bar always renders plots, so the layout is computed with a single header row.
const HEADER_ROW_COUNT = 2;

interface Props {
    query: QueryExecutionState | null;
    debugMode?: boolean;
}

/// A horizontally-scrollable strip of column aggregation cells shown above the visualization.
///
/// It renders the same per-column histogram / most-frequent plots as the result table header
/// (reusing `HeaderPlotsCell`) and drives the same shared cross-filter selection via
/// `useCrossFilters`. Brushing a histogram here filters the underlying data table, which the
/// visualization renderer then re-renders against.
export function ColumnAggregationBar(props: Props): React.ReactElement | null {
    const [computationState, dispatchComputation] = useComputationRegistry();
    const logger = useLogger();
    const config = useAppConfig();
    const debugMode = props.debugMode ?? (config?.settings?.tableDebugMode ?? false);

    const queryId = props.query?.queryId ?? null;
    const tableComputation = queryId != null ? computationState.tableComputations[queryId] ?? null : null;

    // Measure the available width so the layout can distribute the leftover space across the
    // columns (same fill-to-width behaviour as the data table).
    const rootRef = React.useRef<HTMLDivElement | null>(null);
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const [containerWidth, setContainerWidth] = React.useState(0);
    const [scrollLeft, setScrollLeft] = React.useState(0);
    React.useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        const observer = new ResizeObserver(entries => {
            const width = entries[0]?.contentRect.width ?? 0;
            setContainerWidth(width);
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    // Build the arrow formatter and layout with the SAME util the table uses, so the
    // column -> aggregate index mapping matches exactly.
    const tableFormatter = React.useMemo(() => {
        if (!tableComputation) return null;
        const dataTable = tableComputation.dataTable;
        return new ArrowTableFormatter(dataTable.schema, dataTable.batches, logger);
    }, [tableComputation?.dataTable, logger]);

    // The layout only reads the column groups and the data table, so it is not recomputed on every
    // task step of the table computation.
    const dataTable = tableComputation?.dataTable ?? null;
    const columnGroups = tableComputation?.columnGroups ?? null;
    // The bar does not render the leading row-number column, but the layout still reserves
    // its width. Offset the container width by that reserved width so the data columns we DO
    // render fill the whole bar.
    const rowNumberWidth = React.useMemo<number | null>(() => {
        if (!tableComputation || !tableFormatter) return null;
        const probe = computeTableLayout(tableFormatter, tableComputation, debugMode, HEADER_ROW_COUNT);
        return probe.columnCount > 0 ? probe.columnXOffsets[1] : 0;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataTable, columnGroups, tableFormatter, debugMode]);
    const gridLayout = React.useMemo<DataTableLayout | null>(() => {
        if (!tableComputation || !tableFormatter || rowNumberWidth == null) return null;
        const effectiveWidth = containerWidth > 0 ? containerWidth + rowNumberWidth : 0;
        return computeTableLayout(tableFormatter, tableComputation, debugMode, HEADER_ROW_COUNT, effectiveWidth);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataTable, columnGroups, tableFormatter, debugMode, containerWidth, rowNumberWidth]);

    // Track the scroll offset at most once per frame, it only decides which plots are mounted
    const hasScrollElement = tableComputation != null && gridLayout != null && gridLayout.columnCount > 0;
    React.useEffect(() => {
        const element = scrollRef.current;
        if (!element) return;
        let frame: number | null = null;
        const updateScrollLeft = () => {
            setScrollLeft(previous => previous === element.scrollLeft ? previous : element.scrollLeft);
        };
        const onScroll = () => {
            if (frame != null) return;
            frame = requestAnimationFrame(() => {
                frame = null;
                updateScrollLeft();
            });
        };
        updateScrollLeft();
        element.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            element.removeEventListener('scroll', onScroll);
            if (frame != null) cancelAnimationFrame(frame);
        };
    }, [hasScrollElement]);

    // The cross-filter controller must be called unconditionally to satisfy the rules of hooks;
    // it no-ops harmlessly when there is no table computation / data frame yet.
    const emptyLayout = React.useMemo<DataTableLayout>(() => ({
        columnCount: 0,
        arrowFieldByColumnIndex: new Uint32Array(),
        columnXOffsets: new Float64Array([0]),
        columnAggregateByColumnIndex: new Int32Array(),
        columnGroupByColumnIndex: new Uint32Array(),
        isSystemColumn: new Uint8Array(),
        isTextColumn: new Uint8Array(),
        headerRowCount: HEADER_ROW_COUNT,
    }), []);
    const controller = useCrossFilters(
        tableComputation,
        dispatchComputation,
        gridLayout ?? emptyLayout,
    );

    if (!tableComputation || !gridLayout || gridLayout.columnCount === 0) {
        return null;
    }

    const viewportLeft = Math.max(0, scrollLeft - containerWidth);
    const viewportRight = scrollLeft + 2 * containerWidth;

    // Skip the leading row-number column (columnIndex 0); render the aggregate plots for the rest.
    const fields = tableComputation.dataTable.schema.fields;
    const cells: React.ReactElement[] = [];
    for (let columnIndex = 1; columnIndex < gridLayout.columnCount; ++columnIndex) {
        const width = gridLayout.columnXOffsets[columnIndex + 1] - gridLayout.columnXOffsets[columnIndex];
        const columnLeft = gridLayout.columnXOffsets[columnIndex] - gridLayout.columnXOffsets[1];
        const columnRight = columnLeft + width;
        const isVisible = columnRight > viewportLeft && columnLeft < viewportRight;
        const fieldId = gridLayout.arrowFieldByColumnIndex[columnIndex];
        const columnName = fields[fieldId]?.name ?? '';
        cells.push(
            <div key={`agg-${columnIndex}`} className={styles.column} style={{ width, flexShrink: 0 }}>
                <div className={styles.column_name} style={{ height: COLUMN_NAME_HEIGHT }} title={columnName}>
                    {columnName}
                </div>
                {isVisible
                    ? <HeaderPlotsCell
                        columnIndex={columnIndex}
                        style={{ width, height: COLUMN_HEADER_PLOTS_HEIGHT, flexShrink: 0 }}
                        gridLayout={gridLayout}
                        columnGroups={tableComputation.columnGroups}
                        columnAggregations={tableComputation.columnAggregates}
                        columnAggregationTasks={tableComputation.tasks.columnAggregationTasks}
                        filteredColumnAggregations={tableComputation.filteredColumnAggregates}
                        filteredColumnAggregationTasks={tableComputation.tasks.filteredColumnAggregationTasks}
                        filteredColumnAggregationOutdated={tableComputation.filteredColumnAggregatesOutdated}
                        tableAggregation={tableComputation.tableAggregation}
                        selectionEpoch={tableComputation.filterTable?.version ?? tableComputation.version}
                        dataSearchRequestId={tableComputation.dataSearchTable?.requestId ?? null}
                        crossFilters={controller.crossFilters}
                        isVisible={true}
                        rightmostVisibleColumn={gridLayout.columnCount - 1}
                        onRequestFilteredColumnAggregation={controller.requestFilteredColumnAggregation}
                        onHistogramFilter={controller.histogramFilter}
                        onBrushingChange={NOOP_BRUSHING}
                        onMostFrequentValueFilter={controller.mostFrequentValueFilter}
                    />
                    : <div style={{ width, height: COLUMN_HEADER_PLOTS_HEIGHT, flexShrink: 0 }} />}
            </div>
        );
    }

    return (
        <div ref={rootRef} className={styles.root}>
            <div ref={scrollRef} className={styles.scroll} style={{ height: COLUMN_HEADER_PLOTS_HEIGHT + COLUMN_NAME_HEIGHT }}>
                {cells}
            </div>
        </div>
    );
}

const NOOP_BRUSHING = () => { };
