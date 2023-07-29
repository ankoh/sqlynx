import * as React from 'react';
import cn from 'classnames';

import { NodeLayout } from './graph_layout';
import { NodePort } from './graph_edges';

import iconTable from '../../static/svg/icons/table.svg';
import iconTableView from '../../static/svg/icons/table_border.svg';

import styles from './node_layer.module.css';

interface Props {
    className?: string;
    width: number;
    height: number;
    nodes: NodeLayout[];
    edges: any[];
}

export function NodeLayer(props: Props) {
    const onEnterNode = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const nodeId = event.currentTarget.getAttribute('data-node');
        console.log(`ENTER NODE ${nodeId}`);
    }, []);
    const onLeaveNode = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const nodeId = event.currentTarget.getAttribute('data-node');
        console.log(`LEAVE NODE ${nodeId}`);
    }, []);
    const onEnterPort = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const nodeId = event.currentTarget.getAttribute('data-node');
        const portId = event.currentTarget.getAttribute('data-port');
        console.log(`ENTER PORT ${nodeId} ${portId}`);
    }, []);
    const onLeavePort = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const nodeId = event.currentTarget.getAttribute('data-node');
        const portId = event.currentTarget.getAttribute('data-port');
        console.log(`LEAVE PORT ${nodeId} ${portId}`);
    }, []);
    const onClickNode = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        event.stopPropagation();
        const nodeId = event.currentTarget.getAttribute('data-node');
        console.log(`CLICK NODE ${nodeId}`);
    }, []);
    const onClickPort = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        event.stopPropagation();
        const nodeId = event.currentTarget.getAttribute('data-node');
        const portId = event.currentTarget.getAttribute('data-port');
        console.log(`CLICK PORT ${nodeId} ${portId}`);
    }, []);

    const Port = (props: { node: number; port: NodePort; className: string }) => (
        <div
            className={cn(styles.table_port, props.className)}
            data-node={props.node}
            data-port={props.port}
            onMouseEnter={onEnterPort}
            onMouseLeave={onLeavePort}
            onClick={onClickPort}
        />
    );
    return (
        <div className={styles.graph_nodes}>
            {props.nodes.map((n, i) => (
                <div
                    key={i}
                    className={styles.table_node}
                    style={{
                        position: 'absolute',
                        top: n.y,
                        left: n.x,
                        width: n.width,
                        height: n.height,
                    }}
                    data-node={i}
                    onMouseEnter={onEnterNode}
                    onMouseLeave={onLeaveNode}
                    onClick={onClickNode}
                >
                    <div className={styles.table_ports}>
                        {(n.ports & NodePort.North) != 0 && (
                            <Port node={i} port={NodePort.North} className={styles.table_port_north} />
                        )}
                        {(n.ports & NodePort.East) != 0 && (
                            <Port node={i} port={NodePort.East} className={styles.table_port_east} />
                        )}
                        {(n.ports & NodePort.South) != 0 && (
                            <Port node={i} port={NodePort.South} className={styles.table_port_south} />
                        )}
                        {(n.ports & NodePort.West) != 0 && (
                            <Port node={i} port={NodePort.West} className={styles.table_port_west} />
                        )}
                    </div>
                    <div className={styles.table_icon}>
                        <svg width="20px" height="20px">
                            <use xlinkHref={`${iconTable}#sym`} />
                        </svg>
                    </div>
                    <div className={styles.table_name}>{n.name}</div>
                    <div className={styles.table_column_count}>{n.columns.length}</div>
                </div>
            ))}
        </div>
    );
}
