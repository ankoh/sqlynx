import * as React from 'react';
import * as arrow from 'apache-arrow';
import { VariableSizeGrid as Grid, GridChildComponentProps, GridOnItemsRenderedProps } from 'react-window';

import { classNames } from '../../utils/classnames.js';

import * as styles from './data_table.module.css';
import { observeSize } from '../foundations/size_observer.js';
import { ArrowTableFormatter } from './arrow_formatter.js';
import { GridCellLocation, useStickyRowAndColumnHeaders } from '../foundations/sticky_grid.js';

interface Props {
    className?: string;
    data: arrow.Table | null;
}

const MIN_GRID_HEIGHT = 200;
const MIN_GRID_WIDTH = 100;
const MIN_COLUMN_WIDTH = 120;
const COLUMN_HEADER_HEIGHT = 24;
const ROW_HEIGHT = 24;
const ROW_HEADER_WIDTH = 48;
const FORMATTER_PIXEL_SCALING = 10;

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

export const DataTable: React.FC<Props> = (props: Props) => {
    const gridContainerElement = React.useRef(null);
    const gridContainerSize = observeSize(gridContainerElement);
    const gridContainerHeight = Math.max(gridContainerSize?.height ?? 0, MIN_GRID_HEIGHT);
    const gridContainerWidth = Math.max(gridContainerSize?.width ?? 0, MIN_GRID_WIDTH);
    const gridRows = 1 + (props.data?.numRows ?? 0);
    const gridColumns = 1 + (props.data?.numCols ?? 0);
    const dataGrid = React.useRef<Grid>(null);

    /// Construct the arrow formatter
    const tableFormatter = React.useMemo(() => {
        if (props.data == null) {
            return;
        }
        return new ArrowTableFormatter(props.data.schema, props.data.batches);
    }, [props.data]);

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
        getRowHeight: (_row: number) => ROW_HEIGHT,
        getRowOffset: (row: number) => row * ROW_HEIGHT,
        getColumnWidth: (column: number) => gridColumnOffsets[column + 1] - gridColumnOffsets[column],
        getColumnOffset: (column: number) => gridColumnOffsets[column],
    }), [gridColumnOffsets]);

    // Rerender grids when the column widths change
    React.useEffect(() => {
        if (dataGrid.current) {
            dataGrid.current.resetAfterColumnIndex(0);
        }
    }, [gridCellLocation]);

    // Helper to render a data cell
    const Cell = (cellProps: GridChildComponentProps) => {
        if (cellProps.rowIndex == 0) {
            if (cellProps.columnIndex == 0) {
                return <div className={styles.header_zero_cell} style={cellProps.style}></div>;
            } else {
                const fieldId = cellProps.columnIndex - 1;
                return (
                    <div className={styles.header_cell} style={cellProps.style}>
                        {props.data!.schema.fields[fieldId].name}
                    </div>
                );
            }
        } else {
            if (cellProps.columnIndex == 0) {
                return (
                    <div className={styles.row_zero_cell} style={cellProps.style}>
                        {cellProps.rowIndex - 1}
                    </div>
                );
            } else {
                if (!tableFormatter) {
                    return (
                        <div className={styles.data_cell} style={cellProps.style} />
                    )
                } else {
                    const dataColumn = cellProps.columnIndex - 1;
                    const dataRow = cellProps.rowIndex - 1;
                    const formatted = tableFormatter.getValue(dataRow, dataColumn);
                    return (
                        <div className={styles.data_cell} style={cellProps.style}>
                            {formatted}
                        </div>
                    );
                }
            }
        }
    };

    // Inner grid element type to render sticky row and column headers
    const innerGridElementType = useStickyRowAndColumnHeaders(Cell, gridCellLocation, styles.data_grid_cells);

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

    // Render an empty div if there's no data
    if (props.data == null) {
        return <div />;
    }

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
            >
                {Cell}
            </Grid>
        </div>
    );
};
