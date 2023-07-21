import * as flatsql from '@ankoh/flatsql';
import * as React from 'react';
import { AppState, ScriptKey } from '../app_state';

import iconTable from '../../static/svg/icons/table.svg';
import iconTableView from '../../static/svg/icons/table_border.svg';

import styles from './schema_graph_node.module.css';

interface TableColumn {
    name: string;
}

export interface TableNodeProps {
    tableId: number;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    columns: TableColumn[];
}

export interface TableEdgeProps {}

export const TableNode: React.FC<TableNodeProps> = (props: TableNodeProps) => {
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

export function layoutSchema(ctx: AppState): [TableNodeProps[], TableEdgeProps[]] {
    const data = ctx.scripts[ScriptKey.SCHEMA_SCRIPT].buffers;
    const parsed = data.parsed?.read(new flatsql.proto.ParsedScript());
    const analyzed = data.analyzed?.read(new flatsql.proto.AnalyzedScript());
    if (!parsed || !analyzed || !ctx.graphLayout) {
        return [[], []];
    }

    const nodes: TableNodeProps[] = [];
    const layout = ctx.graphLayout!.read(new flatsql.proto.SchemaGraphLayout());
    const tmpGraphNode = new flatsql.proto.SchemaGraphNode();
    const tmpGraphVertex = new flatsql.proto.SchemaGraphVertex();
    const tmpTable = new flatsql.proto.Table();
    const tmpTableColumn = new flatsql.proto.TableColumn();
    for (let i = 0; i < layout.nodesLength(); ++i) {
        const graphTable = layout.nodes(i, tmpGraphNode);
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
            tableId: i,
            name: tableName.table ?? '',
            x: position.x(),
            y: position.y(),
            columns: columns,
            width: graphTable!.width(),
            height: graphTable!.height(),
        });
    }

    console.log(layout.edgesLength());

    // Collect nodes and edges
    return [nodes, []];
}
