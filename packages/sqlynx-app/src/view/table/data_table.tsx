import * as React from 'react';
import * as arrow from 'apache-arrow';
import classNames from 'classnames';
import { VariableSizeGrid as Grid, GridChildComponentProps } from 'react-window';

import styles from './data_table.module.css';
import { observeSize } from '../size_observer';

interface Props {
    className?: string;
    data: arrow.Table;
}

const HEADER_ROW_HEIGHT = 24;
const DATA_ROW_HEIGHT = 24;
const ZERO_CELL_WIDTH = 48;
const DEFAULT_GRID_HEIGHT = 200;
const DEFAULT_GRID_WIDTH = 100;

export const DataTable: React.FC<Props> = (props: Props) => {
    const data = props.data;
    const containerElement = React.useRef(null);
    const containerSize = observeSize(containerElement);

    const gridRows = props.data.numRows;
    const gridColumns = 1 + props.data.numCols;
    const dataHeight = (containerSize?.height ?? DEFAULT_GRID_HEIGHT) - HEADER_ROW_HEIGHT;
    const dataWidth = containerSize?.width ?? DEFAULT_GRID_WIDTH;

    const HeaderCell = (props: GridChildComponentProps) => {
        if (props.columnIndex == 0) {
            return <div className={styles.header_zero_cell} style={props.style}></div>;
        } else {
            const fieldId = props.columnIndex - 1;
            return (
                <div className={styles.header_cell} style={props.style}>
                    {data.schema.fields[fieldId].name}
                </div>
            );
        }
    };
    const DataCell = (props: GridChildComponentProps) => {
        if (props.columnIndex == 0) {
            return (
                <div className={styles.row_zero_cell} style={props.style}>
                    {props.rowIndex}
                </div>
            );
        } else {
            return (
                <div className={styles.data_cell} style={props.style}>
                    {props.rowIndex + 1}
                </div>
            );
        }
    };
    return (
        <div className={classNames(styles.root, props.className)} ref={containerElement}>
            <Grid
                columnCount={gridColumns}
                columnWidth={i => (i == 0 ? ZERO_CELL_WIDTH : 100)}
                height={HEADER_ROW_HEIGHT}
                rowCount={1}
                rowHeight={() => HEADER_ROW_HEIGHT}
                width={dataWidth}
            >
                {HeaderCell}
            </Grid>
            <Grid
                columnCount={gridColumns}
                columnWidth={i => (i == 0 ? ZERO_CELL_WIDTH : 100)}
                rowCount={gridRows}
                rowHeight={() => DATA_ROW_HEIGHT}
                height={dataHeight}
                width={dataWidth}
            >
                {DataCell}
            </Grid>
        </div>
    );
};
