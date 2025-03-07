import * as React from "react";
import * as styles from './query_info_list_view.module.css';

import { VariableSizeGrid } from "react-window";

import { ConnectionRegistry, useConnectionRegistry } from "../../connection/connection_registry.js";
import { observeSize } from "../../view/foundations/size_observer.js";
import { U32_MAX } from "../../utils/numeric_limits.js";
import { QueryInfoView } from "./query_info_view.js";

const ENTRY_SIZE_CONNECTION_HEADER = 40;
const ENTRY_SIZE_QUERY = 64;

/// The view model for a connection list
interface ConnectionListViewModel {
    connectionIds: Uint32Array
    connectionQueryIds: Uint32Array;
    rowOffsets: Uint32Array;
    totalRowCount: number;
    totalHeight: number;
}

/// The props passed to a query info list
interface QueryInfoListViewProps {
    conn?: number;
    connQueries?: number[];
}

/// The state snapshots
interface StateSnapshot {
    /// The connection query snapshots
    querySnapshots: Uint32Array;
}

function computeViewModel(props: QueryInfoListViewProps, connReg: ConnectionRegistry) {
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
                totalQueryCount += conn.queriesActiveOrdered.length + conn.queriesFinishedOrdered.length;
            }
        }
    } else {
        for (const [_cid, conn] of connReg.connectionMap) {
            totalConnectionCount += 1;
            totalQueryCount += conn.queriesActiveOrdered.length + conn.queriesFinishedOrdered.length;
        }
    }

    const totalRowCount = totalConnectionCount + totalQueryCount;
    const viewModel: ConnectionListViewModel = {
        connectionIds: new Uint32Array(totalRowCount),
        connectionQueryIds: new Uint32Array(totalRowCount),
        rowOffsets: new Uint32Array(totalRowCount + 1),
        totalRowCount: totalRowCount,
        totalHeight: totalConnectionCount * ENTRY_SIZE_CONNECTION_HEADER + totalQueryCount * ENTRY_SIZE_QUERY,
    };

    let writer = 0;
    let writerOffset = 0;

    if (props.conn) {
        const conn = connReg.connectionMap.get(props.conn);
        if (conn) {
            viewModel.connectionIds[writer] = props.conn;
            viewModel.connectionQueryIds[writer] = U32_MAX;
            viewModel.rowOffsets[writer] = writerOffset;
            writer += 1;
            writerOffset += ENTRY_SIZE_CONNECTION_HEADER;

            if (props.connQueries) {
                for (let i = 0; i < props.connQueries.length; ++i) {
                    viewModel.connectionIds[writer] = props.conn;
                    viewModel.connectionQueryIds[writer] = props.connQueries[props.connQueries.length - i - 1];
                    viewModel.rowOffsets[writer] = writerOffset;
                    writer += 1;
                    writerOffset += ENTRY_SIZE_QUERY;
                }
            } else {
                // Note that this loop is not really cheap since it's writing row offsets for every single query entry.
                //
                // Take this as motivator to detect in the future if the total query count really changed...
                // (Not that easy as soon as we collect old queries, that's why we didn't do it yet)
                //
                // Alternatively, we could also just store the total connection height and then binary-search for every row height estimation.
                // The problem is that scrolling through all queries will be a bit annoying.
                // I expect us to limit the number of displayed queries per connections eventually, computing for all queries in the log is fine for now.
                for (const qs of [conn.queriesActiveOrdered, conn.queriesFinishedOrdered]) {
                    for (let i = 0; i < qs.length; ++i) {
                        viewModel.connectionIds[writer] = props.conn;
                        viewModel.connectionQueryIds[writer] = qs[qs.length - i - 1];
                        viewModel.rowOffsets[writer] = writerOffset;
                        writer += 1;
                        writerOffset += ENTRY_SIZE_QUERY;
                    }
                }

            }
        }
    } else {
        for (const [cid, conn] of connReg.connectionMap) {
            viewModel.connectionIds[writer] = cid;
            viewModel.connectionQueryIds[writer] = U32_MAX;
            viewModel.rowOffsets[writer] = writerOffset;
            writer += 1;
            writerOffset += ENTRY_SIZE_CONNECTION_HEADER;

            for (const qs of [conn.queriesActiveOrdered, conn.queriesFinishedOrdered]) {
                for (let i = 0; i < qs.length; ++i) {
                    viewModel.connectionIds[writer] = cid;
                    viewModel.connectionQueryIds[writer] = qs[qs.length - i - 1];
                    viewModel.rowOffsets[writer] = writerOffset;
                    writer += 1;
                    writerOffset += ENTRY_SIZE_QUERY;
                }
            }
        }
    }

    // Write trailing row offset
    viewModel.rowOffsets[writer] = writerOffset;

    return viewModel;
}

