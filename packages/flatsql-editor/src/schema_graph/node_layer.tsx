import * as React from 'react';
import cn from 'classnames';

import { Action } from '../utils/action';
import { NodeLayout, EdgeLayout } from './graph_layout';
import { NodePort } from './graph_edges';
import { FocusInfo, GraphNodeDescriptor } from '../app_state';

import iconTable from '../../static/svg/icons/table.svg';
import iconTableView from '../../static/svg/icons/table_border.svg';

import styles from './node_layer.module.css';

interface Props {
    className?: string;
    width: number;
    height: number;
    nodes: NodeLayout[];
    edges: EdgeLayout[];
    focus: FocusInfo | null;
    onFocusChanged: (target: GraphNodeDescriptor | null) => void;
}

enum FocusEvent {
    CLICK,
    HOVER,
}

interface FocusState {
    event: FocusEvent | null;
    target: GraphNodeDescriptor | null;
}

const MOUSE_ENTER = Symbol('MOUSE_ENTER');
const MOUSE_LEAVE = Symbol('MOUSE_LEAVE');
const CLICK = Symbol('CLICK');

type FocusAction =
    | Action<typeof MOUSE_ENTER, GraphNodeDescriptor>
    | Action<typeof MOUSE_LEAVE, GraphNodeDescriptor>
    | Action<typeof CLICK, GraphNodeDescriptor>;

const reducer = (state: FocusState, action: FocusAction): FocusState => {
    switch (action.type) {
        case MOUSE_ENTER: {
            // Currently focused through click?
            if (state.event === FocusEvent.CLICK) {
                return state;
            }
            // Node MouseEnter event but we're already in the same node?
            if (
                action.value.protoNodeId === state.target?.protoNodeId &&
                (action.value.port === state.target.port || action.value.port == null)
            ) {
                return state;
            }
            return {
                event: FocusEvent.HOVER,
                target: action.value,
            };
        }
        case MOUSE_LEAVE: {
            // Currently focused through click?
            if (state.event === FocusEvent.CLICK) {
                return state;
            }
            // Did we leave the port? Then we're still waiting for the node MouseLeave event
            if (
                action.value.protoNodeId === state.target?.protoNodeId &&
                action.value.port === state.target.port &&
                state.target.port != null
            ) {
                return {
                    ...state,
                    target: null,
                };
            }
            // Otherwise we assume it's the MouseLeave event of the node
            return {
                event: null,
                target: null,
            };
        }
        case CLICK: {
            if (
                action.value.protoNodeId == state.target?.protoNodeId &&
                action.value.port == state.target.port &&
                state.event == FocusEvent.CLICK
            ) {
                return {
                    event: null,
                    target: null,
                };
            }
            return {
                event: FocusEvent.CLICK,
                target: action.value,
            };
        }
    }
};

export function NodeLayer(props: Props) {
    const [state, dispatch] = React.useReducer(reducer, null, () => ({ event: null, target: null, port: null }));

    React.useEffect(() => {
        props.onFocusChanged(state.target);
    }, [state.target, props.onFocusChanged]);

    const onEnterNode = React.useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            const nodeId = event.currentTarget.getAttribute('data-node')!;
            dispatch({ type: MOUSE_ENTER, value: { protoNodeId: +nodeId, port: null } });
        },
        [dispatch],
    );
    const onLeaveNode = React.useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            const nodeId = event.currentTarget.getAttribute('data-node')!;
            dispatch({ type: MOUSE_LEAVE, value: { protoNodeId: +nodeId, port: null } });
        },
        [dispatch],
    );
    const onEnterPort = React.useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            const nodeId = event.currentTarget.getAttribute('data-node')!;
            const portId = event.currentTarget.getAttribute('data-port')!;
            dispatch({ type: MOUSE_ENTER, value: { protoNodeId: +nodeId, port: portId != null ? +portId : null } });
        },
        [dispatch],
    );
    const onLeavePort = React.useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            const nodeId = event.currentTarget.getAttribute('data-node')!;
            const portId = event.currentTarget.getAttribute('data-port')!;
            dispatch({ type: MOUSE_LEAVE, value: { protoNodeId: +nodeId, port: +portId } });
        },
        [dispatch],
    );
    const onClickNode = React.useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            const nodeId = event.currentTarget.getAttribute('data-node')!;
            dispatch({ type: CLICK, value: { protoNodeId: +nodeId, port: null } });
        },
        [dispatch],
    );
    const onClickPort = React.useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            event.stopPropagation();
            const nodeId = event.currentTarget.getAttribute('data-node')!;
            const portId = event.currentTarget.getAttribute('data-port')!;
            dispatch({ type: CLICK, value: { protoNodeId: +nodeId, port: +portId } });
        },
        [dispatch],
    );

    const Port = (props: { node: number; port: NodePort; focusedPorts: number; className: string }) => (
        <div
            className={cn(styles.table_port, props.className, {
                [styles.table_port_focused]: (props.focusedPorts & props.port) != 0,
            })}
            data-node={props.node}
            data-port={props.port}
            onMouseEnter={onEnterPort}
            onMouseLeave={onLeavePort}
            onClick={onClickPort}
        />
    );
    return (
        <div className={styles.graph_nodes}>
            {props.nodes.map(n => {
                const focusedPorts = props.focus?.graphLayoutNodes?.get(n.nodeId) ?? 0;
                return (
                    <div
                        key={n.nodeId}
                        className={styles.table_node}
                        style={{
                            position: 'absolute',
                            top: n.y,
                            left: n.x,
                            width: n.width,
                            height: n.height,
                        }}
                        data-node={n.nodeId}
                        onMouseEnter={onEnterNode}
                        onMouseLeave={onLeaveNode}
                        onClick={onClickNode}
                    >
                        <div className={styles.table_ports}>
                            {(n.ports & NodePort.North) != 0 && (
                                <Port
                                    node={n.nodeId}
                                    port={NodePort.North}
                                    focusedPorts={focusedPorts}
                                    className={styles.table_port_north}
                                />
                            )}
                            {(n.ports & NodePort.East) != 0 && (
                                <Port
                                    node={n.nodeId}
                                    port={NodePort.East}
                                    focusedPorts={focusedPorts}
                                    className={styles.table_port_east}
                                />
                            )}
                            {(n.ports & NodePort.South) != 0 && (
                                <Port
                                    node={n.nodeId}
                                    port={NodePort.South}
                                    focusedPorts={focusedPorts}
                                    className={styles.table_port_south}
                                />
                            )}
                            {(n.ports & NodePort.West) != 0 && (
                                <Port
                                    node={n.nodeId}
                                    port={NodePort.West}
                                    focusedPorts={focusedPorts}
                                    className={styles.table_port_west}
                                />
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
                );
            })}
        </div>
    );
}
