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
            const nodeL = nodes[edgeNodes[begin + l]];
            for (let r = 0; r < countRight; ++r) {
                const nodeR = nodes[edgeNodes[begin + countLeft + r]];
                const path = new Float64Array(4);
                path[0] = nodeL.x + nodeL.width / 2;
                path[1] = nodeL.y + nodeL.height / 2;
                path[2] = nodeR.x + nodeR.width / 2;
                path[3] = nodeR.y + nodeR.height / 2;
                edges.push({
                    path,
                });
            }
        }
    }

    // Collect nodes and edges
    return [nodes, edges];
}
