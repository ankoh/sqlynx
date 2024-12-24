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

export function useStickyRowAndColumnHeaders(Cell: React.ElementType, cellLocation: GridCellLocation, className: string, headerRowCount: number = 1) {
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
                    if (column === 0 || row < headerRowCount) {
                        return null;
                    }
                    return child;
                });

                // Add sticky rows
                for (let i = 0; i < headerRowCount; ++i) {
                    const rowIndex = i;
                    const rowOffset = cellLocation.getRowOffset(rowIndex);
                    const rowHeight = cellLocation.getRowHeight(rowIndex);
                    // Add dummy block cell to reset inline-flex
                    newChildren.push(<div key={`${i}:reset`} />);
                    // Add sticky corner cell
                    newChildren.push(
                        React.createElement(Cell, {
                            key: `${rowIndex}:0`,
                            rowIndex,
                            columnIndex: 0,
                            style: {
                                display: "inline-flex",
                                width: cellLocation.getColumnWidth(0),
                                height: rowHeight,
                                position: "sticky",
                                left: 0,
                                top: rowOffset,
                                zIndex: 4
                            }
                        })
                    );
                    // Add sticky header cells
                    for (let j = 1; j < (maxColumn - minColumn + 1); ++j) {
                        const columnIndex = minColumn + j;

                        newChildren.push(
                            React.createElement(Cell, {
                                key: `${rowIndex}:${columnIndex}`,
                                rowIndex,
                                columnIndex,
                                style: {
                                    display: "inline-flex",
                                    width: cellLocation.getColumnWidth(columnIndex),
                                    height: rowHeight,
                                    position: "sticky",
                                    top: rowOffset,
                                    marginLeft: (j === 1) ? (cellLocation.getColumnOffset(columnIndex) - cellLocation.getColumnWidth(0)) : undefined,
                                    zIndex: 3
                                }
                            })
                        );
                    }
                }

                // Get the offset of the first sticky row
                let firstStickyRowOffset = 0;
                for (let i = 0; i < headerRowCount; ++i) {
                    firstStickyRowOffset += cellLocation.getRowHeight(i);
                }

                // Add sticky row numbers
                for (let i = headerRowCount; i < (maxRow - minRow + 1); ++i) {
                    const rowIndex = minRow + i;
                    const columnIndex = 0;

                    console.log(cellLocation.getColumnWidth(columnIndex));

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
                                marginTop: (i === headerRowCount) ? (cellLocation.getRowOffset(rowIndex) - firstStickyRowOffset) : undefined,
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
