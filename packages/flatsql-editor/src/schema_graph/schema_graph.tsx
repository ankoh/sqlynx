import * as React from 'react';
import { NodeLayer } from './node_layer';
import { EdgeLayer } from './edge_layer';
import { DebugLayer } from './debug_layer';
import { BackgroundLayer } from './background_layer';
import { layoutDebugInfo, layoutSchemaGraph } from './graph_layout';
import { RESIZE_SCHEMA_GRAPH, useAppStateDispatch, useAppState } from '../app_state_reducer';
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

    React.useEffect(() => {
        dispatch({
            type: RESIZE_SCHEMA_GRAPH,
            value: [props.width, 0.45 * props.height],
        });
    }, [props.width, props.height]);

    // Render placeholder if context is not available
    if (!state) {
        <div className={props.className}>
            <BackgroundLayer />
        </div>;
    }

    const [nodes, edges] = layoutSchemaGraph(state);
    const debugInfo = layoutDebugInfo(state, nodes);
    return (
        <div className={cn(styles.graph_container, props.className)}>
            <BackgroundLayer className={styles.graph_background} />
            <EdgeLayer
                className={styles.graph_edges}
                boardWidth={props.width}
                boardHeight={props.height}
                nodes={nodes}
                edges={edges}
                nodeHeight={state.graphConfig.tableHeight}
                nodeWidth={state.graphConfig.tableWidth}
                gridSize={state.graphConfig.gridSize}
                cornerRadius={8}
            />
            <NodeLayer
                className={styles.graph_nodes}
                width={props.width}
                height={props.height}
                nodes={nodes}
                edges={edges}
            />
            {state.graphDebugMode && (
                <DebugLayer className={styles.graph_edges} width={props.width} height={props.height} info={debugInfo} />
            )}
        </div>
    );
};
