import * as flatsql from '@ankoh/flatsql';

import { AppState, ScriptKey } from '../app_state';
import { EdgePathBuilder, EdgeType, PORTS_FROM, PORTS_TO, buildEdgePath, selectEdgeType } from './graph_edges';
import { DebugInfo, buildDebugInfo } from './debug_layer';

export interface SchemaGraphLayout {
    nodes: NodeLayout[];
    edges: EdgeLayout[];
    debugInfo: DebugInfo;
}

export interface NodeLayout {
    nodeId: number;
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

export interface EdgeLayout {
    edgeId: number;
    fromNodeId: number;
    toNodeId: number;
    type: EdgeType;
    path: string;
}

export function buildSchemaGraphLayout(state: AppState): SchemaGraphLayout {
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
            edges: [],
            debugInfo,
        };
    }
    const nodes: NodeLayout[] = [];
    const layout = state.graphLayout!.read(new flatsql.proto.SchemaGraphLayout());

    const protoGraphNode = new flatsql.proto.SchemaGraphNode();
    const protoGraphVertex = new flatsql.proto.SchemaGraphVertex();
    const protoTable = new flatsql.proto.Table();
    const protoTableColumn = new flatsql.proto.TableColumn();
    const protoEdge = new flatsql.proto.SchemaGraphEdge();

    const mainProcessed = state.scripts[ScriptKey.MAIN_SCRIPT].processed;
    const mainParsed = mainProcessed.parsed?.read(new flatsql.proto.ParsedScript()) ?? null;
    const mainAnalyzed = mainProcessed.analyzed?.read(new flatsql.proto.AnalyzedScript()) ?? null;
    const schemaProcessed = state.scripts[ScriptKey.SCHEMA_SCRIPT].processed;
    const schemaParsed = schemaProcessed.parsed?.read(new flatsql.proto.ParsedScript()) ?? null;
    const schemaAnalyzed = schemaProcessed.analyzed?.read(new flatsql.proto.AnalyzedScript()) ?? null;
    if (!mainParsed || !mainAnalyzed || !schemaParsed || !schemaAnalyzed || !state.graphLayout) {
        return {
            nodes: [],
            edges: [],
            debugInfo,
        };
    }

    // Collect all tables in the schema script
    for (let i = 0; i < layout.nodesLength(); ++i) {
        const node = layout.nodes(i, protoGraphNode);
        const position = node!.position(protoGraphVertex)!;
        const tableId = node!.tableId();

        // Table ID is null?
        // That means we couldn't resolve a table.
        // For now, just skip them.
        if (flatsql.FlatID.isNull(tableId)) {
            continue;
        }

        // Is an external table?
        // All ids of the external table need to be resolved using the analyzed schema script alone.
        if (flatsql.FlatID.isExternal(tableId)) {
            const table = schemaAnalyzed.tables(flatsql.FlatID.maskIndex(tableId), protoTable);
            const tableName = flatsql.FlatID.readTableName(table?.tableName()!, schemaParsed, null);
            const columns: TableColumn[] = [];
            const columnsBegin = table!.columnsBegin();
            for (let j = 0; j < table!.columnCount(); ++j) {
                const column = schemaAnalyzed.tableColumns(columnsBegin + j, protoTableColumn);
                const columnName = flatsql.FlatID.readName(column?.columnName()!, schemaParsed, null)!;
                columns.push({
                    name: columnName,
                });
            }
            nodes.push({
                nodeId: i,
                name: tableName.table ?? '',
                x: position.x(),
                y: position.y(),
                columns: columns,
                width: node!.width(),
                height: node!.height(),
                ports: 0,
            });
        } else {
            // Is an table defined in the main script?
            // Then we need to resolve names using the dictionaries of main and external script.
            const table = mainAnalyzed.tables(tableId, protoTable);
            const tableName = flatsql.FlatID.readTableName(table?.tableName()!, mainParsed, schemaParsed);
            const columns: TableColumn[] = [];
            const columnsBegin = table!.columnsBegin();
            for (let j = 0; j < table!.columnCount(); ++j) {
                const column = mainAnalyzed.tableColumns(columnsBegin + j, protoTableColumn);
                const columnName = flatsql.FlatID.readName(column?.columnName()!, mainParsed, schemaParsed)!;
                columns.push({
                    name: columnName,
                });
            }
            nodes.push({
                nodeId: i,
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
    const edges: EdgeLayout[] = [];
    const edgePathBuilder = new EdgePathBuilder();
    const edgeEmitted = new Set<number>();

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

                // Already emitted or source == target?
                // Note that we may very well encounter self edges in SQL queries.
                // (self-join, correlated subqueries)
                if (li == ri || edgeEmitted.has(li * nodes.length + ri)) {
                    continue;
                }
                edgeEmitted.add(li * nodes.length + ri);
                edgeEmitted.add(ri * nodes.length + li);

                // Build edge info
                const fromX = ln.x + ln.width / 2;
                const fromY = ln.y + ln.height / 2;
                const toX = rn.x + rn.width / 2;
                const toY = rn.y + rn.height / 2;
                const edgeType = selectEdgeType(fromX, fromY, toX, toY, ln.width, ln.height);
                nodes[li].ports |= PORTS_FROM[edgeType];
                nodes[ri].ports |= PORTS_TO[edgeType];
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
                edges.push({
                    edgeId: i,
                    fromNodeId: li,
                    toNodeId: ri,
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
