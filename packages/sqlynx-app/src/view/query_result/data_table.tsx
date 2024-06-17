import * as React from 'react';
import * as arrow from 'apache-arrow';
import { VariableSizeGrid as Grid, GridChildComponentProps } from 'react-window';

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
const MIN_COLUMN_WIDTH = 100;
const COLUMN_HEADER_HEIGHT = 24;
const ROW_HEIGHT = 24;
const ROW_HEADER_WIDTH = 48;

export const DataTable: React.FC<Props> = (props: Props) => {
    const gridContainerElement = React.useRef(null);
    const gridContainerSize = observeSize(gridContainerElement);
    const gridContainerHeight = Math.max(gridContainerSize?.height ?? 0, MIN_GRID_HEIGHT) - COLUMN_HEADER_HEIGHT;
    const gridContainerWidth = Math.max(gridContainerSize?.width ?? 0, MIN_GRID_WIDTH);

    const gridRows = props.data?.numRows ?? 0;
    const gridColumns = 1 + (props.data?.numCols ?? 0);
    const getColumnWidth = (i: number) => (i == 0 ? ROW_HEADER_WIDTH : MIN_COLUMN_WIDTH);

    /// Construct the arrow formatter
    const tableFormatter = React.useMemo(() => {
        if (props.data == null) {
            return;
        }
        return new ArrowTableFormatter(props.data.schema, props.data.batches);
    }, [props.data]);

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
    if (props.data == null) {
        return <div />;
    }
    return (
        <div className={classNames(styles.root, props.className)} ref={gridContainerElement}>
            <div className={styles.header_background} />
            <div className={styles.header_grid}>
                <Grid
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
                    columnCount={gridColumns}
                    columnWidth={getColumnWidth}
                    rowCount={gridRows}
                    rowHeight={() => ROW_HEIGHT}
                    height={gridContainerHeight}
                    width={gridContainerWidth}
                >
                    {DataCell}
                </Grid>
            </div>
        </div>
    );
};
