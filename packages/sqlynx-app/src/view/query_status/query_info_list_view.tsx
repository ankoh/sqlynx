import * as React from "react";
import * as styles from './query_info_list_view.module.css';

import { VariableSizeGrid } from "react-window";

import { useConnectionRegistry } from "../../connection/connection_registry.js";
import { QueryInfoViewModel } from "./query_info_view_model.js";
import { observeSize } from "../../view/foundations/size_observer.js";
import { lowerBoundU32 } from "../../utils/sorted.js";

const ENTRY_SIZE_CONNECTION_HEADER = 80;
const ENTRY_SIZE_QUERY = 64;

/// The props passed to a query info list
interface QueryInfoListViewProps {
    conn?: number;
    connQueries?: number[];
}

/// The view model for a connection list
interface ConnectionListViewModel {
    connectionIds: Uint32Array;
    offsetsRow: Uint32Array;
    offsetsRowRunningOrProvided: Uint32Array;
    offsetsRowFinished: Uint32Array;
    offsetsPx: Uint32Array;
    offsetsPxRunningOrProvided: Uint32Array;
    offsetsPxFinished: Uint32Array;
    totalRowCount: number;
    totalHeight: number;
}

/// The view model for a connection
interface ConnectionViewModel {
    /// The queries that are either running or have been provided via props
    queriesRunningOrProvided: QueryInfoViewModel[];
    /// The finished queries
    queriesFinished: QueryInfoViewModel[];
}

