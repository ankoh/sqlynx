import * as React from 'react';
import { NodeLayer } from './node_layer.js';
import { EdgeHighlightingLayer, EdgeLayer } from './edge_layer.js';
import { GraphNodeDescriptor } from './graph_view_model.js';
import { observeSize } from '../base/size_observer.js';
import { useCurrentSessionState } from '../../session/current_session.js';
import {
    FOCUS_QUERY_GRAPH_EDGE,
    FOCUS_QUERY_GRAPH_NODE,
    RESIZE_QUERY_GRAPH,
} from '../../session/session_state_reducer.js';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';

import * as styles from './schema_graph.module.css';

import * as icons from '../../../static/svg/symbols.generated.svg';

interface SchemaGraphViewProps { }

const SchemaGraphView: React.FC<SchemaGraphViewProps> = (_props: SchemaGraphViewProps) => {
    const [state, dispatch] = useCurrentSessionState();

    // Helper to change node focus
    const onNodeFocusChanged = React.useCallback(
        (node: GraphNodeDescriptor | null) => {
            dispatch({
                type: FOCUS_QUERY_GRAPH_NODE,
                value: node,
            });
        },
        [dispatch],
    );
    // Helper to change edge focus
    const onEdgeFocusChanged = React.useCallback(
        (connection: bigint | null) => {
            dispatch({
                type: FOCUS_QUERY_GRAPH_EDGE,
                value: connection,
            });
        },
        [dispatch],
    );
    if (!state) {
        return <div />;
    }
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
                focus={state.userFocus}
                onFocusChanged={onNodeFocusChanged}
            />
            <EdgeHighlightingLayer
                className={styles.graph_edge_highlighting}
                bounds={state.graphViewModel.boundaries}
                edges={state.graphViewModel.edges}
                focus={state.userFocus}
            />
        </div>
    );
};

interface SchemaGraphBoardProps {
    width: number;
    height: number;
}

const SchemaGraphBoard: React.FC<SchemaGraphBoardProps> = (props: SchemaGraphBoardProps) => {
    const [_state, dispatch] = useCurrentSessionState();

    // Recompute the schema graph if the graph dimension hints change
    React.useEffect(() => {
        dispatch({
            type: RESIZE_QUERY_GRAPH,
            value: [props.width, props.height],
        });
    }, [props.width, props.height]);

    return (
        <TransformWrapper
            initialScale={1}
            minScale={0.6}
            maxScale={1}
            centerZoomedOut={true}
            panning={{
                disabled: false,
            }}
            pinch={{
                disabled: false,
            }}
        >
            {({ zoomIn, zoomOut, resetTransform, ...rest }: any) => (
                <>
                    <TransformComponent>
                        <div className={styles.graph_board} style={{ width: props.width, height: props.height }}>
                            <SchemaGraphView />
                        </div>
                    </TransformComponent>
                    <div className={styles.graph_controls}>
                        <div className={styles.graph_control_button} onClick={() => zoomIn()}>
                            <svg width="12px" height="12px">
                                <use xlinkHref={`${icons}#graph_plus`} />
                            </svg>
                        </div>
                        <div className={styles.graph_control_button} onClick={() => zoomOut()}>
                            <svg width="12px" height="12px">
                                <use xlinkHref={`${icons}#graph_minus`} />
                            </svg>
                        </div>
                        <div className={styles.graph_control_button} onClick={() => resetTransform()}>
                            <svg width="12px" height="12px">
                                <use xlinkHref={`${icons}#graph_align`} />
                            </svg>
                        </div>
                    </div>
                </>
            )}
        </TransformWrapper>
    );
};

interface GraphWithControlsProps { }
export const SchemaGraph: React.FC<GraphWithControlsProps> = (props: GraphWithControlsProps) => {
    const containerElement = React.useRef(null);
    const containerSize = observeSize(containerElement);
    return (
        <div className={styles.graph_container}>
            <div className={styles.graph_board_container} ref={containerElement}>
                <SchemaGraphBoard height={containerSize?.height ?? 100} width={containerSize?.width ?? 200} />
            </div>
            <div className={styles.graph_title}>Schema</div>
        </div>
    );
};
