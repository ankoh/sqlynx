import * as React from "react";
import * as styles from './query_info_list_view.module.css';

import { VariableSizeGrid } from "react-window";

import { useConnectionRegistry } from "../../connection/connection_registry.js";
import { observeSize } from "../../view/foundations/size_observer.js";
import { lowerBoundU32 } from "../../utils/sorted.js";
import { computeConnectionInfoViewModel, ConnectionViewModel } from "./query_info_view_model.js";

const ENTRY_SIZE_CONNECTION_HEADER = 40;
const ENTRY_SIZE_QUERY = 64;

/// The view model for a connection list
interface ConnectionListViewModel {
    connectionIds: Uint32Array
    firstConnectionRows: Uint32Array;
    rowOffsets: Uint32Array;
    totalRowCount: number;
    totalHeight: number;
}

/// The props passed to a query info list
interface QueryInfoListViewProps {
    conn?: number;
    connQueries?: number[];
}

export function QueryInfoListView(props: QueryInfoListViewProps) {
    const connReg = useConnectionRegistry();

    // We collect the connection query infos lazily to not compute too many off-screen infos.
    const connViewModels = React.useRef<(ConnectionViewModel | null)[]>();
    // We accept to recompute this view model very often whenever query logs are visible on the screen.
    const listViewModel = React.useMemo<ConnectionListViewModel>(() => {
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
                    totalQueryCount += conn.queriesActive.size + conn.queriesFinished.size;
                }
            }
        } else {
            for (const [_cid, conn] of connReg.connectionMap) {
                totalConnectionCount += 1;
                totalQueryCount += conn.queriesActive.size + conn.queriesFinished.size;
            }
        }

        const totalRowCount = totalConnectionCount + totalQueryCount;
        const viewModel: ConnectionListViewModel = {
            connectionIds: new Uint32Array(totalConnectionCount),
            firstConnectionRows: new Uint32Array(totalConnectionCount),
            rowOffsets: new Uint32Array(totalRowCount + 1),
            totalRowCount: totalRowCount,
            totalHeight: totalConnectionCount * ENTRY_SIZE_CONNECTION_HEADER + totalQueryCount * ENTRY_SIZE_QUERY,
        };

        let writerConn = 0;
        let writerRow = 0;
        let writerRowOffset = 0;

        if (props.conn) {
            const conn = connReg.connectionMap.get(props.conn);
            if (conn) {
                viewModel.connectionIds[writerConn] = props.conn;
                viewModel.firstConnectionRows[writerConn] = writerRow;
                viewModel.rowOffsets[writerRow] = writerRowOffset;
                writerRow += 1;
                writerRowOffset += ENTRY_SIZE_CONNECTION_HEADER;

                // Note that this loop is not really cheap since it's writing row offsets for every single query entry.
                // It's not reading |query| data, but it's writing |query| u32 offsets, many of which are (and will remain) off-screen.
                //
                // Take this as motivator to detect in the future if the total query count really changed...
                // (Not that easy as soon as we collect old queries, that's why we didn't do it yet)
                //
                // Alternatively, we could also just store the total connection height and then binary-search for every row height estimation.
                // The problem is that scrolling through all queries will be a bit annoying.
                // I expect us to limit the number of displayed queries per connections eventually, computing for all queries in the log is fine for now.
                let queryCount = props.connQueries ? props.connQueries.length : (conn.queriesActive.size + conn.queriesFinished.size);
                for (let i = 0; i < queryCount; ++i) {
                    viewModel.rowOffsets[writerRow] = writerRowOffset;
                    writerRow += 1;
                    writerRowOffset += ENTRY_SIZE_QUERY;
                }
                writerConn += 1;
            }
        } else {
            for (const [cid, conn] of connReg.connectionMap) {
                viewModel.connectionIds[writerConn] = cid;
                viewModel.firstConnectionRows[writerConn] = writerRow;
                viewModel.rowOffsets[writerRow] = writerRowOffset;
                writerRow += 1;
                writerRowOffset += ENTRY_SIZE_CONNECTION_HEADER;

                let queryCount = conn.queriesActive.size + conn.queriesFinished.size;
                for (let i = 0; i < queryCount; ++i) {
                    viewModel.rowOffsets[writerRow] = writerRowOffset;
                    writerRow += 1;
                    writerRowOffset += ENTRY_SIZE_QUERY;
                }
                writerConn += 1;
            }
        }
        console.log("RESET VIEW MODELS");

        // Write trailing row offset
        viewModel.rowOffsets[writerRow] = writerRowOffset;
        // Reset the cached connectionv iew models
        connViewModels.current = (new Array(viewModel.firstConnectionRows.length)).fill(null);

        return viewModel;
    }, [connReg]);

    // Helper to resolve the height of a row
    const getRowHeight = React.useCallback<(row: number) => number>((row: number) => (listViewModel.rowOffsets[row + 1] - listViewModel.rowOffsets[row]), [listViewModel]);
    // Helper to render a cell
    type CellProps = { rowIndex: number, style: React.CSSProperties };
    const Cell = React.useCallback<(props: CellProps) => React.ReactElement>((props: CellProps) => {
        if (listViewModel.firstConnectionRows.length == 0) {
            return <div />;
        }
        // Find out which connection the row belongs to
        let connEntryIdx = Math.min(
            lowerBoundU32(listViewModel.firstConnectionRows, props.rowIndex),
            listViewModel.firstConnectionRows.length - 1
        );
        // Use predecessor if the first connection row is larger the row index
        if (listViewModel.firstConnectionRows[connEntryIdx] > props.rowIndex) {
            --connEntryIdx;
        }

        // Is the first row?
        const connId = listViewModel.connectionIds[connEntryIdx];
        const connState = connReg.connectionMap.get(connId);
        const firstConnectionRow = listViewModel.firstConnectionRows[connEntryIdx];
        let connViewModel = connViewModels.current![connEntryIdx];

        // Failed to resolve the connection state?
        if (connState == null) {
            return (
                <div style={props.style} />
            );
        }

        // Make sure we computed the query info view models for the connection
        if (connViewModel == null) {
            connViewModel = computeConnectionInfoViewModel(connState);
            connViewModels.current![connEntryIdx] = connViewModel;
        };

        // Is the header row?
        if (props.rowIndex == firstConnectionRow) {
            return (
                <div style={props.style}>
                    HeaderCell
                </div>
            );

        } else {
            // Is a query row

            // Subtract the connection header row for the relative row index in the list
            const relativeRowIndex = props.rowIndex - firstConnectionRow - 1;

            // Is the query running?
            // We always render all running queries first, before the finished ones
            const runningQueryCount = connViewModel.queriesRunning.length;
            const isRunningQuery = relativeRowIndex < runningQueryCount;
            const queryViewModel = isRunningQuery
                ? connViewModel!.queriesRunning[relativeRowIndex]
                : connViewModel!.queriesFinished[relativeRowIndex - runningQueryCount];

            return (
                <div style={props.style}>
                    running={isRunningQuery}
                    <div className={styles.stages_container}>
                        {queryViewModel.stages.map(s => (s.startedAt != null) ? "+" : "-")}
                    </div>
                </div>
            );
        }
    }, [listViewModel]);

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
                rowCount={listViewModel.totalRowCount}
                rowHeight={getRowHeight}
                estimatedColumnWidth={containerWidth}
            >
                {Cell}
            </VariableSizeGrid>
        </div>
    );
}


