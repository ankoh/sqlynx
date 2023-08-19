import * as flatsql from '@ankoh/flatsql';

import { AppState, ScriptKey } from '../state/app_state';
import { EdgePathBuilder, EdgeType, PORTS_FROM, PORTS_TO, buildEdgePath, selectEdgeType } from './graph_edges';
import { DebugInfo, buildDebugInfo } from './debug_layer';

export interface GraphViewModel {
    nodes: NodeViewModel[];
    nodesByTable: Map<flatsql.QualifiedID.Value, NodeViewModel>;
    edges: Map<GraphConnectionId.Value, EdgeViewModel>;
    debugInfo: DebugInfo | null;
}

export interface NodeViewModel {
    nodeId: number;
    tableId: flatsql.QualifiedID.Value;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    columns: TableColumn[];
    ports: number;
}

interface TableColumn {
    name: string;
}

export interface EdgeViewModel {
    connectionId: GraphConnectionId.Value;
    queryEdgeIds: flatsql.QualifiedID.Value[];
    fromNode: number;
    fromTable: flatsql.QualifiedID.Value;
    fromPort: number;
    toNode: number;
    toTable: flatsql.QualifiedID.Value;
    toPort: number;
    type: EdgeType;
    path: string;
}

export interface GraphNodeDescriptor {
    nodeId: number;
    port: number | null;
}

export namespace GraphConnectionId {
    export type Value = bigint;
    export function create(from: number, to: number): Value {
        return (BigInt(from) << 32n) | BigInt(to);
    }
    export function unpack(id: Value): [number, number] {
        const from = id >> 32n;
        const to = id & ((1n << 32n) - 1n);
        return [Number(from), Number(to)];
    }
}

