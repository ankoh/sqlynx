import * as React from 'react';
import * as arrow from 'apache-arrow';
import { VariableSizeGrid as Grid, GridChildComponentProps, GridOnItemsRenderedProps, GridOnScrollProps } from 'react-window';

import { classNames } from '../../utils/classnames.js';

import * as styles from './data_table.module.css';
import { observeSize } from '../foundations/size_observer.js';
import { ArrowTableFormatter } from './arrow_formatter.js';

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

function computeColumnWidths(formatter: ArrowTableFormatter, columns: number): Float64Array {
    const widths = new Float64Array(columns);
    for (let i = 0; i < columns; ++i) {
        if (i == 0) {
            widths[i] = ROW_HEADER_WIDTH;
        } else if ((i - 1) < (formatter.columns.length ?? 0)) {
            const column = formatter.columns[i - 1];
            const columnAvgWidth = column.getLayoutInfo().valueAvgWidth;
            const columnWidth = columnAvgWidth * FORMATTER_PIXEL_SCALING;
            widths[i] = Math.max(columnWidth, MIN_COLUMN_WIDTH);
        } else {
            widths[i] = MIN_COLUMN_WIDTH;
        }
    }
    return widths;
}

function columnWidthsAreEqual(oldWidths: Float64Array, newWidths: Float64Array) {
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
    const gridContainerHeight = Math.max(gridContainerSize?.height ?? 0, MIN_GRID_HEIGHT) - COLUMN_HEADER_HEIGHT;
    const gridContainerWidth = Math.max(gridContainerSize?.width ?? 0, MIN_GRID_WIDTH);

    const headerGrid = React.useRef<Grid>(null);
    const dataGrid = React.useRef<Grid>(null);

    /// Construct the arrow formatter
    const tableFormatter = React.useMemo(() => {
        if (props.data == null) {
            return;
        }
        return new ArrowTableFormatter(props.data.schema, props.data.batches);
    }, [props.data]);

    // Determine grid dimensions and column widths
    const gridRows = props.data?.numRows ?? 0;
    const gridColumns = 1 + (props.data?.numCols ?? 0);
    const [gridColumnWidths, setGridColumnWidths] = React.useState<Float64Array>(() => {
        if (tableFormatter?.columns) {
            return computeColumnWidths(tableFormatter, gridColumns);
        } else {
            return new Float64Array();
        }
    });
    const getColumnWidth = (i: number) => gridColumnWidths[i];

    // Rerender grids when the column widths change
    React.useEffect(() => {
        if (headerGrid.current && dataGrid.current) {
            headerGrid.current.resetAfterColumnIndex(0);
            dataGrid.current.resetAfterColumnIndex(0);
        }
    }, [gridColumnWidths]);

    // Helper to render a header cell
    const HeaderCell = (cellProps: GridChildComponentProps) => {
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
    };
    // Helper to render a data cell
    const DataCell = (cellProps: GridChildComponentProps) => {
        if (cellProps.columnIndex == 0) {
            return (
                <div className={styles.row_zero_cell} style={cellProps.style}>
                    {cellProps.rowIndex}
                </div>
            );
        } else {
            if (!tableFormatter) {
                return (
                    <div className={styles.data_cell} style={cellProps.style} />
                )
            } else {
                const dataColumn = cellProps.columnIndex - 1;
                const formatted = tableFormatter.getValue(cellProps.rowIndex, dataColumn);
                return (
                    <div className={styles.data_cell} style={cellProps.style}>
                        {formatted}
                    </div>
                );
            }
        }
    };

    // Listen to scroll events to synchronize scrolling of the locked header bar
    const onDataScroll = React.useCallback((event: GridOnScrollProps) => {
        if (event.scrollUpdateWasRequested === false) {
            headerGrid.current && headerGrid.current.scrollTo({ scrollLeft: event.scrollLeft });
        }
    }, []);
    // Listen to rendering events to check if the column widths changed.
    // Table elements are formatted lazily so we do not know upfront how wide a column will be.
    const onItemsRendered = React.useCallback((_event: GridOnItemsRenderedProps) => {
        if (headerGrid.current && dataGrid.current && tableFormatter) {
            const newWidths = computeColumnWidths(tableFormatter, gridColumns);
            if (!columnWidthsAreEqual(gridColumnWidths, newWidths)) {
                setGridColumnWidths(newWidths);
            }
        }
    }, [tableFormatter]);

    // Render an empty div if there's no data
    if (props.data == null) {
        return <div />;
    }

    return (
        <div className={classNames(styles.root, props.className)} ref={gridContainerElement}>
            <div className={styles.header_background} />
            <div className={styles.header_grid}>
                <Grid
                    ref={headerGrid}
                    style={{ overflowX: 'hidden' }}
                    columnCount={gridColumns}
                    columnWidth={getColumnWidth}
                    height={COLUMN_HEADER_HEIGHT}
                    rowCount={1}
                    rowHeight={() => COLUMN_HEADER_HEIGHT}
                    width={gridContainerWidth}
                >
                    {HeaderCell}
                </Grid>
            </div>
            <div className={styles.data_grid}>
                <Grid
                    ref={dataGrid}
                    columnCount={gridColumns}
                    columnWidth={getColumnWidth}
                    rowCount={gridRows}
                    rowHeight={() => ROW_HEIGHT}
                    height={gridContainerHeight}
                    width={gridContainerWidth}
                    onScroll={onDataScroll}
                    onItemsRendered={onItemsRendered}
                >
                    {DataCell}
                </Grid>
            </div>
        </div>
    );
};
