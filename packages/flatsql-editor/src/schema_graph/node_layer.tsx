import * as React from 'react';
import cn from 'classnames';

import { NodeLayout, NodePort } from './graph_layout';

import iconTable from '../../static/svg/icons/table.svg';
import iconTableView from '../../static/svg/icons/table_border.svg';

import styles from './node_layer.module.css';

function TableNode(props: NodeLayout) {
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
            <div className={styles.table_ports}>
            {((props.ports & NodePort.North) != 0) && <div className={cn(styles.table_port, styles.table_port_north)} />}
            {((props.ports & NodePort.East) != 0) && <div className={cn(styles.table_port, styles.table_port_east)} />}
            {((props.ports & NodePort.South) != 0) && <div className={cn(styles.table_port, styles.table_port_south)} />}
            {((props.ports & NodePort.West) != 0) && <div className={cn(styles.table_port, styles.table_port_west)} />}
            </div>
            <div className={styles.table_icon}>
                <svg width="20px" height="20px">
                    <use xlinkHref={`${iconTable}#sym`} />
                </svg>
            </div>
            <div className={styles.table_name}>{props.name}</div>
            <div className={styles.table_column_count}>{props.columns.length}</div>
        </div>
    );
}

interface Props {
    className?: string;
    width: number;
    height: number;
    nodes: any[];
    edges: any[];
}

export function NodeLayer(props: Props) {
    return (
        <div className={styles.graph_nodes}>
            {props.nodes.map(n => (
                <TableNode key={n.tableId} {...n} />
            ))}
        </div>
    );
}
