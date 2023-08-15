import * as flatsql from '@ankoh/flatsql';
import { AppState, ScriptData, ScriptKey } from './app_state';
import { GraphConnectionId, GraphNodeDescriptor, GraphViewModel } from '../schema_graph/graph_view_model';

export enum FocusTarget {
    Graph,
    Script,
}

export interface FocusInfo {
    /// The focused script key (if any)
    target: FocusTarget;
    /// The layout indices in the schema graph as (nodeId -> port bits) map
    graphNodes: Map<number, number>;
    /// The connection ids of focused edges
    graphConnections: Set<GraphConnectionId.Value>;
    /// The focused table columns as (tableId -> columnId[]) map.
    /// Only set if specific table columns are referenced.
    tableColumns: Map<flatsql.QualifiedID.Value, number[]>;
}

/// Derive focus from script cursors
export function deriveScriptFocusFromCursor(
    scriptKey: ScriptKey,
    scriptData: {
        [context: number]: ScriptData;
    },
    graphViewModel: GraphViewModel,
    cursor: flatsql.proto.ScriptCursorInfoT,
): FocusInfo {
    const focus: FocusInfo = {
        target: FocusTarget.Script,
        graphNodes: new Map(),
        graphConnections: new Set(),
        tableColumns: new Map(),
    };

    const tmpAnalyzed = new flatsql.proto.AnalyzedScript();
    let focusedTableId: flatsql.QualifiedID.Value | null = null;
    let focusedTableColumnId: number | null = null;
    let focusedQueryEdgeId: flatsql.QualifiedID.Value | null = null;
    let focusedGraphConnections = new Set<GraphConnectionId.Value>();

    // Focus a table definition?
    const tableId = flatsql.QualifiedID.create(scriptKey, cursor.tableId);
    if (!flatsql.QualifiedID.isNull(tableId)) {
        focusedTableId = tableId;
    }

    // Focus a column reference?
    const columnRefId = flatsql.QualifiedID.create(scriptKey, cursor.columnReferenceId);
    if (!flatsql.QualifiedID.isNull(columnRefId)) {
        const ctxKey = flatsql.QualifiedID.getContext(columnRefId);
        const ctxData = scriptData[ctxKey];
        if (ctxData !== undefined && ctxData.processed.analyzed !== null) {
            const ctxAnalyzed = ctxData.processed.analyzed.read(tmpAnalyzed);
            const columnRef = ctxAnalyzed.columnReferences(flatsql.QualifiedID.getIndex(columnRefId))!;
            focusedTableId = columnRef.tableId();
            focusedTableColumnId = columnRef.columnId();
        }
    }

    // Focus a table reference?
    const tableRefId = flatsql.QualifiedID.create(scriptKey, cursor.tableReferenceId);
    if (!flatsql.QualifiedID.isNull(tableRefId)) {
        const ctxKey = flatsql.QualifiedID.getContext(columnRefId);
        const ctxData = scriptData[ctxKey];
        if (ctxData !== undefined && ctxData.processed.analyzed !== null) {
            const ctxAnalyzed = ctxData.processed.analyzed.read(tmpAnalyzed);
            const tableRef = ctxAnalyzed.tableReferences(flatsql.QualifiedID.getIndex(tableRefId))!;
            focusedTableId = tableRef.tableId();
        }
    }

    // Focus a query graph edge?
    const queryEdgeId = flatsql.QualifiedID.create(scriptKey, cursor.queryEdgeId);
    if (!flatsql.QualifiedID.isNull(queryEdgeId)) {
        focusedQueryEdgeId = queryEdgeId;
        const ctxKey = flatsql.QualifiedID.getContext(columnRefId);
        const ctxData = scriptData[ctxKey];

        // Collect all graph connection ids that are associated with this query graph edge
        const connections = new Set<GraphConnectionId.Value>();
        if (ctxData !== undefined && ctxData.processed.analyzed !== null) {
            const ctxAnalyzed = ctxData.processed.analyzed.read(tmpAnalyzed);
            const queryEdge = ctxAnalyzed.graphEdges(flatsql.QualifiedID.getIndex(queryEdgeId))!;
            const countLeft = queryEdge.nodeCountLeft();
            const countRight = queryEdge.nodeCountRight();

            // Iterate over all nodes on the left
            for (let i = 0; i < countLeft; ++i) {
                const edgeNodeLeft = ctxAnalyzed.graphEdgeNodes(queryEdge.nodesBegin() + i)!;
                const columnRefLeft = ctxAnalyzed.columnReferences(edgeNodeLeft.columnReferenceId())!;
                const tableIdLeft = columnRefLeft.tableId();
                const nodeLeft = graphViewModel.nodesByTable.get(tableIdLeft);
                if (!nodeLeft) continue;

                // Iterate over all nodes on the right
                for (let j = 0; j < countRight; ++j) {
                    const edgeNodeRight = ctxAnalyzed.graphEdgeNodes(queryEdge.nodesBegin() + countLeft + j)!;
                    const columnRefRight = ctxAnalyzed.columnReferences(edgeNodeRight.columnReferenceId())!;
                    const tableIdRight = columnRefRight.tableId();
                    const nodeRight = graphViewModel.nodesByTable.get(tableIdRight);
                    if (!nodeRight) continue;

                    // Add the graph connection id
                    connections.add(GraphConnectionId.create(nodeLeft, nodeRight));
                    connections.add(GraphConnectionId.create(nodeRight, nodeLeft));
                }
            }
        }
        focusedGraphConnections = connections;
    }
    return focus;
}