export function computeGraphViewModel(state: AppState): GraphViewModel {
    let debugInfo: DebugInfo = {
        nodeCount: 0,
        fromX: new Float64Array(),
        fromY: new Float64Array(),
        toX: new Float64Array(),
        toY: new Float64Array(),
        distance: new Float64Array(),
        repulsion: new Float64Array(),
    };
    if (!state.graphLayout) {
        return {
            nodes: [],
            nodesByTable: new Map(),
            edges: new Map(),
            debugInfo,
        };
    }
    const nodes = [];
    const nodesByTable = new Map<flatsql.QualifiedID.Value, NodeViewModel>();
    const edges = new Map<GraphConnectionId.Value, EdgeViewModel>();

    // Collect parsed and analyzed scripts
    const mainProcessed = state.scripts[ScriptKey.MAIN_SCRIPT].processed;
    const schemaProcessed = state.scripts[ScriptKey.SCHEMA_SCRIPT].processed;
    const parsedScripts: { [key: number]: flatsql.proto.ParsedScript | null } = {
        [ScriptKey.MAIN_SCRIPT]: mainProcessed.parsed?.read(new flatsql.proto.ParsedScript()) ?? null,
        [ScriptKey.SCHEMA_SCRIPT]: schemaProcessed.parsed?.read(new flatsql.proto.ParsedScript()) ?? null,
    };
    const analyzedScripts: { [key: number]: flatsql.proto.AnalyzedScript | null } = {
        [ScriptKey.MAIN_SCRIPT]: mainProcessed.analyzed?.read(new flatsql.proto.AnalyzedScript()) ?? null,
        [ScriptKey.SCHEMA_SCRIPT]: schemaProcessed.analyzed?.read(new flatsql.proto.AnalyzedScript()) ?? null,
    };

    if (!state.graphLayout) {
        return {
            nodes: [],
            nodesByTable: new Map(),
            edges: new Map(),
            debugInfo,
        };
    }
    const tmpGraphTableNode = new flatsql.proto.SchemaGraphTableNode();
    const tmpGraphVertex = new flatsql.proto.SchemaGraphVertex();
    const tmpTable = new flatsql.proto.Table();
    const tmpTableColumn = new flatsql.proto.TableColumn();

    // Collect all tables in the schema script
    const layout = state.graphLayout!.read(new flatsql.proto.SchemaGraphLayout());
    for (let nodeId = 0; nodeId < layout.tableNodesLength(); ++nodeId) {
        const node = layout.tableNodes(nodeId, tmpGraphTableNode);
        const position = node!.position(tmpGraphVertex)!;
        const tableId = node!.tableId();

        // Table ID is null?
        // That means we couldn't resolve a table.
        // For now, just skip them.
        if (flatsql.QualifiedID.isNull(tableId)) {
            continue;
        }

        // Is an external table?
        const context = flatsql.QualifiedID.getContext(tableId);
        const analyzed = analyzedScripts[context] ?? null;

        if (analyzed) {
            const tableIdx = flatsql.QualifiedID.getIndex(tableId);
            const table = analyzed.tables(tableIdx, tmpTable);
            const tableName = flatsql.QualifiedID.readTableName(table?.tableName()!, parsedScripts);
            const columns: TableColumn[] = [];
            const columnsBegin = table!.columnsBegin();
            for (let j = 0; j < table!.columnCount(); ++j) {
                const column = analyzed.tableColumns(columnsBegin + j, tmpTableColumn);
                const columnName = flatsql.QualifiedID.readName(column?.columnName()!, parsedScripts)!;
                columns.push({
                    name: columnName,
                });
            }
            const viewModel: NodeViewModel = {
                nodeId,
                tableId,
                name: tableName.table ?? '',
                x: position.x(),
                y: position.y(),
                columns: columns,
                width: node!.width(),
                height: node!.height(),
                ports: 0,
            };
            nodes.push(viewModel);
            nodesByTable.set(tableId, viewModel);
        }
    }

    // Read edges
    const tmpGraphEdge = new flatsql.proto.SchemaGraphEdge();
    const tmpGraphEdgeNode1 = new flatsql.proto.SchemaGraphEdgeNode();
    const tmpGraphEdgeNode2 = new flatsql.proto.SchemaGraphEdgeNode();
    const edgePathBuilder = new EdgePathBuilder();

    for (let i = 0; i < layout.edgesLength(); ++i) {
        const edge = layout.edges(i, tmpGraphEdge)!;
        const begin = edge.nodesBegin();
        const countLeft = edge.nodeCountLeft();
        const countRight = edge.nodeCountRight();

        // For now, just draw n^2 edges
        for (let l = 0; l < countLeft; ++l) {
            const leftEdgeNode = layout.edgeNodes(begin + l, tmpGraphEdgeNode1)!;
            const leftTableId = leftEdgeNode.tableId();
            if (flatsql.QualifiedID.isNull(leftTableId)) {
                continue;
            }
            const leftNode = nodesByTable.get(leftTableId)!;

            for (let r = 0; r < countRight; ++r) {
                const rightEdgeNode = layout.edgeNodes(begin + countLeft + r, tmpGraphEdgeNode2)!;
                const rightTableId = rightEdgeNode.tableId();
                if (flatsql.QualifiedID.isNull(rightTableId)) {
                    continue;
                }
                const rightNode = nodesByTable.get(rightTableId)!;

                // Connection ids are composed out of the node indices
                const conn = GraphConnectionId.create(leftNode.nodeId, rightNode.nodeId);
                const connFlipped = GraphConnectionId.create(rightNode.nodeId, leftNode.nodeId);

                // Source == target?
                // Note that we may very well encounter self edges in SQL queries.
                // (self-join, correlated subqueries)
                if (leftNode.nodeId == rightNode.nodeId) {
                    continue;
                }

                // Already emitted?
                const prev = edges.get(conn) ?? edges.get(connFlipped);
                if (prev !== undefined) {
                    prev.queryEdgeIds.push(edge.queryEdgeId());
                    continue;
                }

                // Build edge info
                const fromX = leftNode.x + leftNode.width / 2;
                const fromY = leftNode.y + leftNode.height / 2;
                const toX = rightNode.x + rightNode.width / 2;
                const toY = rightNode.y + rightNode.height / 2;
                const edgeType = selectEdgeType(fromX, fromY, toX, toY, leftNode.width, leftNode.height);
                const fromPort = PORTS_FROM[edgeType];
                const toPort = PORTS_TO[edgeType];
                leftNode.ports |= fromPort;
                rightNode.ports |= toPort;
                const edgePath = buildEdgePath(
                    edgePathBuilder,
                    edgeType,
                    fromX,
                    fromY,
                    toX,
                    toY,
                    leftNode.width,
                    leftNode.height,
                    state.graphConfig.gridSize,
                    8,
                );
                edges.set(conn, {
                    connectionId: conn,
                    queryEdgeIds: [edge.queryEdgeId()],
                    fromNode: leftNode.nodeId,
                    fromPort,
                    fromTable: leftNode.tableId,
                    toNode: rightNode.nodeId,
                    toPort,
                    toTable: rightNode.tableId,
                    type: edgeType,
                    path: edgePath,
                });
            }
        }
    }

    // Compute graph debug info
    if (state.graphDebugInfo !== null) {
        console.log(state);
        debugInfo = buildDebugInfo(state, nodes);
    }
    console.log(nodesByTable);
    console.log(edges);
    return { nodes, nodesByTable, edges, debugInfo };
}
