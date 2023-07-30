import * as React from 'react';
import cn from 'classnames';

import { Action, Dispatch } from '../utils/action';
import { NodeLayout, EdgeLayout } from './graph_layout';
import { NodePort } from './graph_edges';

import iconTable from '../../static/svg/icons/table.svg';
import iconTableView from '../../static/svg/icons/table_border.svg';

import styles from './node_layer.module.css';

interface Props {
    className?: string;
    width: number;
    height: number;
    nodes: NodeLayout[];
    edges: EdgeLayout[];
    onFocusChanged: (node: number | null, port: NodePort | null) => void;
}

enum FocusEvent {
    CLICK,
    HOVER
}

interface FocusState {
    event: FocusEvent | null;
    node: number | null;
    port: number | null;
}

const MOUSE_ENTER = Symbol('MOUSE_ENTER');
const MOUSE_LEAVE = Symbol('MOUSE_LEAVE');
const CLICK = Symbol('CLICK');

type FocusAction =
   | Action<typeof MOUSE_ENTER, [number, number | null]>
   | Action<typeof MOUSE_LEAVE, [number, number | null]>
   | Action<typeof CLICK, [number, number | null]>;

const reducer = (state: FocusState, action: FocusAction): FocusState => {
    switch (action.type) {
        case MOUSE_ENTER: {
            if (state.event === FocusEvent.CLICK) {
                return state;
            }
            return {
                event: FocusEvent.HOVER,
                node: action.value[0],
                port: action.value[1]
            };
        };
        case MOUSE_LEAVE: {
            if (state.event === FocusEvent.CLICK) {
                return state;
            }
            return {
                event: null,
                node: null,
                port: null
            };
        };
        case CLICK: {
            if (state.node == action.value[0] && state.port == action.value[1] && state.event == FocusEvent.CLICK) {
                return {
                    event: null,
                    node: null,
                    port: null
                };
            }
            return {
                event: FocusEvent.CLICK,
                node: action.value[0],
                port: action.value[1]
            };
        };
    }
};

export function NodeLayer(props: Props) {
    const [state, dispatch] = React.useReducer(reducer, null, () => ({ event: null, node: null, port: null }));

    React.useEffect(() => {
        props.onFocusChanged(state.node, state.port);
    }, [state.node, state.port, props.onFocusChanged]);

    const onEnterNode = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const nodeId = event.currentTarget.getAttribute('data-node')!;
        dispatch({ type: MOUSE_ENTER, value: [+nodeId, null] })
    }, [dispatch]);
    const onLeaveNode = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const nodeId = event.currentTarget.getAttribute('data-node')!;
        dispatch({ type: MOUSE_LEAVE, value: [+nodeId, null] })
    }, []);
    const onEnterPort = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const nodeId = event.currentTarget.getAttribute('data-node')!;
        const portId = event.currentTarget.getAttribute('data-port')!;
        dispatch({ type: MOUSE_ENTER, value: [+nodeId, portId != null ? +portId : null] })
    }, []);
    const onLeavePort = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const nodeId = event.currentTarget.getAttribute('data-node')!;
        const portId = event.currentTarget.getAttribute('data-port')!;
        dispatch({ type: MOUSE_LEAVE, value: [+nodeId, +portId] })
    }, []);
    const onClickNode = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        event.stopPropagation();
        const nodeId = event.currentTarget.getAttribute('data-node')!;
        dispatch({ type: CLICK, value: [+nodeId, null] })
    }, []);
    const onClickPort = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        event.stopPropagation();
        const nodeId = event.currentTarget.getAttribute('data-node')!;
        const portId = event.currentTarget.getAttribute('data-port')!;
        dispatch({ type: CLICK, value: [+nodeId, +portId] })
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