export function focusGraphNode(state: AppState, node: GraphNodeDescriptor | null): AppState {
    // Unset focused node?
    if (node === null) {
        // State already has cleared focus?
        if (state.focus === null) {
            return state;
        }
        // Otherwise clear the focus state
        return {
            ...state,
            focus: null,
        };
    }
    // Focus a node, does the set of currently focused nodes only contain the newly focused node?
    if (state.focus?.graphNodes.size == 1) {
        const port = state.focus.graphNodes.get(node.nodeId);
        if (port === node.port) {
            // Leave the state as-is
            return state;
        }
    }
    // Mark node an port as focused
    const nodes = new Map<number, number>();
    const nodeId = node.nodeId;
    const port = node.port;
    nodes.set(nodeId, node.port ?? 0);
    // Determine the focused connections
    const connections = new Set<GraphConnectionId.Value>();
    if (node.port === null) {
        // If no port is focused, find all edges reaching that node
        for (const [conn, edge] of state.graphViewModel.edges) {
            if (edge.fromNode == nodeId || edge.toNode == nodeId) {
                connections.add(conn);
            }
        }
    } else {
        // If a port is focused, find all edges reaching that port
        for (const [conn, edge] of state.graphViewModel.edges) {
            if ((edge.fromNode == nodeId && edge.fromPort == port) || (edge.toNode == nodeId && edge.toPort == port)) {
                connections.add(conn);
            }
        }
    }
    return {
        ...state,
        focus: {
            target: FocusTarget.Graph,
            graphNodes: nodes,
            graphConnections: connections,
            tableColumns: new Map(),
        },
    };
}

export function focusGraphEdge(state: AppState, conn: GraphConnectionId.Value | null): AppState {
    // Unset focused edge?
    if (conn === null) {
        // State already has cleared focus?
        if (state.focus === null) {
            return state;
        }
        // Otherwise clear the focus state
        return {
            ...state,
            focus: null,
        };
    }
    // Does the set of focused edges only contain the newly focused edge?
    if (state.focus?.graphConnections?.size == 1) {
        if (state.focus.graphConnections.has(conn)) {
            return state;
        }
    }
    // Mark edge as focused
    return {
        ...state,
        focus: {
            target: FocusTarget.Graph,
            graphNodes: new Map(),
            graphConnections: new Set([conn]),
            tableColumns: new Map(),
        },
    };
}
