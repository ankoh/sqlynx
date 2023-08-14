import * as flatsql from '@ankoh/flatsql';

import { AppState, GraphConnectionId, ScriptKey, buildGraphConnectionId } from '../app_state';
import { EdgePathBuilder, EdgeType, PORTS_FROM, PORTS_TO, buildEdgePath, selectEdgeType } from './graph_edges';
import { DebugInfo, buildDebugInfo } from './debug_layer';

export interface SchemaGraphViewModel {
    nodes: NodeViewModel[];
    edges: Map<GraphConnectionId, EdgeViewModel>;
    debugInfo: DebugInfo | null;
}

export interface NodeViewModel {
    nodeId: number;
    tableId: bigint;
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
    edgeId: number;
    fromNode: number;
    fromPort: number;
    fromTable: bigint;
    toNode: number;
    toPort: number;
    toTable: bigint;
    type: EdgeType;
    path: string;
}

export function computeSchemaGraphViewModel(state: AppState): SchemaGraphViewModel {
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
            edges: new Map(),
            debugInfo,
        };
    }
    const nodes: NodeViewModel[] = [];
    const edges = new Map<GraphConnectionId, EdgeViewModel>();

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
            edges: new Map(),
            debugInfo,
        };
    }
    const tmpGraphNode = new flatsql.proto.SchemaGraphNode();
    const tmpGraphVertex = new flatsql.proto.SchemaGraphVertex();
    const tmpTable = new flatsql.proto.Table();
    const tmpTableColumn = new flatsql.proto.TableColumn();

    // Collect all tables in the schema script
    const layout = state.graphLayout!.read(new flatsql.proto.SchemaGraphLayout());
    for (let i = 0; i < layout.nodesLength(); ++i) {
        const node = layout.nodes(i, tmpGraphNode);
        const position = node!.position(tmpGraphVertex)!;
        const tableId = node!.tableId();

        // Table ID is null?
        // That means we couldn't resolve a table.
        // For now, just skip them.
        if (flatsql.FlatID.isNull(tableId)) {
            continue;
        }

        // Is an external table?
        const context = flatsql.FlatID.GetContext(tableId);
        const analyzed = analyzedScripts[context] ?? null;

        if (analyzed) {
            const table = analyzed.tables(flatsql.FlatID.getIndex(tableId), tmpTable);
            const tableName = flatsql.FlatID.readTableName(table?.tableName()!, parsedScripts);
            const columns: TableColumn[] = [];
            const columnsBegin = table!.columnsBegin();
            for (let j = 0; j < table!.columnCount(); ++j) {
                const column = analyzed.tableColumns(columnsBegin + j, tmpTableColumn);
                const columnName = flatsql.FlatID.readName(column?.columnName()!, parsedScripts)!;
                columns.push({
                    name: columnName,
                });
            }
            nodes.push({
                nodeId: i,
                tableId,
                name: tableName.table ?? '',
                x: position.x(),
                y: position.y(),
                columns: columns,
                width: node!.width(),
                height: node!.height(),
                ports: 0,
            });
        }
    }

    // Read edges
    const edgeNodes = layout.edgeNodesArray()!;
    const edgePathBuilder = new EdgePathBuilder();
    const protoEdge = new flatsql.proto.SchemaGraphEdge();

    for (let i = 0; i < layout.edgesLength(); ++i) {
        const edge = layout.edges(i, protoEdge)!;
        const begin = edge.nodesBegin();
        const countLeft = edge.nodeCountLeft();
        const countRight = edge.nodeCountRight();

        // For now, just draw n^2 edges
        for (let l = 0; l < countLeft; ++l) {
            const li = edgeNodes[begin + l];
            const ln = nodes[li];

            for (let r = 0; r < countRight; ++r) {
                const ri = edgeNodes[begin + countLeft + r];
                const rn = nodes[ri];
                const connId = buildGraphConnectionId(li, ri);
                const connIdReverse = buildGraphConnectionId(ri, li);

                // Already emitted or source == target?
                // Note that we may very well encounter self edges in SQL queries.
                // (self-join, correlated subqueries)
                if (li == ri || edges.has(connId) || edges.has(connIdReverse)) {
                    continue;
                }

                // Build edge info
                const fromX = ln.x + ln.width / 2;
                const fromY = ln.y + ln.height / 2;
                const toX = rn.x + rn.width / 2;
                const toY = rn.y + rn.height / 2;
                const edgeType = selectEdgeType(fromX, fromY, toX, toY, ln.width, ln.height);
                const fromPort = PORTS_FROM[edgeType];
                const toPort = PORTS_TO[edgeType];
                nodes[li].ports |= fromPort;
                nodes[ri].ports |= toPort;
                const edgePath = buildEdgePath(
                    edgePathBuilder,
                    edgeType,
                    fromX,
                    fromY,
                    toX,
                    toY,
                    ln.width,
                    ln.height,
                    state.graphConfig.gridSize,
                    8,
                );
                edges.set(connId, {
                    edgeId: i,
                    fromNode: li,
                    fromPort,
                    fromTable: ln.tableId,
                    toNode: ri,
                    toPort,
                    toTable: rn.tableId,
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
    return { nodes, edges, debugInfo };
}
