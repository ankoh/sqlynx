import * as React from "react";

export interface GridCellLocation {
    getRowHeight(row: number): number,
    getRowOffset(row: number): number,
    getColumnWidth(column: number): number,
    getColumnOffset(column: number): number,
}

type InnerElementProps = {
    children?: React.ReactElement[]
}

export function useStickyRowAndColumnHeaders(Cell: React.ElementType, cellLocation: GridCellLocation, className: string) {
    return React.useMemo(
        () =>
            React.forwardRef<HTMLDivElement>((props: InnerElementProps, ref: React.ForwardedRef<HTMLDivElement>) => {
                // Determine minimum and maximum rendered rows and columns
                let minRow = Infinity;
                let maxRow = -Infinity;
                let minColumn = Infinity;
                let maxColumn = -Infinity;
                React.Children.forEach(props.children, (child) => {
                    const row = child?.props.rowIndex;
                    const column = child?.props.columnIndex;
                    minRow = Math.min(minRow, row);
                    maxRow = Math.max(maxRow, row);
                    minColumn = Math.min(minColumn, column);
                    maxColumn = Math.max(maxColumn, column);
                });

                // Filter all non-sticky children
                const newChildren = React.Children.map(props.children!, (child) => {
                    const row = child?.props.rowIndex;
                    const column = child?.props.columnIndex;
                    if (column === 0 || row === 0) {
                        return null;
                    }
                    return child;
                });

                // Add node for top-left corner
                newChildren.push(
                    React.createElement(Cell, {
                        key: "0:0",
                        rowIndex: 0,
                        columnIndex: 0,
                        style: {
                            display: "inline-flex",
                            width: cellLocation.getColumnWidth(0),
                            height: cellLocation.getRowHeight(0),
                            position: "sticky",
                            top: 0,
                            left: 0,
                            zIndex: 4
                        }
                    })
                );

                // Add sticky header nodes
                for (let i = 1; i < (maxColumn - minColumn + 1); ++i) {
                    const rowIndex = 0;
                    const columnIndex = minColumn + i;

                    newChildren.push(
                        React.createElement(Cell, {
                            key: `${rowIndex}:${columnIndex}`,
                            rowIndex,
                            columnIndex,
                            style: {
                                display: "inline-flex",
                                width: cellLocation.getColumnWidth(columnIndex),
                                height: cellLocation.getRowHeight(rowIndex),
                                position: "sticky",
                                top: 0,
                                marginLeft: (i === 1) ? (cellLocation.getColumnOffset(columnIndex) - cellLocation.getColumnWidth(0)) : undefined,
                                zIndex: 3
                            }
                        })
                    );
                }

                // Add sticky row nodes
                for (let i = 1; i < (maxRow - minRow + 1); ++i) {
                    const rowIndex = minRow + i;
                    const columnIndex = 0;

                    newChildren.push(
                        React.createElement(Cell, {
                            key: `${rowIndex}:${columnIndex}`,
                            rowIndex,
                            columnIndex,
                            style: {
                                width: cellLocation.getColumnWidth(columnIndex),
                                height: cellLocation.getRowHeight(rowIndex),
                                position: "sticky",
                                left: 0,
                                marginTop: (i === 1) ? (cellLocation.getRowOffset(rowIndex) - cellLocation.getRowHeight(0)) : undefined,
                                zIndex: 2
                            }
                        })
                    );
                }

                return (
                    <div ref={ref} {...props} className={className}>
                        {newChildren}
                    </div>
                );
            }),
        [Cell, cellLocation]
    );
}
