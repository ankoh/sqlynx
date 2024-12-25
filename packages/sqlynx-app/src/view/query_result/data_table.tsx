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
const COLUMN_HEADER_ACTION_WIDTH = 24;
const COLUMN_HEADER_HEIGHT = 32;
const COLUMN_HEADER_PLOTS_HEIGHT = 72;
const ROW_HEIGHT = 26;
const ROW_HEADER_WIDTH = 48;
const FORMATTER_PIXEL_SCALING = 10;
const OVERSCAN_ROW_COUNT = 30;

const SHOW_METADATA_COLUMNS = false;

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

interface GridLayout {
    columnCount: number;
    columnFields: Uint32Array;
    columnOffsets: Float64Array;
    columnSummaryIds: Int32Array;
    isMetadataColumn: Uint8Array;
}

function computeGridLayout(formatter: ArrowTableFormatter, state: TableComputationState, showMetaColumns: boolean): GridLayout {
    // Allocate column offsets
    let columnCount = computeColumnCount(state.columnGroups, showMetaColumns);
    const columnFields = new Uint32Array(columnCount);
    const columnOffsets = new Float64Array(columnCount + 1);
    const columnSummaryIndex = new Int32Array(columnCount);
    const isMetadataColumn = new Uint8Array(columnCount);

    for (let i = 0; i < columnCount; ++i) {
        columnSummaryIndex[i] = -1;
    }

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
                    COLUMN_HEADER_ACTION_WIDTH + Math.max(
                        valueColumn.getLayoutInfo().valueAvgWidth,
                        valueColumn.getColumnName().length) * FORMATTER_PIXEL_SCALING,
                    MIN_COLUMN_WIDTH
                );
                columnFields[valueColumnId] = columnGroup.value.inputFieldId;
                columnOffsets[valueColumnId] = nextDisplayOffset;
                columnSummaryIndex[valueColumnId] = groupIndex;
                nextDisplayOffset += valueColumnWidth;
                if (showMetaColumns && columnGroup.value.binField != null) {
                    const idColumnId = nextDisplayColumn++;
                    const idColumn = formatter.columns[columnGroup.value.binField];
                    const idColumnWidth = Math.max(
                        COLUMN_HEADER_ACTION_WIDTH + Math.max(
                            idColumn.getLayoutInfo().valueAvgWidth,
                            idColumn.getColumnName().length) * FORMATTER_PIXEL_SCALING,
                        MIN_COLUMN_WIDTH
                    );
                    columnFields[idColumnId] = columnGroup.value.binField;
                    columnOffsets[idColumnId] = nextDisplayOffset;
                    isMetadataColumn[idColumnId] = 1;
                    nextDisplayOffset += idColumnWidth;
                }
                break;
            case STRING_COLUMN:
            case LIST_COLUMN: {
                const valueColumnId = nextDisplayColumn++;
                const valueColumn = formatter.columns[columnGroup.value.inputFieldId];
                const valueColumnWidth = Math.max(
                    COLUMN_HEADER_ACTION_WIDTH + Math.max(
                        valueColumn.getLayoutInfo().valueAvgWidth,
                        valueColumn.getColumnName().length) * FORMATTER_PIXEL_SCALING,
                    MIN_COLUMN_WIDTH
                );
                columnFields[valueColumnId] = columnGroup.value.inputFieldId;
                columnOffsets[valueColumnId] = nextDisplayOffset;
                columnSummaryIndex[valueColumnId] = groupIndex;
                nextDisplayOffset += valueColumnWidth;
                if (showMetaColumns && columnGroup.value.valueIdField != null) {
                    const idColumnId = nextDisplayColumn++;
                    const idColumn = formatter.columns[columnGroup.value.valueIdField];
                    const idColumnWidth = Math.max(
                        COLUMN_HEADER_ACTION_WIDTH + Math.max(
                            idColumn.getLayoutInfo().valueAvgWidth,
                            idColumn.getColumnName().length) * FORMATTER_PIXEL_SCALING,
                        MIN_COLUMN_WIDTH
                    );
                    columnFields[idColumnId] = columnGroup.value.valueIdField;
                    columnOffsets[idColumnId] = nextDisplayOffset;
                    isMetadataColumn[idColumnId] = 1;
                    nextDisplayOffset += idColumnWidth;
                }
                break;
            }
        }
    }
    columnOffsets[nextDisplayColumn] = nextDisplayOffset;

    return {
        columnCount,
        columnFields,
        columnOffsets,
        columnSummaryIds: columnSummaryIndex,
        isMetadataColumn
    };
}

