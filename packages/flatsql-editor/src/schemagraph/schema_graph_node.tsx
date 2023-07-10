import * as flatsql from '@ankoh/flatsql';
import * as React from 'react';
import { FlatSQLState } from '../flatsql_state';
import { Edge, Handle, Node, NodeProps, Position } from 'reactflow';

import styles from './schema_graph_node.module.css';

interface Column {
    name: string;
}

export interface TableData {
    name: string;
    columns: Column[];
    width: number;
    height: number;
}

export const TableNode: React.FC<NodeProps<TableData>> = (props: NodeProps<TableData>) => {
    //            <Handle type="target" position={Position.Left} />
    //            <Handle type="source" position={Position.Right} />
    return (
        <div
            className={styles.table_node}
            style={{
                width: props.data.width,
                height: props.data.height,
            }}
        >
            <div>{props.data.name}</div>
        </div>
    );
};

export function layoutSchema(ctx: FlatSQLState): [Node<TableData>[], Edge[]] {
    const parsed = ctx.mainParsed?.read(new flatsql.proto.ParsedScript());
    const analyzed = ctx.mainAnalyzed?.read(new flatsql.proto.AnalyzedScript());
    if (!parsed || !analyzed) {
        return [[], []];
    }

    const nodes: Node<TableData>[] = [];
    const layout = ctx.schemaGraphLayout!.read(new flatsql.proto.SchemaGraphLayout());
    const tableReader = new flatsql.proto.SchemaGraphTable();
    const tablePosition = new flatsql.proto.SchemaGraphVertex();
    for (let i = 0; i < layout.tablesLength(); ++i) {
        const table = layout.tables(i, tableReader);
        const pos = table!.position(tablePosition)!;
        nodes.push({
            id: table!.tableId().toString(),
            type: 'table',
            position: {
                x: pos.x(),
                y: pos.y(),
            },
            data: {
                name: table!.tableId().toString(),
                columns: [],
                width: table!.width(),
                height: table!.height(),
            },
        });
    }
    console.log(nodes);

    // Collect nodes and edges
    return [nodes, []];
}
