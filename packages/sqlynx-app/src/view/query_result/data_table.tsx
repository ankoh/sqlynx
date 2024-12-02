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
import { LIST_COLUMN, ORDINAL_COLUMN, SKIPPED_COLUMN, STRING_COLUMN, TableOrderingTask, TaskStatus } from '../../compute/table_transforms.js';
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
const MIN_COLUMN_WIDTH = 140;
const COLUMN_HEADER_HEIGHT = 32;
const COLUMN_HEADER_PLOTS_HEIGHT = 72;
const ROW_HEIGHT = 26;
const ROW_HEADER_WIDTH = 48;
const FORMATTER_PIXEL_SCALING = 10;
const OVERSCAN_ROW_COUNT = 30;

function computeColumnOffsets(formatter: ArrowTableFormatter, columns: number): Float64Array {
    const offsets = new Float64Array(columns + 1);
    let nextColumnOffset = 0;
    for (let i = 0; i < columns; ++i) {
        offsets[i] = nextColumnOffset;
        if (i == 0) {
            nextColumnOffset += ROW_HEADER_WIDTH;
        } else if ((i - 1) < (formatter.columns.length ?? 0)) {
            const column = formatter.columns[i - 1];
            const columnAvgWidth = column.getLayoutInfo().valueAvgWidth;
            const columnWidth = columnAvgWidth * FORMATTER_PIXEL_SCALING;
            nextColumnOffset += Math.max(columnWidth, MIN_COLUMN_WIDTH);
        } else {
            nextColumnOffset += MIN_COLUMN_WIDTH;
        }
    }
    offsets[columns] = nextColumnOffset;
    return offsets;
}

function columnOffsetsAreEqual(oldWidths: Float64Array, newWidths: Float64Array) {
    if (oldWidths.length != newWidths.length) {
        return false;
    }
    for (let i = 0; i < oldWidths.length; ++i) {
        const delta = newWidths[i] - oldWidths[i];
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
    const gridColumns = 1 + (computationState.dataTableColumns.length ?? 0);
    let gridRows = 1 + (table.numRows ?? 0);

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
            gridRows += 1;
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
    const [gridColumnOffsets, setGridColumnOffsets] = React.useState<Float64Array>(() => {
        if (tableFormatter?.columns) {
            return computeColumnOffsets(tableFormatter, gridColumns);
        } else {
            return new Float64Array();
        }
    });

    // Compute helper to resolve a cell location
    const gridCellLocation = React.useMemo<GridCellLocation>(() => ({
        getRowHeight,
        getRowOffset,
        getColumnWidth: (column: number) => gridColumnOffsets[column + 1] - gridColumnOffsets[column],
        getColumnOffset: (column: number) => gridColumnOffsets[column],
    }), [gridColumnOffsets]);

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

    // Helper to render a data cell
    const Cell = (cellProps: GridChildComponentProps) => {
        if (cellProps.rowIndex == 0) {
            if (cellProps.columnIndex == 0) {
                return <div className={styles.header_zero_cell} style={cellProps.style}></div>;
            } else {
                const fieldId = cellProps.columnIndex - 1;
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
            if (cellProps.columnIndex == 0) {
                return <div className={styles.plots_zero_cell} style={cellProps.style}></div>;
            } else if (cellProps.columnIndex >= (computationState.columnSummaries.length + 1)) {
                return <div className={styles.plots_precomputed_cell} style={cellProps.style}></div>;
            } else {
                const fieldId = cellProps.columnIndex - 1;
                const tableSummary = computationState.tableSummary;
                const columnSummary = computationState.columnSummaries[fieldId];
                const columnStatus = computationState.columnSummariesStatus[fieldId];
                if (tableSummary == null) {
                    return (
                        <div className={classNames(styles.plots_cell)} style={cellProps.style}>
                            Table summary is null
                        </div>
                    );
                }
                switch (columnStatus) {
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
                if (!tableFormatter) {
                    return (
                        <div className={styles.data_cell} style={cellProps.style} />
                    )
                } else {
                    const dataColumn = cellProps.columnIndex - 1;
                    const dataRow = cellProps.rowIndex - headerRowCount;
                    const formatted = tableFormatter.getValue(dataRow, dataColumn);
                    return (
                        <div className={styles.data_cell} style={cellProps.style}>
                            {formatted ?? "NULL"}
                        </div>
                    );
                }
            }
        }
    };

    // Inner grid element type to render sticky row and column headers
    const innerGridElementType = useStickyRowAndColumnHeaders(Cell, gridCellLocation, styles.data_grid_cells, headerRowCount);

    // Listen to rendering events to check if the column widths changed.
    // Table elements are formatted lazily so we do not know upfront how wide a column will be.
    const onItemsRendered = React.useCallback((_event: GridOnItemsRenderedProps) => {
        if (dataGrid.current && tableFormatter) {
            const newWidths = computeColumnOffsets(tableFormatter, gridColumns);
            if (!columnOffsetsAreEqual(gridColumnOffsets, newWidths)) {
                setGridColumnOffsets(newWidths);
            }
        }
    }, [tableFormatter]);

    return (
        <div className={classNames(styles.root, props.className)} ref={gridContainerElement}>
            <Grid
                ref={dataGrid}
                columnCount={gridColumns}
                columnWidth={gridCellLocation.getColumnWidth}
                rowCount={gridRows}
                rowHeight={gridCellLocation.getRowHeight}
                height={gridContainerHeight}
                width={gridContainerWidth}
                onItemsRendered={onItemsRendered}
                innerElementType={innerGridElementType}
                overscanRowCount={OVERSCAN_ROW_COUNT}
            >
                {Cell}
            </Grid>
        </div>
    );
};
