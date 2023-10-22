import * as React from 'react';
import { NodeLayer } from './node_layer';
import { EdgeHighlightingLayer, EdgeLayer } from './edge_layer';
import { GraphNodeDescriptor } from './graph_view_model';
import AutoSizer from 'react-virtualized-auto-sizer';
import { useAppStateDispatch, useAppState } from '../../state/app_state_provider';
import { FOCUS_GRAPH_EDGE, FOCUS_GRAPH_NODE, RESIZE_SCHEMA_GRAPH } from '../../state/app_state_reducer';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';

import styles from './schema_graph.module.css';

import icons from '../../../static/svg/icons.generated.svg';

interface SchemaGraphViewProps {}

const SchemaGraphView: React.FC<SchemaGraphViewProps> = (props: SchemaGraphViewProps) => {
    const state = useAppState();
    const dispatch = useAppStateDispatch();

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
        <div
            className={styles.graph_view}
            style={{
                width: state.graphViewModel.boundaries.totalWidth,
                height: state.graphViewModel.boundaries.totalHeight,
            }}
        >
            <EdgeLayer
                className={styles.graph_edges}
                bounds={state.graphViewModel.boundaries}
                edges={state.graphViewModel.edges}
                onFocusChanged={onEdgeFocusChanged}
            />
            <NodeLayer
                className={styles.graph_nodes}
                bounds={state.graphViewModel.boundaries}
                nodes={state.graphViewModel.nodes}
                edges={state.graphViewModel.edges}
                focus={state.focus}
                onFocusChanged={onNodeFocusChanged}
            />
            <EdgeHighlightingLayer
                className={styles.graph_edge_highlighting}
                bounds={state.graphViewModel.boundaries}
                edges={state.graphViewModel.edges}
                focus={state.focus}
            />
        </div>
    );
};

interface SchemaGraphBoardProps {
    width: number;
    height: number;
}

const SchemaGraphBoard: React.FC<SchemaGraphBoardProps> = (props: SchemaGraphBoardProps) => {
    const dispatch = useAppStateDispatch();

    // Recompute the schema graph if the graph dimension hints change
    React.useEffect(() => {
        dispatch({
            type: RESIZE_SCHEMA_GRAPH,
            value: [props.width, props.height],
        });
    }, [props.width, props.height]);

    return (
        <TransformWrapper
            initialScale={1}
            minScale={0.7}
            maxScale={1}
            centerZoomedOut={true}
            panning={{
                disabled: false,
            }}
            pinch={{
                disabled: false,
            }}
        >
            <TransformComponent>
                <div className={styles.graph_board} style={{ width: props.width, height: props.height }}>
                    <SchemaGraphView />
                </div>
            </TransformComponent>
        </TransformWrapper>
    );
};

interface GraphWithControlsProps {}
export const SchemaGraph: React.FC<GraphWithControlsProps> = (props: GraphWithControlsProps) => {
    return (
        <div className={styles.graph_container}>
            <div className={styles.graph_board_container}>
                <AutoSizer>
                    {(s: { height: number; width: number }) => <SchemaGraphBoard height={s.height} width={s.width} />}
                </AutoSizer>
            </div>
            <div className={styles.graph_title}>Schema</div>
            <div className={styles.graph_controls}>
                <div className={styles.graph_control_button}>
                    <svg width="12px" height="12px">
                        <use xlinkHref={`${icons}#graph_plus`} />
                    </svg>
                </div>
                <div className={styles.graph_control_button}>
                    <svg width="12px" height="12px">
                        <use xlinkHref={`${icons}#graph_minus`} />
                    </svg>
                </div>
                <div className={styles.graph_control_button}>
                    <svg width="12px" height="12px">
                        <use xlinkHref={`${icons}#graph_plus`} />
                    </svg>
                </div>
            </div>
        </div>
    );
};
