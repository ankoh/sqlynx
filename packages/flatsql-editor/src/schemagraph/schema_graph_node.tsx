import * as flatsql from '@ankoh/flatsql';
import * as React from 'react';
import { FlatSQLState } from '../flatsql_state';
import { Edge, Handle, Node, NodeProps, Position } from 'reactflow';

import iconTable from '../../static/svg/icons/table.svg';
import iconTableView from '../../static/svg/icons/table_border.svg';

import styles from './schema_graph_node.module.css';

interface TableColumn {
    name: string;
}

export interface TableNodeProps {
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    columns: TableColumn[];
}

export const TableNode: React.FC<TableNodeProps> = (props: TableNodeProps) => {
    //            <Handle type="target" position={Position.Left} />
    //            <Handle type="source" position={Position.Right} />
    return (
        <div
            className={styles.table_node}
            style={{
                position: 'absolute',
                top: props.y,
                left: props.x,
                width: props.width,
                height: props.height,
            }}
        >
            <div className={styles.table_icon}>
                <svg width="20px" height="20px">
                    <use xlinkHref={`${iconTable}#sym`} />
                </svg>
            </div>
            <div className={styles.table_name}>{props.name}</div>
            <div className={styles.table_column_count}>{props.columns.length}</div>
        </div>
    );
};

export function layoutSchema(ctx: FlatSQLState): [TableNodeProps[], Edge[]] {
    const parsed = ctx.mainParsed?.read(new flatsql.proto.ParsedScript());
    const analyzed = ctx.mainAnalyzed?.read(new flatsql.proto.AnalyzedScript());
    if (!parsed || !analyzed) {
        return [[], []];
    }

    const nodes: TableNodeProps[] = [];
    const layout = ctx.schemaGraphLayout!.read(new flatsql.proto.SchemaGraphLayout());
    const tmpGraphTable = new flatsql.proto.SchemaGraphTable();
    const tmpGraphVertex = new flatsql.proto.SchemaGraphVertex();
    const tmpTable = new flatsql.proto.Table();
    const tmpTableColumn = new flatsql.proto.TableColumn();
    for (let i = 0; i < layout.tablesLength(); ++i) {
        const graphTable = layout.tables(i, tmpGraphTable);
        const position = graphTable!.position(tmpGraphVertex)!;
        const table = analyzed.tables(graphTable!.tableId(), tmpTable);
        const tableName = flatsql.FlatID.readTableName(table?.tableName()!, parsed, null);

        const columns: TableColumn[] = [];
        const columnsBegin = table!.columnsBegin();
        for (let j = 0; j < table!.columnCount(); ++j) {
            const column = analyzed.tableColumns(columnsBegin + j, tmpTableColumn);
            const columnName = flatsql.FlatID.readName(column?.columnName()!, parsed, null)!;
            columns.push({
                name: columnName,
            });
        }

        nodes.push({
            name: tableName.table ?? '',
            x: position.x(),
            y: position.y(),
            columns: columns,
            width: graphTable!.width(),
            height: graphTable!.height(),
        });
    }
    console.log(nodes);

    // Collect nodes and edges
    return [nodes, []];
}
