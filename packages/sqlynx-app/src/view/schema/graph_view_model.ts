import * as sqlynx from '@ankoh/sqlynx';

import { ScriptState, ScriptKey } from '../../scripts/script_state';
import { EdgePathBuilder, EdgeType, PORTS_FROM, PORTS_TO, buildEdgePath, selectEdgeType } from './graph_edges';

export interface GraphBoundaries {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    totalWidth: number;
    totalHeight: number;
}

export interface GraphViewModel {
    nodes: NodeViewModel[];
    nodesByTable: Map<sqlynx.ExternalObjectID.Value, NodeViewModel>;
    edges: Map<GraphConnectionId.Value, EdgeViewModel>;
    boundaries: GraphBoundaries;
}

export interface NodeViewModel {
    nodeId: number;
    tableId: sqlynx.ExternalObjectID.Value;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    columns: TableColumn[];
    ports: number;
    peerCount: number;
    isReferenced: boolean;
}

interface TableColumn {
    name: string;
}

export interface EdgeViewModel {
    connectionId: GraphConnectionId.Value;
    queryEdges: Set<sqlynx.ExternalObjectID.Value>;
    columnRefs: Set<sqlynx.ExternalObjectID.Value>;
    fromNode: number;
    fromTable: sqlynx.ExternalObjectID.Value;
    fromPort: number;
    toNode: number;
    toTable: sqlynx.ExternalObjectID.Value;
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

export function computeGraphViewModel(state: ScriptState): GraphViewModel {
    const boundaries: GraphBoundaries = {
        minX: 0,
        maxX: 0,
        minY: 0,
        maxY: 0,
        totalWidth: 0,
        totalHeight: 0,
    };
    if (!state.graphLayout) {
        return {
            nodes: [],
            nodesByTable: new Map(),
            edges: new Map(),
            boundaries,
        };
    }
    const nodes = [];
    const nodesByTable = new Map<sqlynx.ExternalObjectID.Value, NodeViewModel>();
    const edges = new Map<GraphConnectionId.Value, EdgeViewModel>();

    // Collect parsed and analyzed scripts
    const mainProcessed = state.scripts[ScriptKey.MAIN_SCRIPT]?.processed;
    const schemaProcessed = state.scripts[ScriptKey.SCHEMA_SCRIPT]?.processed;
    const analyzedScripts: { [key: number]: sqlynx.proto.AnalyzedScript | null } = {
        [ScriptKey.MAIN_SCRIPT]: mainProcessed?.analyzed?.read(new sqlynx.proto.AnalyzedScript()) ?? null,
        [ScriptKey.SCHEMA_SCRIPT]: schemaProcessed?.analyzed?.read(new sqlynx.proto.AnalyzedScript()) ?? null,
    };

    if (!state.graphLayout) {
        return {
            nodes: [],
            nodesByTable: new Map(),
            edges: new Map(),
            boundaries,
        };
    }
    const tmpGraphTableNode = new sqlynx.proto.QueryGraphLayoutTableNode();
    const tmpGraphVertex = new sqlynx.proto.QueryGraphLayoutVertex();
    const tmpTable = new sqlynx.proto.Table();
    const tmpTableColumn = new sqlynx.proto.TableColumn();

    // Collect all tables in the schema script
    const layout = state.graphLayout!.read(new sqlynx.proto.QueryGraphLayout());
    for (let nodeId = 0; nodeId < layout.tableNodesLength(); ++nodeId) {
        const node = layout.tableNodes(nodeId, tmpGraphTableNode);
        const position = node!.position(tmpGraphVertex)!;
        const tableId = node!.tableId();
        const nodeIsReferenced = node!.isReferenced() != 0;

        // Table ID is null?
        // That means we couldn't resolve a table.
        // For now, just skip them.
        if (sqlynx.ExternalObjectID.isNull(tableId)) {
            continue;
        }

        // Is an external table?
        const externalId = sqlynx.ExternalObjectID.getExternalID(tableId);
        const analyzed = analyzedScripts[externalId] ?? null;

        if (analyzed) {
            const tableIdx = sqlynx.ExternalObjectID.getObjectID(tableId);
            const table = analyzed.tables(tableIdx, tmpTable);
            const tableName = table?.tableName();
            const columns: TableColumn[] = [];
            for (let j = 0; j < table!.tableColumnsLength(); ++j) {
                const column = table?.tableColumns(j, tmpTableColumn);
                const columnName = column?.columnName()!;
                columns.push({
                    name: columnName,
                });
            }
            const viewModel: NodeViewModel = {
                nodeId,
                tableId,
                name: tableName?.tableName() ?? '',
                x: position.x(),
                y: position.y(),
                columns: columns,
                width: node!.width(),
                height: node!.height(),
                ports: 0,
                peerCount: 0,
                isReferenced: nodeIsReferenced,
            };
            nodes.push(viewModel);
            nodesByTable.set(tableId, viewModel);
            boundaries.minX = Math.min(boundaries.minX, viewModel.x);
            boundaries.maxX = Math.max(boundaries.maxX, viewModel.x + viewModel.width);
            boundaries.minY = Math.min(boundaries.minY, viewModel.y);
            boundaries.maxY = Math.max(boundaries.maxY, viewModel.y + viewModel.height);
        }
    }

    // Read edges
    const tmpGraphEdge = new sqlynx.proto.QueryGraphLayoutEdge();
    const tmpGraphEdgeNode1 = new sqlynx.proto.QueryGraphLayoutEdgeNode();
    const tmpGraphEdgeNode2 = new sqlynx.proto.QueryGraphLayoutEdgeNode();
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
            if (sqlynx.ExternalObjectID.isNull(leftTableId)) {
                continue;
            }
            const leftNode = nodesByTable.get(leftTableId)!;
            if (!leftNode) {
                continue;
            }

            for (let r = 0; r < countRight; ++r) {
                const rightEdgeNode = layout.edgeNodes(begin + countLeft + r, tmpGraphEdgeNode2)!;
                const rightTableId = rightEdgeNode.tableId();
                if (sqlynx.ExternalObjectID.isNull(rightTableId)) {
                    continue;
                }
                const rightNode = nodesByTable.get(rightTableId)!;
                leftNode.peerCount += 1;
                rightNode.peerCount += 1;

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
                    prev.queryEdges.add(edge.queryEdgeId());
                    prev.columnRefs.add(leftEdgeNode.columnReferenceId());
                    prev.columnRefs.add(rightEdgeNode.columnReferenceId());
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
                    state.graphConfig.cellWidth,
                    state.graphConfig.cellHeight,
                    8,
                );
                edges.set(conn, {
                    connectionId: conn,
                    queryEdges: new Set([edge.queryEdgeId()]),
                    columnRefs: new Set([leftEdgeNode.columnReferenceId(), rightEdgeNode.columnReferenceId()]),
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

    boundaries.totalWidth = boundaries.maxX - boundaries.minX;
    boundaries.totalHeight = boundaries.maxY - boundaries.minY;
    return { nodes, nodesByTable, edges, boundaries };
}
