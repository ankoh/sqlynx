import * as sqlynx from '@ankoh/sqlynx';

import { AppState, ScriptKey } from '../../state/app_state';
import { EdgePathBuilder, EdgeType, PORTS_FROM, PORTS_TO, buildEdgePath, selectEdgeType } from './graph_edges';

export interface GraphViewModel {
    nodes: NodeViewModel[];
    nodesByTable: Map<sqlynx.QualifiedID.Value, NodeViewModel>;
    edges: Map<GraphConnectionId.Value, EdgeViewModel>;
}

export interface NodeViewModel {
    nodeId: number;
    tableId: sqlynx.QualifiedID.Value;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    columns: TableColumn[];
    ports: number;
    peerCount: number;
}

interface TableColumn {
    name: string;
}

export interface EdgeViewModel {
    connectionId: GraphConnectionId.Value;
    queryEdges: Set<sqlynx.QualifiedID.Value>;
    columnRefs: Set<sqlynx.QualifiedID.Value>;
    fromNode: number;
    fromTable: sqlynx.QualifiedID.Value;
    fromPort: number;
    toNode: number;
    toTable: sqlynx.QualifiedID.Value;
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
    if (!state.graphLayout) {
        return {
            nodes: [],
            nodesByTable: new Map(),
            edges: new Map(),
        };
    }
    const nodes = [];
    const nodesByTable = new Map<sqlynx.QualifiedID.Value, NodeViewModel>();
    const edges = new Map<GraphConnectionId.Value, EdgeViewModel>();

    // Collect parsed and analyzed scripts
    const mainProcessed = state.scripts[ScriptKey.MAIN_SCRIPT].processed;
    const schemaProcessed = state.scripts[ScriptKey.SCHEMA_SCRIPT].processed;
    const parsedScripts: { [key: number]: sqlynx.proto.ParsedScript | null } = {
        [ScriptKey.MAIN_SCRIPT]: mainProcessed.parsed?.read(new sqlynx.proto.ParsedScript()) ?? null,
        [ScriptKey.SCHEMA_SCRIPT]: schemaProcessed.parsed?.read(new sqlynx.proto.ParsedScript()) ?? null,
    };
    const analyzedScripts: { [key: number]: sqlynx.proto.AnalyzedScript | null } = {
        [ScriptKey.MAIN_SCRIPT]: mainProcessed.analyzed?.read(new sqlynx.proto.AnalyzedScript()) ?? null,
        [ScriptKey.SCHEMA_SCRIPT]: schemaProcessed.analyzed?.read(new sqlynx.proto.AnalyzedScript()) ?? null,
    };

    if (!state.graphLayout) {
        return {
            nodes: [],
            nodesByTable: new Map(),
            edges: new Map(),
        };
    }
    const tmpGraphTableNode = new sqlynx.proto.SchemaGraphTableNode();
    const tmpGraphVertex = new sqlynx.proto.SchemaGraphVertex();
    const tmpTable = new sqlynx.proto.Table();
    const tmpTableColumn = new sqlynx.proto.TableColumn();

    // Collect all tables in the schema script
    const layout = state.graphLayout!.read(new sqlynx.proto.SchemaGraphLayout());
    for (let nodeId = 0; nodeId < layout.tableNodesLength(); ++nodeId) {
        const node = layout.tableNodes(nodeId, tmpGraphTableNode);
        const position = node!.position(tmpGraphVertex)!;
        const tableId = node!.tableId();

        // Table ID is null?
        // That means we couldn't resolve a table.
        // For now, just skip them.
        if (sqlynx.QualifiedID.isNull(tableId)) {
            continue;
        }

        // Is an external table?
        const context = sqlynx.QualifiedID.getContext(tableId);
        const analyzed = analyzedScripts[context] ?? null;

        if (analyzed) {
            const tableIdx = sqlynx.QualifiedID.getIndex(tableId);
            const table = analyzed.tables(tableIdx, tmpTable);
            const tableName = sqlynx.QualifiedID.readTableName(table?.tableName()!, parsedScripts);
            const columns: TableColumn[] = [];
            const columnsBegin = table!.columnsBegin();
            for (let j = 0; j < table!.columnCount(); ++j) {
                const column = analyzed.tableColumns(columnsBegin + j, tmpTableColumn);
                const columnName = sqlynx.QualifiedID.readName(column?.columnName()!, parsedScripts)!;
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
                peerCount: 0,
            };
            nodes.push(viewModel);
            nodesByTable.set(tableId, viewModel);
        }
    }

    // Read edges
    const tmpGraphEdge = new sqlynx.proto.SchemaGraphEdge();
    const tmpGraphEdgeNode1 = new sqlynx.proto.SchemaGraphEdgeNode();
    const tmpGraphEdgeNode2 = new sqlynx.proto.SchemaGraphEdgeNode();
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
            if (sqlynx.QualifiedID.isNull(leftTableId)) {
                continue;
            }
            const leftNode = nodesByTable.get(leftTableId)!;

            for (let r = 0; r < countRight; ++r) {
                const rightEdgeNode = layout.edgeNodes(begin + countLeft + r, tmpGraphEdgeNode2)!;
                const rightTableId = rightEdgeNode.tableId();
                if (sqlynx.QualifiedID.isNull(rightTableId)) {
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

    return { nodes, nodesByTable, edges };
}
