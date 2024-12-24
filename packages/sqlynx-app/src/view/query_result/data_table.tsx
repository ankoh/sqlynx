import * as React from 'react';
import * as proto from '@ankoh/sqlynx-protobuf';
import * as styles from './data_table.module.css';
import * as symbols from '../../../static/svg/symbols.generated.svg';

import { VariableSizeGrid as Grid, GridChildComponentProps, GridOnItemsRenderedProps } from 'react-window';

import { classNames } from '../../utils/classnames.js';
import { observeSize } from '../foundations/size_observer.js';
import { ButtonSize, ButtonVariant, IconButton } from '../../view/foundations/button.js';
import { ArrowTableFormatter } from './arrow_formatter.js';
import { GridCellLocation, useStickyRowAndColumnHeaders } from '../foundations/sticky_grid.js';
import { ComputationAction, TableComputationState } from '../../compute/computation_state.js';
import { Dispatch } from '../../utils/variant.js';
import { ColumnSummaryVariant, GridColumnGroup, LIST_COLUMN, ORDINAL_COLUMN, ROWNUMBER_COLUMN, SKIPPED_COLUMN, STRING_COLUMN, TableOrderingTask, TaskStatus } from '../../compute/table_transforms.js';
import { sortTable } from '../../compute/computation_actions.js';
import { useLogger } from '../../platform/logger_provider.js';
import { RectangleWaveSpinner } from '../../view/foundations/spinners.js';
import { HistogramCell } from './histogram_cell.js';
import { MostFrequentCell } from './mostfrequent_cell.js';

interface Props {
    className?: string;
    table: TableComputationState;
    dispatchComputation: Dispatch<ComputationAction>;
}

const MIN_GRID_HEIGHT = 200;
const MIN_GRID_WIDTH = 100;
const MIN_COLUMN_WIDTH = 120;
const COLUMN_HEADER_HEIGHT = 32;
const COLUMN_HEADER_PLOTS_HEIGHT = 72;
const ROW_HEIGHT = 26;
const ROW_HEADER_WIDTH = 48;
const FORMATTER_PIXEL_SCALING = 10;
const OVERSCAN_ROW_COUNT = 30;

const SHOW_METADATA_COLUMNS = true;

function computeColumnCount(columnGroups: GridColumnGroup[], showMetaColumns: boolean): number {
    let columnCount = 0;
    for (const columnGroup of columnGroups) {
        switch (columnGroup.type) {
            case ROWNUMBER_COLUMN:
                ++columnCount;
                break;
            case SKIPPED_COLUMN:
                break;
            case STRING_COLUMN:
            case LIST_COLUMN:
                ++columnCount;
                if (showMetaColumns && columnGroup.value.valueIdField != null) {
                    ++columnCount;
                }
                break;
            case ORDINAL_COLUMN:
                ++columnCount;
                if (showMetaColumns && columnGroup.value.binField != null) {
                    ++columnCount;
                }
                break;
        }
    }
    return columnCount;
}

interface GridColumns {
    formatter: ArrowTableFormatter;
    columnCount: number;
    columnFields: Uint32Array;
    columnOffsets: Float64Array;
    columnSummaries: (ColumnSummaryVariant | null)[];
    columnSummariesStatus: (TaskStatus | null)[];
}

