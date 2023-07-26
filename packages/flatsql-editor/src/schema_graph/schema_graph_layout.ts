import * as flatsql from '@ankoh/flatsql';
import { AppState, ScriptKey } from '../app_state';

interface TableColumn {
    name: string;
}

export interface NodeLayout {
    tableId: number;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    columns: TableColumn[];
}

export interface EdgeLayout {
    path: Float64Array;
}

export function layoutSchemaGraph(ctx: AppState): [NodeLayout[], EdgeLayout[]] {
    if (!ctx.graphLayout) {
        return [[], []];
    }
    const nodes: NodeLayout[] = [];
    const layout = ctx.graphLayout!.read(new flatsql.proto.SchemaGraphLayout());

    const protoGraphNode = new flatsql.proto.SchemaGraphNode();
    const protoGraphVertex = new flatsql.proto.SchemaGraphVertex();
    const protoTable = new flatsql.proto.Table();
    const protoTableColumn = new flatsql.proto.TableColumn();
    const protoEdge = new flatsql.proto.SchemaGraphEdge();

    const mainProcessed = ctx.scripts[ScriptKey.MAIN_SCRIPT].processed;
    const mainParsed = mainProcessed.parsed?.read(new flatsql.proto.ParsedScript()) ?? null;
    const mainAnalyzed = mainProcessed.analyzed?.read(new flatsql.proto.AnalyzedScript()) ?? null;
    const schemaProcessed = ctx.scripts[ScriptKey.SCHEMA_SCRIPT].processed;
    const schemaParsed = schemaProcessed.parsed?.read(new flatsql.proto.ParsedScript()) ?? null;
    const schemaAnalyzed = schemaProcessed.analyzed?.read(new flatsql.proto.AnalyzedScript()) ?? null;
    if (!mainParsed || !mainAnalyzed || !schemaParsed || !schemaAnalyzed || !ctx.graphLayout) {
        return [[], []];
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
                tableId: i,
                name: tableName.table ?? '',
                x: position.x(),
                y: position.y(),
                columns: columns,
                width: node!.width(),
                height: node!.height(),
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
                tableId: i,
                name: tableName.table ?? '',
                x: position.x(),
                y: position.y(),
                columns: columns,
                width: node!.width(),
                height: node!.height(),
            });
        }
    }

    // Read edges
    const edgeNodes = layout.edgeNodesArray()!;
    const edges: EdgeLayout[] = [];
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
                const path = new Float64Array(4);
                path[0] = ln.x + ln.width / 2;
                path[1] = ln.y + ln.height / 2;
                path[2] = rn.x + rn.width / 2;
                path[3] = rn.y + rn.height / 2;
                edges.push({
                    path,
                });
            }
        }
    }

    // Collect nodes and edges
    return [nodes, edges];
}

export interface DebugInfo {
    nodeCount: number;
    fromX: Float64Array;
    fromY: Float64Array;
    toX: Float64Array;
    toY: Float64Array;
    distance: Float64Array;
    repulsion: Float64Array;
}

export function layoutDebugInfo(ctx: AppState, nodes: NodeLayout[]): DebugInfo {
    if (ctx.graphDebugInfo == null) {
        return {
            nodeCount: 0,
            fromX: new Float64Array(),
            fromY: new Float64Array(),
            toX: new Float64Array(),
            toY: new Float64Array(),
            distance: new Float64Array(),
            repulsion: new Float64Array(),
        };
    }

    const protoDebugInfo = new flatsql.proto.SchemaGraphDebugInfo();
    const debugInfo = ctx.graphDebugInfo.read(protoDebugInfo)!;
    const nodeDistances = debugInfo.nodeDistancesArray()!;
    const nodeRepulsions = debugInfo.nodeRepulsionsArray()!;
    const n = nodeDistances.length;

    const out: DebugInfo = {
        nodeCount: nodes.length,
        fromX: new Float64Array(n),
        fromY: new Float64Array(n),
        toX: new Float64Array(n),
        toY: new Float64Array(n),
        distance: new Float64Array(n),
        repulsion: new Float64Array(n),
    };

    let pos = 0;
    for (let i = 0; i < nodes.length; ++i) {
        for (let j = i + 1; j < nodes.length; ++j) {
            const p = pos++;
            out.fromX[p] = nodes[i].x + nodes[i].width / 2;
            out.fromY[p] = nodes[i].y + nodes[i].height / 2;
            out.toX[p] = nodes[j].x + nodes[j].width / 2;
            out.toY[p] = nodes[j].y + nodes[j].height / 2;
            out.distance[p] = nodeDistances[p];
            out.repulsion[p] = nodeRepulsions[p];
        }
    }
    return out;
}
