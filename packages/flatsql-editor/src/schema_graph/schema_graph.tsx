import * as React from 'react';
import { NodeLayer } from './node_layer';
import { EdgeHighlightingLayer, EdgeLayer } from './edge_layer';
import { DebugLayer } from './debug_layer';
import { BackgroundLayer } from './background_layer';
import {
    RESIZE_SCHEMA_GRAPH,
    useAppStateDispatch,
    useAppState,
    FOCUS_GRAPH_NODE,
    FOCUS_GRAPH_EDGE,
} from '../app_state_reducer';
import { GraphNodeDescriptor } from '../app_state';
import cn from 'classnames';

import styles from './schema_graph.module.css';

interface Props {
    className?: string;
    width: number;
    height: number;
}

export const SchemaGraph: React.FC<Props> = (props: Props) => {
    const state = useAppState();
    const dispatch = useAppStateDispatch();

    // Recompute the schema graph if the graph dimensions change
    React.useEffect(() => {
        dispatch({
            type: RESIZE_SCHEMA_GRAPH,
            value: [props.width, 0.45 * props.height],
        });
    }, [props.width, props.height]);

    // Helper to change node focus
    const onNodeFocusChanged = React.useCallback(
        (node: GraphNodeDescriptor | null) => {
            dispatch({
                type: FOCUS_GRAPH_NODE,
                value: node,
            });
        },
        [dispatch],
    );
    // Helper to change edge focus
    const onEdgeFocusChanged = React.useCallback(
        (connection: bigint | null) => {
            dispatch({
                type: FOCUS_GRAPH_EDGE,
                value: connection,
            });
        },
        [dispatch],
    );

    return (
        <div className={cn(styles.graph_container, props.className)}>
            <BackgroundLayer className={styles.graph_background} />
            <EdgeLayer
                className={styles.graph_edges}
                boardWidth={props.width}
                boardHeight={props.height}
                edges={state.graphViewModel.edges}
                onFocusChanged={onEdgeFocusChanged}
            />
            <NodeLayer
                className={styles.graph_nodes}
                width={props.width}
                height={props.height}
                nodes={state.graphViewModel.nodes}
                edges={state.graphViewModel.edges}
                focus={state.focus}
                onFocusChanged={onNodeFocusChanged}
            />
            <EdgeHighlightingLayer
                className={styles.graph_edge_highlighting}
                boardWidth={props.width}
                boardHeight={props.height}
                edges={state.graphViewModel.edges}
                focus={state.focus}
            />
            {state.graphViewModel.debugInfo && (
                <DebugLayer
                    className={styles.graph_debug_info}
                    width={props.width}
                    height={props.height}
                    info={state.graphViewModel.debugInfo}
                />
            )}
        </div>
    );
};