function computeGridColumns(formatter: ArrowTableFormatter, state: TableComputationState, showMetaColumns: boolean): GridColumns {
    // Allocate column offsets
    let columnCount = computeColumnCount(state.columnGroups, showMetaColumns);
    const columnFields = new Uint32Array(columnCount);
    const columnOffsets = new Float64Array(columnCount + 1);
    const columnSummaries: (ColumnSummaryVariant | null)[] = new Array(columnCount).fill(null);
    const columnSummariesStatus: (TaskStatus | null)[] = new Array(columnCount).fill(null);

    // Allocate column offsets
    let nextDisplayColumn = 0;
    let nextDisplayOffset = 0;
    for (let groupIndex = 0; groupIndex < state.columnGroups.length; ++groupIndex) {
        const columnGroup = state.columnGroups[groupIndex];
        switch (columnGroup.type) {
            case ROWNUMBER_COLUMN: {
                const columnId = nextDisplayColumn++;
                columnFields[columnId] = columnGroup.value.inputFieldId;
                columnOffsets[columnId] = nextDisplayOffset;
                nextDisplayOffset += ROW_HEADER_WIDTH;
                break;
            }
            case SKIPPED_COLUMN:
                break;
            case ORDINAL_COLUMN:
                const valueColumnId = nextDisplayColumn++;
                const valueColumn = formatter.columns[columnGroup.value.inputFieldId];
                const valueColumnWidth = Math.max(
                    Math.max(valueColumn.getLayoutInfo().valueAvgWidth, valueColumn.getColumnName().length) * FORMATTER_PIXEL_SCALING,
                    MIN_COLUMN_WIDTH
                );
                columnFields[valueColumnId] = columnGroup.value.inputFieldId;
                columnOffsets[valueColumnId] = nextDisplayOffset;
                columnSummaries[valueColumnId] = state.columnGroupSummaries[groupIndex];
                columnSummariesStatus[valueColumnId] = state.columnGroupSummariesStatus[groupIndex];
                nextDisplayOffset += valueColumnWidth;
                if (showMetaColumns && columnGroup.value.binField != null) {
                    const idColumnId = nextDisplayColumn++;
                    const idColumn = formatter.columns[columnGroup.value.binField];
                    const idColumnWidth = Math.max(
                        Math.max(
                            idColumn.getLayoutInfo().valueAvgWidth,
                            idColumn.getColumnName().length) * FORMATTER_PIXEL_SCALING,
                        MIN_COLUMN_WIDTH
                    );
                    columnFields[idColumnId] = columnGroup.value.binField;
                    columnOffsets[idColumnId] = nextDisplayOffset;
                    nextDisplayOffset += idColumnWidth;
                }
                break;
            case STRING_COLUMN:
            case LIST_COLUMN: {
                const valueColumnId = nextDisplayColumn++;
                const valueColumn = formatter.columns[columnGroup.value.inputFieldId];
                const valueColumnWidth = Math.max(
                    Math.max(
                        valueColumn.getLayoutInfo().valueAvgWidth,
                        valueColumn.getColumnName().length) * FORMATTER_PIXEL_SCALING,
                    MIN_COLUMN_WIDTH
                );
                columnFields[valueColumnId] = columnGroup.value.inputFieldId;
                columnOffsets[valueColumnId] = nextDisplayOffset;
                columnSummaries[valueColumnId] = state.columnGroupSummaries[groupIndex];
                columnSummariesStatus[valueColumnId] = state.columnGroupSummariesStatus[groupIndex];
                nextDisplayOffset += valueColumnWidth;
                if (showMetaColumns && columnGroup.value.valueIdField != null) {
                    const idColumnId = nextDisplayColumn++;
                    const idColumn = formatter.columns[columnGroup.value.valueIdField];
                    const idColumnWidth = Math.max(
                        Math.max(
                            idColumn.getLayoutInfo().valueAvgWidth,
                            idColumn.getColumnName().length) * FORMATTER_PIXEL_SCALING,
                        MIN_COLUMN_WIDTH
                    );
                    columnFields[idColumnId] = columnGroup.value.valueIdField;
                    columnOffsets[idColumnId] = nextDisplayOffset;
                    nextDisplayOffset += idColumnWidth;
                }
                break;
            }
        }
    }
    columnOffsets[nextDisplayColumn] = nextDisplayOffset;

    return {
        formatter,
        columnCount,
        columnFields,
        columnOffsets,
        columnSummaries,
        columnSummariesStatus
    };
}

function skipGridColumnUpdate(old: GridColumns, next: GridColumns) {
    if (old.columnOffsets.length != next.columnOffsets.length && old.columnSummaries.length != next.columnSummaries.length) {
        return false;
    }
    for (let i = 0; i < old.columnOffsets.length; ++i) {
        const delta = next.columnOffsets[i] - old.columnOffsets[i];
        if (delta > 0.01) {
            return false;
        }
    }
    for (let i = 0; i < old.columnSummaries.length; ++i) {
        if (next.columnSummaries[i] !== old.columnSummaries[i] || next.columnSummariesStatus[i] !== old.columnSummariesStatus[i]) {
            return false;
        }
    }
    return true;
}