export function QueryInfoListView(props: QueryInfoListViewProps) {
    const connReg = useConnectionRegistry();

    // We collect the connection query infos lazily to not compute too many off-screen infos.
    const connectionViewModels = React.useRef<(ConnectionViewModel | null)[]>();

    // We accept to recompute this view model very often whenever query logs are visible on the screen.
    const crossConnViewModel = React.useMemo<ConnectionListViewModel>(() => {
        // First we find out how many entries we have
        let totalConnectionCount = 0;
        let totalQueryCount = 0;

        // Do we have to filter a specific connection?
        if (props.conn) {
            // Get the connection
            const conn = connReg.connectionMap.get(props.conn);
            if (conn) {
                totalConnectionCount += 1;
                if (props.connQueries) {
                    totalQueryCount += props.connQueries.length;
                } else {
                    totalQueryCount += conn.queriesRunning.size + conn.queriesFinished.size;
                }
            }
        } else {
            for (const [_cid, conn] of connReg.connectionMap) {
                totalConnectionCount += 1;
                totalQueryCount += conn.queriesRunning.size + conn.queriesFinished.size;
            }
        }

        const viewModel: ConnectionListViewModel = {
            connectionIds: new Uint32Array(totalConnectionCount),
            offsetsRow: new Uint32Array(totalConnectionCount),
            offsetsRowRunningOrProvided: new Uint32Array(totalConnectionCount),
            offsetsRowFinished: new Uint32Array(totalConnectionCount),
            offsetsPx: new Uint32Array(totalConnectionCount),
            offsetsPxRunningOrProvided: new Uint32Array(totalConnectionCount),
            offsetsPxFinished: new Uint32Array(totalConnectionCount),
            totalRowCount: totalConnectionCount + totalQueryCount,
            totalHeight: totalConnectionCount * ENTRY_SIZE_CONNECTION_HEADER + totalQueryCount * ENTRY_SIZE_QUERY,
        };

        let writer = 0;
        let writerOffsetRow = 0;
        let writerOffsetPx = 0;

        if (props.conn) {
            const conn = connReg.connectionMap.get(props.conn);
            if (conn) {
                viewModel.connectionIds[writer] = props.conn;
                viewModel.offsetsRow[writer] = writerOffsetRow;
                viewModel.offsetsPx[writer] = writerOffsetPx;
                writerOffsetRow += 1;
                writerOffsetPx += ENTRY_SIZE_CONNECTION_HEADER;

                if (props.connQueries) {
                    viewModel.offsetsRowRunningOrProvided[writer] = writerOffsetRow;
                    viewModel.offsetsPxRunningOrProvided[writer] = writerOffsetPx;
                    writerOffsetRow += props.connQueries.length;
                    writerOffsetPx += props.connQueries.length * ENTRY_SIZE_QUERY;
                } else {
                    viewModel.offsetsRowRunningOrProvided[writer] = writerOffsetRow;
                    viewModel.offsetsPxRunningOrProvided[writer] = writerOffsetPx;
                    writerOffsetRow += conn.queriesRunning.size;
                    writerOffsetPx += conn.queriesRunning.size * ENTRY_SIZE_QUERY;

                    viewModel.offsetsRowFinished[writer] = writerOffsetRow;
                    viewModel.offsetsPxFinished[writer] = writerOffsetPx;
                    writerOffsetRow += conn.queriesFinished.size;
                    writerOffsetPx += conn.queriesFinished.size * ENTRY_SIZE_QUERY;
                }
                writer += 1;
            }
        } else {
            for (const [cid, conn] of connReg.connectionMap) {
                viewModel.connectionIds[writer] = cid;
                viewModel.offsetsRow[writer] = writerOffsetRow;
                viewModel.offsetsPx[writer] = writerOffsetPx;
                writerOffsetRow += 1;
                writerOffsetPx += ENTRY_SIZE_CONNECTION_HEADER;

                viewModel.offsetsRowRunningOrProvided[writer] = writerOffsetRow;
                viewModel.offsetsPxRunningOrProvided[writer] = writerOffsetPx;
                writerOffsetRow += conn.queriesRunning.size;
                writerOffsetPx += conn.queriesRunning.size * ENTRY_SIZE_QUERY;

                viewModel.offsetsRowFinished[writer] = writerOffsetRow;
                viewModel.offsetsPxFinished[writer] = writerOffsetPx;
                writerOffsetRow += conn.queriesFinished.size;
                writerOffsetPx += conn.queriesFinished.size * ENTRY_SIZE_QUERY;

                writer += 1;
            }
        }
        // Reset the cache
        connectionViewModels.current = (new Array(viewModel.connectionIds.length)).fill(null);

        return viewModel;
    }, [connReg]);

    // Helper to resolve the height of a row
    const getRowHeight = React.useCallback<(row: number) => number>((row: number) => {
        if (crossConnViewModel.connectionIds.length == 0) {
            return 0;
        }
        // Find out which connection the row belongs to
        let idx = Math.min(
            lowerBoundU32(crossConnViewModel.offsetsRow, row),
            crossConnViewModel.offsetsRow.length - 1
        );

        // Is it the first row of the connection?
        // Then return the height of the connection header, otherwise it's the query entry
        const firstRow = crossConnViewModel.offsetsRow[idx];
        return firstRow == row ? ENTRY_SIZE_CONNECTION_HEADER : ENTRY_SIZE_QUERY;
    }, [crossConnViewModel]);

    // Helper to render a cell
    type CellProps = { rowIndex: number, style: React.CSSProperties };
    const Cell = React.useCallback<(props: CellProps) => React.ReactElement>((props: CellProps) => {
        if (crossConnViewModel.connectionIds.length == 0) {
            return <div />;
        }
        // Find out which connection the row belongs to
        const idx = Math.min(
            lowerBoundU32(crossConnViewModel.offsetsRow, props.rowIndex),
            crossConnViewModel.offsetsRow.length - 1
        );

        // Is the first row?
        const firstRow = crossConnViewModel.offsetsRow[idx];
        if (props.rowIndex == firstRow) {
            return <div style={props.style}>HeaderCell</div>;

        } else {
            // Make sure we computed the query info view models for the connection

            return <div style={props.style}>BodyCell</div>;
        }
    }, [crossConnViewModel]);

    // Track the root container dimensions
    const containerRef = React.useRef<HTMLDivElement>(null);
    const containerSize = observeSize(containerRef);
    const containerWidth = containerSize?.width ?? 200;
    const containerHeight = containerSize?.height ?? 100;

    return (
        <div className={styles.grid_container} ref={containerRef}>
            <VariableSizeGrid
                width={containerWidth}
                height={containerHeight}
                columnCount={1}
                columnWidth={() => containerWidth}
                rowCount={crossConnViewModel.totalRowCount}
                rowHeight={getRowHeight}
                estimatedColumnWidth={containerWidth}
            >
                {Cell}
            </VariableSizeGrid>
        </div>
    );
}
