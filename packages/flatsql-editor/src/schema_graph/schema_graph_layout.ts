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

export interface TableEdgeLayout {}

export function layoutSchemaGraph(ctx: AppState): [NodeLayout[], TableEdgeLayout[]] {
    const data = ctx.scripts[ScriptKey.SCHEMA_SCRIPT].processed;
    const parsed = data.parsed?.read(new flatsql.proto.ParsedScript());
    const analyzed = data.analyzed?.read(new flatsql.proto.AnalyzedScript());
    if (!parsed || !analyzed || !ctx.graphLayout) {
        return [[], []];
    }

    const nodes: NodeLayout[] = [];
    const layout = ctx.graphLayout!.read(new flatsql.proto.SchemaGraphLayout());

    const protoGraphNode = new flatsql.proto.SchemaGraphNode();
    const protoGraphVertex = new flatsql.proto.SchemaGraphVertex();
    const protoTable = new flatsql.proto.Table();
    const protoTableColumn = new flatsql.proto.TableColumn();

    // Read nodes
    for (let i = 0; i < layout.nodesLength(); ++i) {
        const graphTable = layout.nodes(i, protoGraphNode);
        const position = graphTable!.position(protoGraphVertex)!;
        const table = analyzed.tables(graphTable!.tableId(), protoTable);
        const tableName = flatsql.FlatID.readTableName(table?.tableName()!, parsed, null);

        const columns: TableColumn[] = [];
        const columnsBegin = table!.columnsBegin();
        for (let j = 0; j < table!.columnCount(); ++j) {
            const column = analyzed.tableColumns(columnsBegin + j, protoTableColumn);
            const columnName = flatsql.FlatID.readName(column?.columnName()!, parsed, null)!;
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
            width: graphTable!.width(),
            height: graphTable!.height(),
        });
    }

    // Read edges
    for (let i = 0; i < layout.edgesLength(); ++i) {}

    // Collect nodes and edges
    return [nodes, []];
}
