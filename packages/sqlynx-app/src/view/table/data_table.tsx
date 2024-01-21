import * as React from 'react';
import * as arrow from 'apache-arrow';
import classNames from 'classnames';
import { VariableSizeGrid as Grid, GridChildComponentProps } from 'react-window';

import styles from './data_table.module.css';
import { observeSize } from '../size_observer';

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

    if (props.data == null) {
        return <div />;
    }

    const gridRows = props.data.numRows;
    const gridColumns = 1 + props.data.numCols;
    const getColumnWidth = (i: number) => (i == 0 ? ROW_HEADER_WIDTH : MIN_COLUMN_WIDTH);

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
            return (
                <div className={styles.data_cell} style={cellProps.style}>
                    {cellProps.rowIndex + 1}
                </div>
            );
        }
    };
    return (
        <div className={classNames(styles.root, props.className)}>
            <div className={styles.title_container}>
                <div className={styles.title}>Query Results</div>
            </div>
            <div className={styles.grid_container} ref={gridContainerElement}>
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
        </div>
    );
};