export function QueryInfoListView(props: QueryInfoListViewProps) {
    const connReg = useConnectionRegistry();

    /// We maintain state snapshots to detect changes
    const stateSnapshots = React.useRef<StateSnapshot>({
        querySnapshots: new Uint32Array()
    });

    /// Maintain a list view model
    const [listViewModel, setListViewModel] = React.useState<ConnectionListViewModel>({
        connectionIds: new Uint32Array(),
        connectionQueryIds: new Uint32Array(),
        rowOffsets: new Uint32Array(),
        totalRowCount: 0,
        totalHeight: 0,
    });

    // Run always and recompute the state snapshot
    React.useEffect(() => {
        // Collect all snapshots for active and finished queries
        const snaps = new Uint32Array(connReg.connectionMap.size);
        let i = 0;
        for (const [_cid, conn] of connReg.connectionMap) {
            snaps[i] = conn.snapshotQueriesActiveFinished;
            i += 1;
        }
        // Check if the snapshots changed
        let updateViewModel = false;
        if (stateSnapshots.current.querySnapshots.length == snaps.length) {
            let allSnapsEqual = true;
            for (let i = 0; i < snaps.length; ++i) {
                allSnapsEqual &&= stateSnapshots.current.querySnapshots[i] == snaps[i];
            }
            updateViewModel = !allSnapsEqual;
        } else {
            updateViewModel = true;
        }

        if (!updateViewModel) {
            return;
        }
        stateSnapshots.current.querySnapshots = snaps;

        // Recompute the list view model
        const listViewModel = computeViewModel(props, connReg);
        setListViewModel(listViewModel);
    });

    // Helper to resolve the height of a row
    const getRowHeight = React.useCallback<(row: number) => number>((row: number) => (listViewModel.rowOffsets[row + 1] - listViewModel.rowOffsets[row]), [listViewModel]);

    // Helper to render a cell
    type CellProps = { rowIndex: number, style: React.CSSProperties };
    const Cell = React.useCallback<(props: CellProps) => React.ReactElement>((props: CellProps) => {
        if (listViewModel == null) {
            return <div />;
        }
        const connId = listViewModel.connectionIds[props.rowIndex];
        const connQueryId = listViewModel.connectionQueryIds[props.rowIndex];

        // Is the header row?
        if (connQueryId == U32_MAX) {
            return (
                <div style={props.style}>
                    HeaderCell
                </div>
            );

        } else {
            return (
                <div style={props.style}>
                    <QueryInfoView conn={connId} query={connQueryId} />
                </div>
            );
        }
    }, [listViewModel]);

    // Track the root container dimensions
    const containerRef = React.useRef<HTMLDivElement>(null);
    const containerSize = observeSize(containerRef);
    const containerWidth = containerSize?.width ?? 200;
    const containerHeight = containerSize?.height ?? 100;

    // Reset grid when container widths and heights change
    const dataGrid = React.useRef<VariableSizeGrid>(null);
    React.useEffect(() => {
        if (dataGrid.current) {
            dataGrid.current.resetAfterColumnIndex(0);
        }
    }, [containerWidth, containerHeight, listViewModel]);

    return (
        <div className={styles.grid_container} ref={containerRef}>
            <VariableSizeGrid
                ref={dataGrid}
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