enum DataTableColumnHeader {
    OnlyColumnName = 0,
    WithColumnPlots = 1
}
var columnHeader: DataTableColumnHeader = DataTableColumnHeader.WithColumnPlots;

export const DataTable: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const computationState = props.table;
    const table = computationState.dataTable;
    const dataGrid = React.useRef<Grid>(null);
    const gridContainerElement = React.useRef(null);
    const gridContainerSize = observeSize(gridContainerElement);
    const gridContainerHeight = Math.max(gridContainerSize?.height ?? 0, MIN_GRID_HEIGHT);
    const gridContainerWidth = Math.max(gridContainerSize?.width ?? 0, MIN_GRID_WIDTH);
    let gridRowCount = 1 + (table.numRows ?? 0);

    // Adjust based on the column header visibility
    let getRowHeight: (_row: number) => number;
    let getRowOffset: (row: number) => number;
    let headerRowCount: number;
    switch (columnHeader) {
        case DataTableColumnHeader.OnlyColumnName:
            headerRowCount = 1;
            getRowHeight = (row: number) => (row == 0) ? COLUMN_HEADER_HEIGHT : ROW_HEIGHT;
            getRowOffset = (row: number) => (row > 0 ? COLUMN_HEADER_HEIGHT : 0) + (Math.max(row, 1) - 1) * ROW_HEIGHT;
            break;
        case DataTableColumnHeader.WithColumnPlots:
            headerRowCount = 2;
            gridRowCount += 1;
            getRowHeight = (row: number) => {
                switch (row) {
                    case 0: return COLUMN_HEADER_HEIGHT;
                    case 1: return COLUMN_HEADER_PLOTS_HEIGHT;
                    default: return ROW_HEIGHT
                }
            }
            getRowOffset = (row: number) =>
                (row > 0 ? COLUMN_HEADER_HEIGHT : 0)
                + (row > 1 ? COLUMN_HEADER_PLOTS_HEIGHT : 0)
                + (Math.max(row, 2) - 2) * ROW_HEIGHT;
            break;
    }

    /// Construct the arrow formatter
    const tableFormatter = React.useMemo(() => {
        return new ArrowTableFormatter(table.schema, table.batches);
    }, [table]);

    // Determine grid dimensions and column widths
    const [gridColumns, setGridColumns] = React.useState<GridColumns>({
        formatter: tableFormatter,
        columnCount: 0,
        columnFields: new Uint32Array(),
        columnOffsets: new Float64Array([0]),
        columnSummaries: [],
        columnSummariesStatus: []
    });
    React.useEffect(() => {
        if (tableFormatter) {
            const newGridColumns = computeGridColumns(tableFormatter, computationState, SHOW_METADATA_COLUMNS);
            if (!skipGridColumnUpdate(gridColumns, newGridColumns)) {
                setGridColumns(newGridColumns);
            }
        }
    }, [
        gridColumns,
        computationState.columnGroups,
        computationState.columnGroupSummaries,
        computationState.columnGroupSummariesStatus,
        tableFormatter,
    ]);

    // Compute helper to resolve a cell location
    const gridCellLocation = React.useMemo<GridCellLocation>(() => ({
        getRowHeight,
        getRowOffset,
        getColumnWidth: (column: number) => gridColumns.columnOffsets[column + 1] - gridColumns.columnOffsets[column],
        getColumnOffset: (column: number) => gridColumns.columnOffsets[column],
    }), [gridColumns]);

    // Rerender grids when the column widths change
    React.useEffect(() => {
        if (dataGrid.current) {
            dataGrid.current.resetAfterColumnIndex(0);
        }
    }, [gridCellLocation]);

    // Order by a column
    const dispatchComputation = props.dispatchComputation;
    const orderByColumn = React.useCallback((fieldId: number) => {
        const fieldName = table.schema.fields[fieldId].name;
        const orderingConstraints: proto.sqlynx_compute.pb.OrderByConstraint[] = [
            new proto.sqlynx_compute.pb.OrderByConstraint({
                fieldName: fieldName,
                ascending: true,
                nullsFirst: false,
            })
        ];
        if (computationState.dataFrame) {
            const orderingTask: TableOrderingTask = {
                computationId: computationState.computationId,
                inputDataFrame: computationState.dataFrame,
                orderingConstraints
            };
            sortTable(orderingTask, dispatchComputation, logger);
        }
    }, [computationState, dispatchComputation, logger]);

    const focusedCells = React.useRef<{ row: number | null, col: number | null }>();

    const onMouseEnterCell: React.PointerEventHandler<HTMLDivElement> = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const tableRow = Number.parseInt(event.currentTarget.dataset["tableRow"]!);
        const tableCol = Number.parseInt(event.currentTarget.dataset["tableCol"]!);
        focusedCells.current = { row: tableRow, col: tableCol };
        dataGrid.current?.resetAfterColumnIndex(0);
    }, []);
    const onMouseLeaveCell: React.PointerEventHandler<HTMLDivElement> = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const tableRow = Number.parseInt(event.currentTarget.dataset["tableRow"]!);
        const tableCol = Number.parseInt(event.currentTarget.dataset["tableCol"]!);
        focusedCells.current = { row: tableRow, col: tableCol };
        dataGrid.current?.resetAfterColumnIndex(0);
    }, []);

    // Helper to render a data cell
    const Cell = React.useCallback((cellProps: GridChildComponentProps) => {
        if (cellProps.columnIndex >= gridColumns.columnFields.length) {
            return <div />;
        }
        if (cellProps.rowIndex == 0) {
            if (cellProps.columnIndex == 0) {
                return <div className={styles.header_zero_cell} style={cellProps.style}></div>;
            } else {
                const fieldId = gridColumns.columnFields[cellProps.columnIndex];
                return (
                    <div className={styles.header_cell} style={cellProps.style}>
                        <span className={styles.header_cell_name}>
                            {table.schema.fields[fieldId].name}
                        </span>
                        <span className={styles.header_cell_actions}>
                            <IconButton
                                variant={ButtonVariant.Invisible}
                                size={ButtonSize.Small}
                                aria-label="sort-column"
                                onClick={() => orderByColumn(fieldId)}
                                disabled={computationState.dataFrame == null}
                            >
                                <svg width="16px" height="16px">
                                    <use xlinkHref={`${symbols}#sort_desc_16`} />
                                </svg>
                            </IconButton>
                        </span>
                    </div>
                );
            }
        } else if (cellProps.rowIndex == 1 && columnHeader == DataTableColumnHeader.WithColumnPlots) {
            const columnSummary = gridColumns.columnSummaries[cellProps.columnIndex];
            const columnSummaryStatus = gridColumns.columnSummariesStatus[cellProps.columnIndex];

            if (cellProps.columnIndex == 0) {
                return <div className={styles.plots_zero_cell} style={cellProps.style}></div>;
            } else if (columnSummary == null) {
                return <div className={styles.plots_precomputed_cell} style={cellProps.style}></div>;
            } else {
                const tableSummary = computationState.tableSummary;
                if (tableSummary == null) {
                    return (
                        <div className={classNames(styles.plots_cell)} style={cellProps.style}>
                            Table summary is null
                        </div>
                    );
                }
                switch (columnSummaryStatus) {
                    case TaskStatus.TASK_RUNNING:
                        return (
                            <div className={classNames(styles.plots_cell, styles.plots_progress)} style={cellProps.style}>
                                <RectangleWaveSpinner
                                    className={styles.plots_progress_spinner}
                                    active={true}
                                    color={"rgb(208, 215, 222)"}
                                />
                            </div>
                        );
                    case TaskStatus.TASK_FAILED:
                        return (
                            <div className={styles.plots_cell} style={cellProps.style}>
                                Failed
                            </div>
                        );
                    case TaskStatus.TASK_SUCCEEDED:
                        switch (columnSummary?.type) {
                            case ORDINAL_COLUMN:
                                return (
                                    <div className={styles.plots_cell} style={cellProps.style}>
                                        {<HistogramCell tableSummary={tableSummary} columnSummary={columnSummary} />}
                                    </div>
                                );
                            case LIST_COLUMN:
                            case STRING_COLUMN:
                                return (
                                    <div className={styles.plots_cell} style={cellProps.style}>
                                        {<MostFrequentCell tableSummary={tableSummary} columnSummary={columnSummary} />}
                                    </div>
                                );
                            case SKIPPED_COLUMN: break;
                        }
                }
            }
        } else {
            if (cellProps.columnIndex == 0) {
                return (
                    <div className={styles.row_zero_cell} style={cellProps.style}>
                        {cellProps.rowIndex - headerRowCount}
                    </div>
                );
            } else {
                const columnFieldId = gridColumns.columnFields[cellProps.columnIndex];
                const dataRow = cellProps.rowIndex - headerRowCount;

                if (!tableFormatter) {
                    return (
                        <div
                            className={styles.data_cell}
                            style={cellProps.style}
                            data-table-col={columnFieldId}
                            data-table-row={dataRow}
                            onMouseEnter={onMouseEnterCell}
                            onMouseLeave={onMouseLeaveCell}
                        />
                    )
                } else {
                    let focusClass: undefined | string = undefined;
                    if (dataRow == focusedCells.current?.row) {
                        if (dataRow == focusedCells.current?.row && columnFieldId == focusedCells.current?.col) {
                            focusClass = styles.data_cell_focused_primary;
                        } else {
                            focusClass = styles.data_cell_focused_secondary;
                        }
                    }
                    const formatted = tableFormatter.getValue(dataRow, columnFieldId);
                    if (formatted == null) {
                        return (
                            <div
                                className={classNames(styles.data_cell, styles.data_cell_null, focusClass)}
                                style={cellProps.style}
                                data-table-col={columnFieldId}
                                data-table-row={dataRow}
                                onMouseEnter={onMouseEnterCell}
                                onMouseLeave={onMouseLeaveCell}
                            >
                                NULL
                            </div>
                        );
                    } else {
                        return (
                            <div
                                className={classNames(styles.data_cell, focusClass)}
                                style={cellProps.style}
                                data-table-col={columnFieldId}
                                data-table-row={dataRow}
                                onMouseEnter={onMouseEnterCell}
                                onMouseLeave={onMouseLeaveCell}
                            >
                                {formatted}
                            </div>
                        );
                    }
                }
            }
        }
    }, [gridColumns]);

    // Inner grid element type to render sticky row and column headers
    const innerGridElementType = useStickyRowAndColumnHeaders(Cell, gridCellLocation, styles.data_grid_cells, headerRowCount);

    // Listen to rendering events to check if the column widths changed.
    // Table elements are formatted lazily so we do not know upfront how wide a column will be.
    const onItemsRendered = React.useCallback((_event: GridOnItemsRenderedProps) => {
        if (dataGrid.current && tableFormatter) {
            const newGridColumns = computeGridColumns(tableFormatter, computationState, SHOW_METADATA_COLUMNS);
            if (!skipGridColumnUpdate(gridColumns, newGridColumns)) {
                setGridColumns(newGridColumns);
            }
        }
    }, [gridColumns, tableFormatter]);

    return (
        <div className={classNames(styles.root, props.className)} ref={gridContainerElement}>
            <Grid
                ref={dataGrid}
                columnCount={gridColumns.columnCount}
                columnWidth={gridCellLocation.getColumnWidth}
                rowCount={gridRowCount}
                rowHeight={gridCellLocation.getRowHeight}
                height={gridContainerHeight}
                width={gridContainerWidth}
                onItemsRendered={onItemsRendered}
                overscanRowCount={OVERSCAN_ROW_COUNT}
                innerElementType={innerGridElementType}
            >
                {Cell}
            </Grid>
        </div>
    );
};
