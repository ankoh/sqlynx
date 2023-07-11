import * as flatsql from '@ankoh/flatsql';
import * as React from 'react';
import { FlatSQLState } from '../flatsql_state';
import { Edge, Handle, Node, NodeProps, Position } from 'reactflow';

import iconTable from '../../static/svg/icons/table.svg';
import iconTableView from '../../static/svg/icons/table_border.svg';

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
            <div className={styles.table_icon}>
                <svg width="20px" height="20px">
                    <use xlinkHref={`${iconTable}#sym`} />
                </svg>
            </div>
            <div className={styles.table_name}>{props.data.name}</div>
            <div className={styles.table_column_count}>{props.data.columns.length}</div>
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
    const tmpGraphTable = new flatsql.proto.SchemaGraphTable();
    const tmpGraphVertex = new flatsql.proto.SchemaGraphVertex();
    const tmpTable = new flatsql.proto.Table();
    for (let i = 0; i < layout.tablesLength(); ++i) {
        const graphTable = layout.tables(i, tmpGraphTable);
        const position = graphTable!.position(tmpGraphVertex)!;
        const table = analyzed.tables(graphTable!.tableId(), tmpTable);
        const tableName = flatsql.FlatID.readTableName(table?.tableName()!, parsed, null);

        nodes.push({
            id: i.toString(),
            type: 'table',
            position: {
                x: position.x(),
                y: position.y(),
            },
            data: {
                name: tableName.table ?? '',
                columns: [],
                width: graphTable!.width(),
                height: graphTable!.height(),
            },
        });
    }
    console.log(nodes);

    // Collect nodes and edges
    return [nodes, []];
}
