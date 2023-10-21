import * as React from 'react';
import { NodeLayer } from './node_layer';
import { EdgeHighlightingLayer, EdgeLayer } from './edge_layer';
import { GraphNodeDescriptor } from './graph_view_model';
import AutoSizer from 'react-virtualized-auto-sizer';
import { useAppStateDispatch, useAppState } from '../../state/app_state_provider';
import { useBoardControls } from './board_controls';
import { FOCUS_GRAPH_EDGE, FOCUS_GRAPH_NODE, RESIZE_SCHEMA_GRAPH } from '../../state/app_state_reducer';

import styles from './schema_graph.module.css';

import icon_graph_align from '../../../static/svg/icons/graph_align.svg';
import icon_graph_minus from '../../../static/svg/icons/graph_minus.svg';
import icon_graph_plus from '../../../static/svg/icons/graph_plus.svg';

interface BoardProps {
    width: number;
    height: number;
}

export const SchemaGraphBoard: React.FC<BoardProps> = (props: BoardProps) => {
    const state = useAppState();
    const dispatch = useAppStateDispatch();

    // Recompute the schema graph if the graph dimensions change
    React.useEffect(() => {
        dispatch({
            type: RESIZE_SCHEMA_GRAPH,
            value: [props.width, props.height],
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
        <>
            <EdgeLayer
                className={styles.graph_edges}
                boardWidth={props.width}
                boardHeight={props.height}
                edges={state.graphViewModel.edges}
                onFocusChanged={onEdgeFocusChanged}
            />
            <NodeLayer
                className={styles.graph_nodes}
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
        </>
    );
};

interface GraphWithControlsProps {}

export const SchemaGraph: React.FC<GraphWithControlsProps> = (props: GraphWithControlsProps) => {
    const [boardRef] = useBoardControls();

    return (
        <div className={styles.graph_container}>
            <div className={styles.graph_board_container}>
                <AutoSizer>
                    {(s: { height: number; width: number }) => (
                        <div ref={boardRef} className={styles.graph_board}>
                            <SchemaGraphBoard width={s.width} height={s.height} />
                        </div>
                    )}
                </AutoSizer>
            </div>
            <div className={styles.graph_title}>Schema</div>
            <div className={styles.graph_controls}>
                <div className={styles.graph_control_button}>
                    <svg width="12px" height="12px">
                        <use xlinkHref={`${icon_graph_plus}#sym`} />
                    </svg>
                </div>
                <div className={styles.graph_control_button}>
                    <svg width="12px" height="12px">
                        <use xlinkHref={`${icon_graph_minus}#sym`} />
                    </svg>
                </div>
                <div className={styles.graph_control_button}>
                    <svg width="12px" height="12px">
                        <use xlinkHref={`${icon_graph_align}#sym`} />
                    </svg>
                </div>
            </div>
        </div>
    );
};
