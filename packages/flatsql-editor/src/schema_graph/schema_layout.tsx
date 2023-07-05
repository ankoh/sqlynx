import * as flatsql from '@ankoh/flatsql';
import * as React from 'react';
import { EditorContext } from '../editor/editor_context';
import { Edge, Handle, Node, NodeProps, Position } from 'reactflow';

import styles from './schema_layout.module.css';

interface Column {
    name: string;
}

export interface TableData {
    name: string;
    columns: Column[];
}

export const TableNode: React.FC<NodeProps<TableData>> = (props: NodeProps<TableData>) => {
    return (
        <div className={styles.table_node}>
            <Handle type="target" position={Position.Left} />
            <div>{props.data.name}</div>
            <Handle type="source" position={Position.Right} />
        </div>
    );
};

export function layoutSchema(ctx: EditorContext): [Node<TableData>[], Edge[]] {
    const parsed = ctx.mainParsed?.read(new flatsql.proto.ParsedScript());
    const analyzed = ctx.mainAnalyzed?.read(new flatsql.proto.AnalyzedScript());
    if (!parsed || !analyzed) {
        return [[], []];
    }

    // Collect tables
    const tables = [];
    const tableCount = analyzed.tablesLength();
    const tmpTableName = new flatsql.proto.QualifiedTableName();
    const tmpTable = new flatsql.proto.Table();
    const tmpTableColumn = new flatsql.proto.TableColumn();
    for (let i = 0; i < tableCount; ++i) {
        const table = analyzed.tables(i, tmpTable)!;
        const columnCount = table.columnCount();
        const columnsBegin = table.columnsBegin();
        const columns = [];
        for (let j = 0; j < columnCount; ++j) {
            const tableColumn = analyzed.tableColumns(columnsBegin + j, tmpTableColumn)!;
            columns.push(flatsql.FlatID.readName(tableColumn.columnName(), parsed));
        }
        const tableName = table.tableName(tmpTableName)!;
        tables.push({
            name: flatsql.FlatID.readTableName(tableName, parsed),
            columns,
        });
    }
    console.log(tables);

    // Collect query edges
    const edgeCount = analyzed.graphEdgesLength();
    const tmpEdge = new flatsql.proto.QueryGraphEdge();
    const tmpNode = new flatsql.proto.QueryGraphEdgeNode();
    for (let i = 0; i < edgeCount; ++i) {
        const edge = analyzed.graphEdges(i, tmpEdge)!;
        let reader = edge?.nodesBegin()!;
        const countLeft = edge?.nodeCountLeft()!;
        const countRight = edge?.nodeCountRight()!;
        let left = [],
            right = [];
        for (let j = 0; j < countLeft; ++j) {
            const node = analyzed.graphEdgeNodes(reader++, tmpNode)!;
            left.push(node.columnReferenceId());
        }
        for (let j = 0; j < countRight; ++j) {
            const node = analyzed.graphEdgeNodes(reader++, tmpNode)!;
            right.push(node.columnReferenceId());
        }
        console.log({
            edgeId: i,
            left,
            right,
        });
    }

    // Collect nodes and edges
    const nodes: Node<TableData>[] = [
        { id: 'node-1', type: 'table', position: { x: 200, y: 100 }, data: { name: 'foo', columns: [] } },
        { id: 'node-2', type: 'table', position: { x: 300, y: 200 }, data: { name: 'bar', columns: [] } },
    ];
    const edges: Edge[] = [{ id: 'edge-1', source: 'node-1', target: 'node-2', type: 'step' }];
    return [nodes, edges];
}
