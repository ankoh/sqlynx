import * as flatsql from '@ankoh/flatsql';
import { AppState, ScriptData, ScriptKey } from './app_state';
import { GraphConnectionId, GraphNodeDescriptor, GraphViewModel } from '../schema_graph/graph_view_model';

export interface FocusInfo {
    /// The connection ids of focused edges
    graphConnections: Set<GraphConnectionId.Value>;
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
        graphConnections: new Set(),
    };
    const tmpAnalyzed = new flatsql.proto.AnalyzedScript();

    // Focus a query graph edge?
    const queryEdgeId = flatsql.QualifiedID.create(scriptKey, cursor.queryEdgeId);
    if (!flatsql.QualifiedID.isNull(queryEdgeId)) {
        const ctxData = scriptData[scriptKey];

        // Collect all graph connection ids that are associated with this query graph edge
        const connections = new Set<GraphConnectionId.Value>();
        if (ctxData !== undefined && ctxData.processed.analyzed !== null) {
            const ctxAnalyzed = ctxData.processed.analyzed.read(tmpAnalyzed);
            const queryEdge = ctxAnalyzed.graphEdges(flatsql.QualifiedID.getIndex(queryEdgeId))!;
            const countLeft = queryEdge.nodeCountLeft();
            const countRight = queryEdge.nodeCountRight();

            // Iterate over all nodes on the left, usually just 1
            for (let i = 0; i < countLeft; ++i) {
                const edgeNodeLeft = ctxAnalyzed.graphEdgeNodes(queryEdge.nodesBegin() + i)!;
                const columnRefLeft = ctxAnalyzed.columnReferences(edgeNodeLeft.columnReferenceId())!;
                const tableIdLeft = columnRefLeft.tableId();
                const nodeLeft = graphViewModel.nodesByTable.get(tableIdLeft);
                if (nodeLeft === undefined) continue;

                // Iterate over all nodes on the right, usually just 1
                for (let j = 0; j < countRight; ++j) {
                    const edgeNodeRight = ctxAnalyzed.graphEdgeNodes(queryEdge.nodesBegin() + countLeft + j)!;
                    const columnRefRight = ctxAnalyzed.columnReferences(edgeNodeRight.columnReferenceId())!;
                    const tableIdRight = columnRefRight.tableId();
                    const nodeRight = graphViewModel.nodesByTable.get(tableIdRight);
                    if (nodeRight === undefined) continue;

                    // Add the graph connection id
                    connections.add(GraphConnectionId.create(nodeLeft.nodeId, nodeRight.nodeId));
                    connections.add(GraphConnectionId.create(nodeRight.nodeId, nodeLeft.nodeId));
                }
            }
        }
        focus.graphConnections = connections;
    }
    return focus;
}

export function focusGraphNode(state: AppState, target: GraphNodeDescriptor | null): AppState {
    // Unset focused node?
    if (target === null) {
        // State already has cleared focus?
        if (state.focus === null) {
            return state;
        }
        // Otherwise clear the focus state
        return {
            ...state,
            scripts: {
                [ScriptKey.MAIN_SCRIPT]: {
                    ...state.scripts[ScriptKey.MAIN_SCRIPT],
                    cursor: null,
                },
                [ScriptKey.SCHEMA_SCRIPT]: {
                    ...state.scripts[ScriptKey.SCHEMA_SCRIPT],
                    cursor: null,
                },
            },
            focus: null,
        };
    }
    // Determine the focused connections
    const newConnections = new Set<GraphConnectionId.Value>();
    const prevConnections = state.focus?.graphConnections ?? new Set();
    let allInPrev = true;

    if (target.port === null) {
        // If no port is focused, find all edges reaching that node
        for (const conn of state.graphViewModel.edges.keys()) {
            const [fromNode, toNode] = GraphConnectionId.unpack(conn);
            if (fromNode == target.nodeId || toNode == target.nodeId) {
                newConnections.add(conn);
                allInPrev &&= prevConnections.has(conn);
            }
        }
    } else {
        // If a port is focused, find all edges reaching that port
        for (const [conn, edge] of state.graphViewModel.edges) {
            const [fromNode, toNode] = GraphConnectionId.unpack(conn);
            if (
                (fromNode == target.nodeId && edge.fromPort == target.port) ||
                (toNode == target.nodeId && edge.toPort == target.port)
            ) {
                newConnections.add(conn);
                allInPrev &&= prevConnections.has(conn);
            }
        }
    }

    // Same focus?
    if (allInPrev && newConnections.size == prevConnections.size) {
        return state;
    }
    return {
        ...state,
        scripts: {
            [ScriptKey.MAIN_SCRIPT]: {
                ...state.scripts[ScriptKey.MAIN_SCRIPT],
                cursor: null,
            },
            [ScriptKey.SCHEMA_SCRIPT]: {
                ...state.scripts[ScriptKey.SCHEMA_SCRIPT],
                cursor: null,
            },
        },
        focus: {
            graphConnections: newConnections,
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
            scripts: {
                [ScriptKey.MAIN_SCRIPT]: {
                    ...state.scripts[ScriptKey.MAIN_SCRIPT],
                    cursor: null,
                },
                [ScriptKey.SCHEMA_SCRIPT]: {
                    ...state.scripts[ScriptKey.SCHEMA_SCRIPT],
                    cursor: null,
                },
            },
            focus: null,
        };
    }
    // Does the set of focused edges only contain the newly focused edge?
    if (state.focus?.graphConnections?.size == 1) {
        if (state.focus.graphConnections.has(conn)) {
            return state;
        }
    }
    // Get the nodes
    const vm = state.graphViewModel.edges.get(conn);
    if (!vm) {
        console.warn(`unknown graph edge with id: ${conn}`);
        return state;
    }
    // const key = flatsql.QualifiedID.getContext(vm.queryEdgeId);
    // const analyzed = state.scripts[key].processed.analyzed?.read(new flatsql.proto.AnalyzedScript());
    // const edge = analyzed?.graphEdges(flatsql.QualifiedID.getIndex(vm.queryEdgeId));

    // Mark edge as focused
    return {
        ...state,
        scripts: {
            [ScriptKey.MAIN_SCRIPT]: {
                ...state.scripts[ScriptKey.MAIN_SCRIPT],
                cursor: null,
            },
            [ScriptKey.SCHEMA_SCRIPT]: {
                ...state.scripts[ScriptKey.SCHEMA_SCRIPT],
                cursor: null,
            },
        },
        focus: {
            graphConnections: new Set([conn]),
        },
    };
}