function skipGridLayoutUpdate(old: GridLayout, next: GridLayout) {
    if (old.columnOffsets.length != next.columnOffsets.length) {
        return false;
    }
    for (let i = 0; i < old.columnOffsets.length; ++i) {
        const delta = next.columnOffsets[i] - old.columnOffsets[i];
        if (delta > 0.01) {
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
        console.log(`NEW TABLE`);
        return new ArrowTableFormatter(table.schema, table.batches);
    }, [table]);

    // Determine grid dimensions and column widths
    const [gridLayout, setGridLayout] = React.useState<GridLayout>({
        columnCount: 0,
        columnFields: new Uint32Array(),
        columnOffsets: new Float64Array([0]),
        columnSummaryIds: new Int32Array(),
        isMetadataColumn: new Uint8Array(),
    });
    React.useEffect(() => {
        if (tableFormatter) {
            const newGridLayout = computeGridLayout(tableFormatter, computationState, SHOW_METADATA_COLUMNS);
            if (!skipGridLayoutUpdate(gridLayout, newGridLayout)) {
                console.log("NEW GRID Layout")
                setGridLayout(newGridLayout);
            }
        }
    }, [
        gridLayout,
        computationState.columnGroups,
        tableFormatter,
    ]);

    // Compute helper to resolve a cell location
    const gridCellLocation = React.useMemo<GridCellLocation>(() => ({
        getRowHeight,
        getRowOffset,
        getColumnWidth: (column: number) => gridLayout.columnOffsets[column + 1] - gridLayout.columnOffsets[column],
        getColumnOffset: (column: number) => gridLayout.columnOffsets[column],
    }), [gridLayout]);

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
        if (cellProps.columnIndex >= gridLayout.columnFields.length) {
            return <div />;
        }
        if (cellProps.rowIndex == 0) {
            if (cellProps.columnIndex == 0) {
                return <div className={styles.header_corner_cell} style={cellProps.style}></div>;
            } else {
                const fieldId = gridLayout.columnFields[cellProps.columnIndex];
                return (
                    <div
                        className={classNames(styles.header_cell, {
                            [styles.header_metadata_cell]: gridLayout.isMetadataColumn[cellProps.columnIndex] == 1
                        })}
                        style={cellProps.style}
                    >
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
            let columnSummary: ColumnSummaryVariant | null = null;
            let columnSummaryStatus: TaskStatus | null = null;
            const columnSummaryId = gridLayout.columnSummaryIds[cellProps.columnIndex];
            if (columnSummaryId != -1) {
                columnSummary = computationState.columnGroupSummaries[columnSummaryId];
                columnSummaryStatus = computationState.columnGroupSummariesStatus[columnSummaryId];
            }

            if (cellProps.columnIndex == 0) {
                return <div className={styles.plots_corner_cell} style={cellProps.style} />;
            } else if (columnSummary == null) {
                return <div className={classNames(styles.plots_cell, styles.plots_empty_cell)} style={cellProps.style} />;
            } else {
                const tableSummary = computationState.tableSummary;
                if (tableSummary == null) {
                    return (
                        <div className={styles.plots_cell} style={cellProps.style}>
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
            const columnFieldId = gridLayout.columnFields[cellProps.columnIndex];
            const dataRow = cellProps.rowIndex - headerRowCount;

            if (cellProps.columnIndex == 0) {
                return (
                    <div
                        className={classNames(styles.row_header_cell, {
                            [styles.data_cell_focused_secondary]: dataRow == focusedCells.current?.row
                        })}
                        style={cellProps.style}
                    >
                        {cellProps.rowIndex - headerRowCount}
                    </div>
                );
            } else {

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
                    const formatted = tableFormatter.getValue(dataRow, columnFieldId);
                    const focusedRow = focusedCells.current?.row;
                    const focusedCol = focusedCells.current?.col;
                    if (formatted == null) {
                        return (
                            <div
                                className={classNames(styles.data_cell, styles.data_cell_null, {
                                    [styles.data_cell_focused_primary]: dataRow == focusedRow && columnFieldId == focusedCol,
                                    [styles.data_cell_focused_secondary]: dataRow == focusedRow && columnFieldId != focusedCol,
                                    [styles.data_cell_metadata]: gridLayout.isMetadataColumn[cellProps.columnIndex] == 1,
                                })}
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
                                className={classNames(styles.data_cell, {
                                    [styles.data_cell_focused_primary]: dataRow == focusedRow && columnFieldId == focusedCol,
                                    [styles.data_cell_focused_secondary]: dataRow == focusedRow && columnFieldId != focusedCol,
                                    [styles.data_cell_metadata]: gridLayout.isMetadataColumn[cellProps.columnIndex] == 1,
                                })}
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
    }, [
        gridLayout,
        computationState.columnGroupSummaries,
        computationState.columnGroupSummariesStatus
    ]);

    // Inner grid element type to render sticky row and column headers
    const innerGridElementType = useStickyRowAndColumnHeaders(Cell, gridCellLocation, styles.data_grid_cells, headerRowCount);

    // Listen to rendering events to check if the column widths changed.
    // Table elements are formatted lazily so we do not know upfront how wide a column will be.
    const onItemsRendered = React.useCallback((_event: GridOnItemsRenderedProps) => {
        if (dataGrid.current && tableFormatter) {
            const newGridColumns = computeGridLayout(tableFormatter, computationState, SHOW_METADATA_COLUMNS);
            if (!skipGridLayoutUpdate(gridLayout, newGridColumns)) {
                setGridLayout(newGridColumns);
            }
        }
    }, [gridLayout, tableFormatter]);

    return (
        <div className={classNames(styles.root, props.className)} ref={gridContainerElement}>
            <Grid
                ref={dataGrid}
                columnCount={gridLayout.columnCount}
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
